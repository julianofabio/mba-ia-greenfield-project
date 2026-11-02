import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { videoThumbnailKey } from '../videos/video-storage-keys';
import { thumbnailTimestamp } from './ffprobe-output.parser';
import { MediaProbeService } from './media-probe.service';

const FAILURE_REASON_MAX_LENGTH = 500;
const NON_TERMINAL_STATUSES = [VideoStatus.DRAFT, VideoStatus.PROCESSING];

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly mediaProbe: MediaProbeService,
  ) {}

  /**
   * Extracts duration/metadata, stores the thumbnail and marks the video
   * `ready`. Idempotent: unknown, `ready` and `failed` videos are skipped, so
   * duplicate or late jobs are harmless (TD-10).
   */
  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video || !NON_TERMINAL_STATUSES.includes(video.status)) {
      this.logger.log(
        `Skipping video ${videoId} (${video?.status ?? 'missing'})`,
      );
      return;
    }
    // The job can arrive before the API commits `processing` (TD-10).
    if (video.status === VideoStatus.DRAFT) {
      await this.videoRepository.update(
        { id: videoId, status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING },
      );
    }

    const source = await this.storage.presignGetObject(video.storage_key, {
      audience: 'internal',
    });
    const metadata = await this.mediaProbe.probe(source);
    const frame = await this.mediaProbe.extractFrame(
      source,
      thumbnailTimestamp(metadata.durationSeconds),
    );
    const thumbnailKey = videoThumbnailKey(video.id);
    await this.storage.putObject(thumbnailKey, frame, 'image/jpeg');
    const stored = await this.storage.headObject(video.storage_key);

    await this.videoRepository.update(
      { id: videoId, status: In(NON_TERMINAL_STATUSES) },
      {
        status: VideoStatus.READY,
        duration_seconds:
          metadata.durationSeconds === null
            ? null
            : Math.round(metadata.durationSeconds * 1000) / 1000,
        width: metadata.width,
        height: metadata.height,
        video_codec: metadata.videoCodec,
        audio_codec: metadata.audioCodec,
        container_format: metadata.containerFormat,
        bitrate: metadata.bitrate,
        thumbnail_key: thumbnailKey,
        size_bytes: stored?.sizeBytes ?? video.size_bytes,
        failure_reason: null,
      },
    );
  }

  /** Terminal failure after the last attempt; only non-terminal videos change. */
  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: In(NON_TERMINAL_STATUSES) },
      {
        status: VideoStatus.FAILED,
        failure_reason:
          reason.trim().slice(0, FAILURE_REASON_MAX_LENGTH) ||
          'Video processing failed',
      },
    );
  }
}
