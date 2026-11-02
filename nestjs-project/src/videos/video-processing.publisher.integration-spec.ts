import { randomUUID } from 'node:crypto';
import * as amqp from 'amqplib';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';
import { Test, type TestingModule } from '@nestjs/testing';
import { ProcessingQueueUnavailableException } from '../common/exceptions/domain.exception';
import messagingConfig from '../config/messaging.config';
import { buildVideoProcessingClientOptions } from '../video-processing/video-processing.queue';
import { VideoProcessingPublisher } from './video-processing.publisher';
import { VIDEO_PROCESSING_CLIENT } from './videos.constants';

const QUEUE = process.env.VIDEO_PROCESSING_QUEUE!;

async function buildPublisherModule(
  rabbitmqUrl?: string,
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [messagingConfig] }),
      ClientsModule.registerAsync([
        {
          name: VIDEO_PROCESSING_CLIENT,
          inject: [messagingConfig.KEY],
          useFactory: (config: ConfigType<typeof messagingConfig>) =>
            buildVideoProcessingClientOptions({
              ...config,
              rabbitmqUrl: rabbitmqUrl ?? config.rabbitmqUrl,
            }),
        },
      ]),
    ],
    providers: [VideoProcessingPublisher],
  }).compile();
}

/** Reads queue metadata (type, arguments) from the RabbitMQ management API. */
async function getQueueInfo(queue: string): Promise<{
  type: string;
  arguments: Record<string, unknown>;
}> {
  const url = new URL(process.env.RABBITMQ_URL!);
  const auth = Buffer.from(
    `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
  ).toString('base64');
  const res = await fetch(
    `http://${url.hostname}:15672/api/queues/%2F/${encodeURIComponent(queue)}`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  return (await res.json()) as {
    type: string;
    arguments: Record<string, unknown>;
  };
}

describe('VideoProcessingPublisher (integration — RabbitMQ)', () => {
  let connection: amqp.ChannelModel;
  let channel: amqp.Channel;

  beforeAll(async () => {
    connection = await amqp.connect(process.env.RABBITMQ_URL!);
    channel = await connection.createChannel();
    // Same arguments as producer/consumer, so purging never hits a missing queue.
    const { options } = buildVideoProcessingClientOptions({
      rabbitmqUrl: process.env.RABBITMQ_URL!,
      videoProcessingQueue: QUEUE,
    });
    await channel.assertQueue(QUEUE, options?.queueOptions);
  });

  afterAll(async () => {
    await channel.close();
    await connection.close();
  });

  describe('with the broker reachable', () => {
    let moduleRef: TestingModule;
    let publisher: VideoProcessingPublisher;

    beforeAll(async () => {
      moduleRef = await buildPublisherModule();
      publisher = moduleRef.get(VideoProcessingPublisher);
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    beforeEach(async () => {
      await channel.purgeQueue(QUEUE);
    });

    it('should leave a persistent video.uploaded message in the queue', async () => {
      const videoId = randomUUID();

      await publisher.publishVideoUploaded(videoId);

      const message = await channel.get(QUEUE, { noAck: true });
      expect(message).not.toBe(false);
      if (message === false) return;
      expect(JSON.parse(message.content.toString())).toEqual({
        pattern: 'video.uploaded',
        data: { videoId },
      });
      expect(message.properties.deliveryMode).toBe(2);
    });

    it('should declare a quorum queue with delivery limit and dead-letter routing', async () => {
      await publisher.publishVideoUploaded(randomUUID());

      const info = await getQueueInfo(QUEUE);

      expect(info.type).toBe('quorum');
      expect(info.arguments).toMatchObject({
        'x-queue-type': 'quorum',
        'x-delivery-limit': 5,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': `${QUEUE}.dlq`,
      });
    });
  });

  describe('with the broker unreachable', () => {
    it('should fail fast with PROCESSING_QUEUE_UNAVAILABLE', async () => {
      const moduleRef = await buildPublisherModule(
        'amqp://streamtube:streamtube@unreachable-broker:5672',
      );
      const publisher = moduleRef.get(VideoProcessingPublisher);
      const startedAt = Date.now();

      await expect(
        publisher.publishVideoUploaded(randomUUID()),
      ).rejects.toBeInstanceOf(ProcessingQueueUnavailableException);
      expect(Date.now() - startedAt).toBeLessThan(15_000);

      await moduleRef.close();
    });
  });
});
