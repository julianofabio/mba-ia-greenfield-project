import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class InitiateUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  public_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({
    example: 67108864,
    description: 'Size of every part but the last, in bytes',
  })
  part_size: number;

  @ApiProperty({ example: 3 })
  part_count: number;
}
