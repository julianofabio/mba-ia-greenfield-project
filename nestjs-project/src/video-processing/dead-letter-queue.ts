import type { ConfigType } from '@nestjs/config';
import { connect } from 'amqplib';
import type messagingConfig from '../config/messaging.config';
import { deadLetterQueueName } from './video-processing.queue';

/**
 * Declares the DLQ the processing queue dead-letters into. RabbitMQ silently
 * drops dead-lettered messages whose target queue does not exist, so it must
 * exist before the consumer starts.
 */
export async function ensureDeadLetterQueue(
  config: ConfigType<typeof messagingConfig>,
): Promise<string> {
  const queue = deadLetterQueueName(config.videoProcessingQueue);
  const connection = await connect(config.rabbitmqUrl);
  try {
    const channel = await connection.createChannel();
    await channel.assertQueue(queue, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });
    await channel.close();
  } finally {
    await connection.close();
  }
  return queue;
}
