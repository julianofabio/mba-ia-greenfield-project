import { randomUUID } from 'node:crypto';
import * as amqp from 'amqplib';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotDraftException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import messagingConfig from '../config/messaging.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { buildVideoProcessingClientOptions } from '../video-processing/video-processing.queue';
import { Video, VideoStatus } from './entities/video.entity';
import { PART_SIZE_BYTES } from './upload-plan';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const QUEUE = process.env.VIDEO_PROCESSING_QUEUE!;
const TWO_PARTS_SIZE = PART_SIZE_BYTES + 1024;

describe('VideosService (integration — PostgreSQL + MinIO + RabbitMQ)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let dataSource: DataSource;
  let amqpConnection: amqp.ChannelModel;
  let amqpChannel: amqp.Channel;
  let ownerId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, messagingConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource([User, Channel, Video], { synchronize: false })
            .options,
        ),
        VideosModule,
      ],
    }).compile();
    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);

    amqpConnection = await amqp.connect(process.env.RABBITMQ_URL!);
    amqpChannel = await amqpConnection.createChannel();
    const { options } = buildVideoProcessingClientOptions({
      rabbitmqUrl: process.env.RABBITMQ_URL!,
      videoProcessingQueue: QUEUE,
    });
    await amqpChannel.assertQueue(QUEUE, options?.queueOptions);
  });

  afterAll(async () => {
    await amqpChannel.close();
    await amqpConnection.close();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await amqpChannel.purgeQueue(QUEUE);
    ownerId = await createUserWithChannel();
  });

  async function createUserWithChannel(): Promise<string> {
    const user = await dataSource.getRepository(User).save({
      email: `uploader_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    await dataSource.getRepository(Channel).save({
      name: 'uploader',
      nickname: `up_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
    return user.id;
  }

  async function initiateTwoParts(): Promise<Video> {
    const { video } = await service.initiateUpload(ownerId, {
      file_name: 'aula.mp4',
      file_size: TWO_PARTS_SIZE,
      content_type: 'video/mp4',
    });
    return video;
  }

  async function uploadPart(
    video: Video,
    partNumber: number,
    sizeBytes: number,
  ): Promise<void> {
    const [{ url }] = await service.presignUploadParts(ownerId, video.id, [
      partNumber,
    ]);
    const res = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(sizeBytes, partNumber)),
    });
    expect(res.status).toBe(200);
  }

  it('should pre-register a draft with an open multipart upload', async () => {
    const plan = await service.initiateUpload(ownerId, {
      file_name: 'aula.mp4',
      file_size: 150 * 1024 * 1024,
      content_type: 'video/mp4',
    });

    const persisted = await videoRepository.findOneByOrFail({
      id: plan.video.id,
    });
    expect(plan.partCount).toBe(3);
    expect(persisted.status).toBe(VideoStatus.DRAFT);
    expect(persisted.storage_key).toBe(`videos/${persisted.id}/original`);
    expect(persisted.upload_id).toEqual(expect.any(String));
    await expect(
      storage.listParts(persisted.storage_key, persisted.upload_id!),
    ).resolves.toEqual([]);
  });

  it('should default the title to the file name without its extension', async () => {
    const { video } = await service.initiateUpload(ownerId, {
      file_name: 'meu-video.final.mp4',
      file_size: 1024,
      content_type: 'video/mp4',
    });

    expect(video.title).toBe('meu-video.final');
  });

  it('should complete the upload, publish the job and move to processing', async () => {
    const video = await initiateTwoParts();
    await uploadPart(video, 1, PART_SIZE_BYTES);
    await uploadPart(video, 2, 1024);

    const completed = await service.completeUpload(ownerId, video.id);

    expect(completed).toMatchObject({
      status: VideoStatus.PROCESSING,
      upload_id: null,
      size_bytes: TWO_PARTS_SIZE,
    });
    expect((await storage.headObject(video.storage_key))?.sizeBytes).toBe(
      TWO_PARTS_SIZE,
    );
    const message = await amqpChannel.get(QUEUE, { noAck: true });
    expect(message).not.toBe(false);
    if (message === false) return;
    expect(JSON.parse(message.content.toString())).toEqual({
      pattern: 'video.uploaded',
      data: { videoId: video.id },
    });
  });

  it('should keep the draft and fail with UPLOAD_INCOMPLETE when parts are missing', async () => {
    const video = await initiateTwoParts();
    await uploadPart(video, 1, PART_SIZE_BYTES);

    await expect(service.completeUpload(ownerId, video.id)).rejects.toThrow(
      UploadIncompleteException,
    );
    expect(
      (await videoRepository.findOneByOrFail({ id: video.id })).status,
    ).toBe(VideoStatus.DRAFT);
  });

  it('should fail with UPLOAD_SIZE_MISMATCH when the parts differ from the declared size', async () => {
    const video = await initiateTwoParts();
    await uploadPart(video, 1, PART_SIZE_BYTES);
    await uploadPart(video, 2, 2048);

    await expect(service.completeUpload(ownerId, video.id)).rejects.toThrow(
      UploadSizeMismatchException,
    );
  });

  it('should not publish a second job when completion is repeated', async () => {
    const video = await initiateTwoParts();
    await uploadPart(video, 1, PART_SIZE_BYTES);
    await uploadPart(video, 2, 1024);
    await service.completeUpload(ownerId, video.id);

    const again = await service.completeUpload(ownerId, video.id);

    expect(again.status).toBe(VideoStatus.PROCESSING);
    const { messageCount } = await amqpChannel.checkQueue(QUEUE);
    expect(messageCount).toBe(1);
  });

  it('should hide the video from another channel with VIDEO_NOT_FOUND', async () => {
    const video = await initiateTwoParts();
    const otherUserId = await createUserWithChannel();

    await expect(service.getUploadState(otherUserId, video.id)).rejects.toThrow(
      VideoNotFoundException,
    );
    await expect(service.cancelUpload(otherUserId, video.id)).rejects.toThrow(
      VideoNotFoundException,
    );
  });

  it('should cancel a draft by aborting the upload and deleting the record', async () => {
    const video = await initiateTwoParts();

    await service.cancelUpload(ownerId, video.id);

    expect(await videoRepository.findOneBy({ id: video.id })).toBeNull();
    await expect(
      storage.listParts(video.storage_key, video.upload_id!),
    ).rejects.toMatchObject({ name: 'NoSuchUpload' });
  });

  it('should refuse to cancel a video that is already processing', async () => {
    const video = await initiateTwoParts();
    await uploadPart(video, 1, PART_SIZE_BYTES);
    await uploadPart(video, 2, 1024);
    await service.completeUpload(ownerId, video.id);

    await expect(service.cancelUpload(ownerId, video.id)).rejects.toThrow(
      VideoNotDraftException,
    );
  });
});
