import { Injectable } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { VideoResponseDto } from './dto/video-response.dto';
import { Video } from './entities/video.entity';

@Injectable()
export class VideoResponseMapper {
  constructor(private readonly storage: StorageService) {}

  async toResponse(video: Video): Promise<VideoResponseDto> {
    const thumbnailUrl = video.thumbnail_key
      ? await this.storage.presignGetObject(video.thumbnail_key, {
          audience: 'public',
        })
      : null;

    return {
      id: video.id,
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      original_file_name: video.original_file_name,
      content_type: video.content_type,
      size_bytes: video.size_bytes ?? null,
      duration_seconds: video.duration_seconds ?? null,
      width: video.width ?? null,
      height: video.height ?? null,
      video_codec: video.video_codec ?? null,
      audio_codec: video.audio_codec ?? null,
      container_format: video.container_format ?? null,
      bitrate: video.bitrate ?? null,
      thumbnail_url: thumbnailUrl,
      failure_reason: video.failure_reason ?? null,
      created_at: video.created_at,
      updated_at: video.updated_at,
    };
  }
}
