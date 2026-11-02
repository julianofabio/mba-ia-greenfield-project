import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotDraftException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { isNoSuchUploadError } from '../storage/storage.errors';
import { StorageService, type StoredPart } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId, isValidPublicId } from './public-id.util';
import {
  computePartCount,
  defaultTitleFromFileName,
  PART_SIZE_BYTES,
} from './upload-plan';
import { VideoProcessingPublisher } from './video-processing.publisher';
import { videoOriginalKey } from './video-storage-keys';

const PUBLIC_ID_COLUMN = 'public_id';
const MAX_PUBLIC_ID_ATTEMPTS = 5;

export interface InitiateUploadInput {
  file_name: string;
  file_size: number;
  content_type: string;
  title?: string;
}

export interface UploadPlan {
  video: Video;
  partSize: number;
  partCount: number;
}

export interface UploadState {
  partSize: number;
  partCount: number;
  uploadedParts: { partNumber: number; sizeBytes: number }[];
}

export type PlaybackMode = 'stream' | 'download';

export interface PartUploadUrl {
  partNumber: number;
  url: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    private readonly publisher: VideoProcessingPublisher,
  ) {}

  /** Pre-registers the video as a draft and opens its multipart upload. */
  async initiateUpload(
    userId: string,
    input: InitiateUploadInput,
  ): Promise<UploadPlan> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();

    const video = await this.insertDraft(channel.id, input);
    let uploadId: string;
    try {
      uploadId = await this.storage.createMultipartUpload(
        video.storage_key,
        video.content_type,
      );
    } catch (err) {
      // Compensate: a draft without a multipart upload can never be completed.
      await this.videoRepository.delete({ id: video.id });
      throw err;
    }
    await this.videoRepository.update(
      { id: video.id },
      { upload_id: uploadId },
    );
    video.upload_id = uploadId;

    return {
      video,
      partSize: PART_SIZE_BYTES,
      partCount: computePartCount(video.declared_size_bytes),
    };
  }

  /** Parts already stored — lets the client resume after a connection failure. */
  async getUploadState(userId: string, videoId: string): Promise<UploadState> {
    const video = await this.findOwnedDraft(userId, videoId);
    const parts = await this.storage.listParts(
      video.storage_key,
      video.upload_id!,
    );
    return {
      partSize: PART_SIZE_BYTES,
      partCount: computePartCount(video.declared_size_bytes),
      uploadedParts: parts.map(({ partNumber, sizeBytes }) => ({
        partNumber,
        sizeBytes,
      })),
    };
  }

  async presignUploadParts(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<PartUploadUrl[]> {
    const video = await this.findOwnedDraft(userId, videoId);
    const partCount = computePartCount(video.declared_size_bytes);
    if (partNumbers.some((n) => n < 1 || n > partCount)) {
      throw new InvalidPartNumberException(partCount);
    }
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storage.presignUploadPart(
          video.storage_key,
          video.upload_id!,
          partNumber,
        ),
      })),
    );
  }

  /**
   * Assembles the stored parts, publishes the processing job and moves the
   * video to `processing`. Idempotent: a video past `draft` is returned as is,
   * and a retry after a failed publish finds the object already assembled.
   */
  async completeUpload(userId: string, videoId: string): Promise<Video> {
    const video = await this.findOwnedVideo(userId, videoId);
    if (video.status !== VideoStatus.DRAFT) return video;

    const sizeBytes = await this.assembleUploadedObject(video);

    // Publish before touching the row (TD-10): if the broker does not confirm,
    // the video stays a `draft` with its upload_id and completion can be retried.
    await this.publisher.publishVideoUploaded(video.id);
    // The worker may already have taken the job and moved the status on.
    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING },
    );
    await this.videoRepository.update(
      { id: video.id },
      { upload_id: null, size_bytes: sizeBytes },
    );

    return this.videoRepository.findOneByOrFail({ id: video.id });
  }

  /** Cancels a draft: aborts the multipart upload and removes the record. */
  async cancelUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedDraft(userId, videoId);
    try {
      await this.storage.abortMultipartUpload(
        video.storage_key,
        video.upload_id!,
      );
    } catch (err) {
      // Already completed by an earlier completion attempt whose publish failed.
      if (!isNoSuchUploadError(err)) throw err;
    }
    await this.storage.deleteObject(video.storage_key);
    await this.videoRepository.delete({ id: video.id });
  }

  /** The owner's view of a video, at any status. */
  async getOwnedVideo(userId: string, videoId: string): Promise<Video> {
    return this.findOwnedVideo(userId, videoId);
  }

  /**
   * Short-lived storage URL behind the unique public URL. Only `ready` videos
   * are served; malformed, unknown and unfinished ids all look the same.
   */
  async resolvePlaybackUrl(
    publicId: string,
    mode: PlaybackMode,
  ): Promise<string> {
    if (!isValidPublicId(publicId)) throw new VideoNotFoundException();
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, status: VideoStatus.READY },
    });
    if (!video) throw new VideoNotFoundException();

    return this.storage.presignGetObject(video.storage_key, {
      audience: 'public',
      downloadFileName:
        mode === 'download' ? video.original_file_name : undefined,
    });
  }

  private async insertDraft(
    channelId: string,
    input: InitiateUploadInput,
  ): Promise<Video> {
    const id = randomUUID();
    for (let attempt = 1; ; attempt++) {
      const video = this.videoRepository.create({
        id,
        public_id: generatePublicId(),
        channel_id: channelId,
        title: input.title ?? defaultTitleFromFileName(input.file_name),
        status: VideoStatus.DRAFT,
        original_file_name: input.file_name,
        content_type: input.content_type,
        declared_size_bytes: input.file_size,
        storage_key: videoOriginalKey(id),
      });
      try {
        return await this.videoRepository.save(video);
      } catch (err) {
        const retryable =
          isPgUniqueViolationOnColumn(err, PUBLIC_ID_COLUMN) &&
          attempt < MAX_PUBLIC_ID_ATTEMPTS;
        if (!retryable) throw err;
      }
    }
  }

  /** Returns the size of the assembled object, completing the upload if needed. */
  private async assembleUploadedObject(video: Video): Promise<number> {
    let parts: StoredPart[];
    try {
      parts = await this.storage.listParts(video.storage_key, video.upload_id!);
    } catch (err) {
      if (!isNoSuchUploadError(err)) throw err;
      const head = await this.storage.headObject(video.storage_key);
      if (!head) throw err;
      if (head.sizeBytes !== video.declared_size_bytes) {
        throw new UploadSizeMismatchException();
      }
      return head.sizeBytes;
    }

    const partCount = computePartCount(video.declared_size_bytes);
    const stored = new Set(parts.map((p) => p.partNumber));
    const missing: number[] = [];
    for (let n = 1; n <= partCount; n++) {
      if (!stored.has(n)) missing.push(n);
    }
    if (missing.length > 0) throw new UploadIncompleteException(missing);

    const uploaded = parts.filter((p) => p.partNumber <= partCount);
    const total = uploaded.reduce((sum, p) => sum + p.sizeBytes, 0);
    if (total !== video.declared_size_bytes) {
      throw new UploadSizeMismatchException();
    }

    await this.storage.completeMultipartUpload(
      video.storage_key,
      video.upload_id!,
      uploaded,
    );
    return total;
  }

  private async findOwnedVideo(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    const video = channel
      ? await this.videoRepository.findOne({
          where: { id: videoId, channel_id: channel.id },
        })
      : null;
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  private async findOwnedDraft(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.findOwnedVideo(userId, videoId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotDraftException();
    }
    return video;
  }
}
