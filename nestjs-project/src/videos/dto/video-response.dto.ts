import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'dQw4w9WgXcQ',
    description: 'Unique public id used in the video URL',
  })
  public_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty()
  original_file_name: string;

  @ApiProperty({ example: 'video/mp4' })
  content_type: string;

  @ApiProperty({ type: Number, nullable: true })
  size_bytes: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 3.025 })
  duration_seconds: number | null;

  @ApiProperty({ type: Number, nullable: true })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({ type: String, nullable: true })
  container_format: string | null;

  @ApiProperty({ type: Number, nullable: true, description: 'bits per second' })
  bitrate: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Presigned thumbnail URL (expires in 3600 s)',
  })
  thumbnail_url: string | null;

  @ApiProperty({ type: String, nullable: true })
  failure_reason: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updated_at: Date;
}
