import type { ConfigType } from '@nestjs/config';
import { Transport, type RmqOptions } from '@nestjs/microservices';
import type messagingConfig from '../config/messaging.config';

/** Event published when an upload is completed and the video awaits processing. */
export const VIDEO_UPLOADED_PATTERN = 'video.uploaded';

export interface VideoUploadedEvent {
  videoId: string;
}

/** Processing attempts before the worker marks a video as `failed`. */
export const MAX_PROCESSING_ATTEMPTS = 3;

/** Broker-side safety net: redeliveries before a message goes to the DLQ. */
const QUEUE_DELIVERY_LIMIT = 5;

export function deadLetterQueueName(queue: string): string {
  return `${queue}.dlq`;
}

/**
 * Producer (API) options. Shares the queue contract with the consumer — both
 * sides assert the queue with these exact arguments, and RabbitMQ rejects a
 * redeclaration with different ones. Nest's RMQ default is persistent=false;
 * jobs must survive broker restarts.
 */
export function buildVideoProcessingClientOptions(
  config: ConfigType<typeof messagingConfig>,
): RmqOptions {
  return {
    transport: Transport.RMQ,
    options: { ...buildQueueContract(config), persistent: true },
  };
}

/**
 * Consumer (worker) options: manual acknowledgement (Nest's default is
 * noAck=true) and one job at a time per worker process. Kept off the producer
 * on purpose — the client's reply consumer on `amq.rabbitmq.reply-to` must
 * run with noAck=true or the broker closes the channel (406).
 */
export function buildVideoProcessingServerOptions(
  config: ConfigType<typeof messagingConfig>,
): RmqOptions {
  return {
    transport: Transport.RMQ,
    options: { ...buildQueueContract(config), noAck: false, prefetchCount: 1 },
  };
}

function buildQueueContract(config: ConfigType<typeof messagingConfig>) {
  const queue = config.videoProcessingQueue;
  return {
    urls: [config.rabbitmqUrl],
    queue,
    queueOptions: {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': QUEUE_DELIVERY_LIMIT,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': deadLetterQueueName(queue),
      },
    },
  };
}
