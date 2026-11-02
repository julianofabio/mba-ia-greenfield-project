import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { MicroserviceOptions } from '@nestjs/microservices';
import messagingConfig from './config/messaging.config';
import { ensureDeadLetterQueue } from './video-processing/dead-letter-queue';
import { buildVideoProcessingServerOptions } from './video-processing/video-processing.queue';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const config = messagingConfig();
  const deadLetterQueue = await ensureDeadLetterQueue(config);

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    WorkerModule,
    buildVideoProcessingServerOptions(config),
  );
  app.enableShutdownHooks();
  await app.listen();

  new Logger('VideoWorker').log(
    `Consuming "${config.videoProcessingQueue}" (DLQ "${deadLetterQueue}")`,
  );
}
void bootstrap();
