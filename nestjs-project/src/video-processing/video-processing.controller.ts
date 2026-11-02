import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import type { Channel, ConsumeMessage } from 'amqplib';
import { attemptFromDeliveryCount, shouldRetry } from './processing-attempts';
import {
  VIDEO_UPLOADED_PATTERN,
  type VideoUploadedEvent,
} from './video-processing.queue';
import { VideoProcessingService } from './video-processing.service';

/**
 * RabbitMQ consumer of the worker (manual ack). Every path acks or nacks
 * exactly once: success → ack; failure before the last attempt → requeue;
 * failure on the last attempt → mark `failed` + ack; malformed payload →
 * reject without requeue (dead-lettered to the DLQ).
 */
@Controller()
export class VideoProcessingController {
  private readonly logger = new Logger(VideoProcessingController.name);

  constructor(private readonly processing: VideoProcessingService) {}

  @EventPattern(VIDEO_UPLOADED_PATTERN)
  async handleVideoUploaded(
    @Payload() event: VideoUploadedEvent,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const channel = context.getChannelRef() as Channel;
    const message = context.getMessage() as ConsumeMessage;

    if (typeof event?.videoId !== 'string' || event.videoId.length === 0) {
      this.logger.error(
        `Malformed ${VIDEO_UPLOADED_PATTERN} payload — dead-lettering`,
      );
      channel.nack(message, false, false);
      return;
    }

    const attempt = attemptFromDeliveryCount(
      message.properties.headers?.['x-delivery-count'],
    );
    try {
      await this.processing.process(event.videoId);
      channel.ack(message);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (shouldRetry(attempt)) {
        this.logger.warn(
          `Video ${event.videoId} attempt ${attempt} failed, requeueing: ${reason}`,
        );
        channel.nack(message, false, true);
        return;
      }
      await this.failVideo(event.videoId, reason, channel, message);
    }
  }

  private async failVideo(
    videoId: string,
    reason: string,
    channel: Channel,
    message: ConsumeMessage,
  ): Promise<void> {
    try {
      await this.processing.markFailed(videoId, reason);
      this.logger.error(
        `Video ${videoId} failed after its last attempt: ${reason}`,
      );
      channel.ack(message);
    } catch (err) {
      // Could not persist the failure (e.g. database down): let the broker
      // redeliver; the queue's delivery limit dead-letters it eventually.
      this.logger.error(
        `Could not mark video ${videoId} as failed: ${String(err)}`,
      );
      channel.nack(message, false, true);
    }
  }
}
