import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { MAX_TITLE_LENGTH, MAX_VIDEO_SIZE_BYTES } from '../upload-plan';

export class InitiateUploadDto {
  /** Original name of the video file, e.g. `aula.mp4`. */
  @IsString()
  @Length(1, 255)
  file_name: string;

  /** File size in bytes — at most 10 GiB (10737418240). */
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  file_size: number;

  /** MIME type of the file; must be a `video/*` type. */
  @IsString()
  @Matches(/^video\/[\w.+-]+$/)
  content_type: string;

  /** Draft title; defaults to the file name without its extension. */
  @IsOptional()
  @IsString()
  @Length(1, MAX_TITLE_LENGTH)
  title?: string;
}
