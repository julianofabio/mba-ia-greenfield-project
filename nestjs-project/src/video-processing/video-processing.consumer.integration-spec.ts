import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as amqp from 'amqplib';
import { NestFactory } from '@nestjs/core';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import type { INestMicroservice } from '@nestjs/common';
import { ClientsModule, type MicroserviceOptions } from '@nestjs/microservices';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import messagingConfig from '../config/messaging.config';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  createTestFiles,
  generateTestVideo,
  generateTextFile,
  type TestFiles,
} from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import { VideoProcessingPublisher } from '../videos/video-processing.publisher';
import { videoOriginalKey } from '../videos/video-storage-keys';
import { VIDEO_PROCESSING_CLIENT } from '../videos/videos.constants';
import { WorkerModule } from '../worker.module';
import { ensureDeadLetterQueue } from './dead-letter-queue';
import {
  buildVideoProcessingClientOptions,
  buildVideoProcessingServerOptions,
  deadLetterQueueName,
} from './video-processing.queue';
import { VideoProcessingService } from './video-processing.service';

const QUEUE = process.env.VIDEO_PROCESSING_QUEUE!;
const DLQ = deadLetterQueueName(QUEUE);

async function waitForStatus(
  repository: Repository<Video>,
  id: string,
  statuses: VideoStatus[],
  timeoutMs = 60_000,
): Promise<Video> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const video = await repository.findOneByOrFail({ id });
    if (statuses.includes(video.status)) return video;
    if (Date.now() > deadline) {
      throw new Error(
        `Video ${id} still ${video.status} after ${timeoutMs} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('Video worker consumer (integration — RabbitMQ + PostgreSQL + MinIO + FFmpeg)', () => {
  let worker: INestMicroservice;
  let publisherModule: TestingModule;
  let publisher: VideoProcessingPublisher;
  let dataSource: DataSource;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let amqpConnection: amqp.ChannelModel;
  let amqpChannel: amqp.Channel;
  let files: TestFiles;
  let channelId: string;

  beforeAll(async () => {
    const config = messagingConfig();
    amqpConnection = await amqp.connect(config.rabbitmqUrl);
    amqpChannel = await amqpConnection.createChannel();
    await amqpChannel.assertQueue(
      QUEUE,
      buildVideoProcessingClientOptions(config).options?.queueOptions,
    );
    await amqpChannel.purgeQueue(QUEUE);
    await ensureDeadLetterQueue(config);
    await amqpChannel.purgeQueue(DLQ);

    worker = await NestFactory.createMicroservice<MicroserviceOptions>(
      WorkerModule,
      {
        ...buildVideoProcessingServerOptions(config),
        logger: ['error'],
        abortOnError: false,
      },
    );
    await worker.listen();
    dataSource = worker.get(DataSource);
    storage = worker.get(StorageService);
    videoRepository = dataSource.getRepository(Video);

    publisherModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [messagingConfig] }),
        ClientsModule.registerAsync([
          {
            name: VIDEO_PROCESSING_CLIENT,
            inject: [messagingConfig.KEY],
            useFactory: (c: ConfigType<typeof messagingConfig>) =>
              buildVideoProcessingClientOptions(c),
          },
        ]),
      ],
      providers: [VideoProcessingPublisher],
    }).compile();
    publisher = publisherModule.get(VideoProcessingPublisher);
    files = await createTestFiles();
  });

  afterAll(async () => {
    await publisherModule.close();
    await worker.close();
    await amqpChannel.close();
    await amqpConnection.close();
    await files.cleanup();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `consumer_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    channelId = (
      await dataSource.getRepository(Channel).save({
        name: 'consumer',
        nickname: `cs_${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      })
    ).id;
  });

  async function storedVideo(sourcePath: string): Promise<Video> {
    const id = randomUUID();
    const content = await readFile(sourcePath);
    await storage.putObject(videoOriginalKey(id), content, 'video/mp4');
    return videoRepository.save({
      id,
      public_id: generatePublicId(),
      channel_id: channelId,
      title: 'aula',
      status: VideoStatus.PROCESSING,
      original_file_name: 'aula.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: content.length,
      storage_key: videoOriginalKey(id),
    });
  }

  it('should take a published job and bring the video to ready', async () => {
    const video = await storedVideo(
      await generateTestVideo(files, 'ok.mp4', { durationSeconds: 2 }),
    );

    await publisher.publishVideoUploaded(video.id);

    const ready = await waitForStatus(videoRepository, video.id, [
      VideoStatus.READY,
      VideoStatus.FAILED,
    ]);
    expect(ready.status).toBe(VideoStatus.READY);
    expect(ready.thumbnail_key).toEqual(expect.any(String));
  });

  it('should retry a failing job 3 times, then mark the video failed and drain the queue', async () => {
    const processSpy = jest.spyOn(
      worker.get(VideoProcessingService),
      'process',
    );
    const video = await storedVideo(
      await generateTextFile(files, 'not-a-video.mp4'),
    );

    await publisher.publishVideoUploaded(video.id);

    const failed = await waitForStatus(videoRepository, video.id, [
      VideoStatus.READY,
      VideoStatus.FAILED,
    ]);
    expect(failed.status).toBe(VideoStatus.FAILED);
    expect(failed.failure_reason).toMatch(/ffprobe/);
    expect(processSpy).toHaveBeenCalledTimes(3);
    const { messageCount } = await amqpChannel.checkQueue(QUEUE);
    expect(messageCount).toBe(0);
  });

  it('should dead-letter a malformed message instead of retrying it', async () => {
    amqpChannel.sendToQueue(
      QUEUE,
      Buffer.from(JSON.stringify({ pattern: 'video.uploaded', data: {} })),
      { persistent: true },
    );

    const deadline = Date.now() + 30_000;
    let dlqCount = 0;
    while (Date.now() < deadline) {
      dlqCount = (await amqpChannel.checkQueue(DLQ)).messageCount;
      if (dlqCount > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(dlqCount).toBe(1);
  });
});
