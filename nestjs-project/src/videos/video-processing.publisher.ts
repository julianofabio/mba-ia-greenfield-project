import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';
import { ProcessingQueueUnavailableException } from '../common/exceptions/domain.exception';
import {
  VIDEO_UPLOADED_PATTERN,
  type VideoUploadedEvent,
} from '../video-processing/video-processing.queue';
import {
  PUBLISH_CONFIRM_TIMEOUT_MS,
  VIDEO_PROCESSING_CLIENT,
} from './videos.constants';

@Injectable()
export class VideoProcessingPublisher {
  private readonly logger = new Logger(VideoProcessingPublisher.name);

  constructor(
    @Inject(VIDEO_PROCESSING_CLIENT) private readonly client: ClientProxy,
  ) {}

  /**
   * Resolves only after the broker confirmed the (persistent) message. While
   * the broker is unreachable the connection manager buffers the publish
   * forever, so the wait is bounded and surfaces as a retryable 503.
   */
  async publishVideoUploaded(videoId: string): Promise<void> {
    const event: VideoUploadedEvent = { videoId };
    try {
      await lastValueFrom(
        this.client
          .emit(VIDEO_UPLOADED_PATTERN, event)
          .pipe(timeout(PUBLISH_CONFIRM_TIMEOUT_MS)),
        { defaultValue: undefined },
      );
    } catch (err) {
      this.logger.warn(
        `Could not publish ${VIDEO_UPLOADED_PATTERN} for video ${videoId}: ${String(err)}`,
      );
      throw new ProcessingQueueUnavailableException();
    }
  }
}
