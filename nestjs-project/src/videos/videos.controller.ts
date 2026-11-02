import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { PRESIGNED_URL_EXPIRES_IN_SECONDS } from '../storage/storage.constants';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { UploadPartUrlsDto } from './dto/upload-part-urls.dto';
import { UploadPartUrlsResponseDto } from './dto/upload-part-urls-response.dto';
import { UploadStateResponseDto } from './dto/upload-state-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoResponseMapper } from './video-response.mapper';
import { type PlaybackMode, VideosService } from './videos.service';

const ERROR_SCHEMA = { $ref: getSchemaPath(ApiErrorEnvelope) };

interface RedirectTarget {
  url: string;
  statusCode: number;
}

// Upload orchestration legitimately needs many calls per file and playback
// re-requests redirects, so the auth-oriented 10 req/min throttle does not apply.
@SkipThrottle()
@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly responseMapper: VideoResponseMapper,
  ) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the caller channel and opens a multipart upload. The file bytes go straight to object storage through presigned part URLs.',
  })
  @ApiResponse({ status: 201, type: InitiateUploadResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'User has no channel (CHANNEL_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    const { video, partSize, partCount } =
      await this.videosService.initiateUpload(user.sub, dto);
    return {
      id: video.id,
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      part_size: partSize,
      part_count: partCount,
    };
  }

  @Get(':id/upload')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the upload state',
    description:
      'Lists the parts already stored so an interrupted upload can be resumed.',
  })
  @ApiResponse({ status: 200, type: UploadStateResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid video id',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload already completed (VIDEO_NOT_DRAFT)',
    schema: ERROR_SCHEMA,
  })
  async getUploadState(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadStateResponseDto> {
    const state = await this.videosService.getUploadState(user.sub, id);
    return {
      part_size: state.partSize,
      part_count: state.partCount,
      uploaded_parts: state.uploadedParts.map((part) => ({
        part_number: part.partNumber,
        size_bytes: part.sizeBytes,
      })),
    };
  }

  @Post(':id/upload/part-urls')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign part upload URLs',
    description:
      'Returns presigned URLs; the client PUTs each part directly to object storage.',
  })
  @ApiResponse({ status: 200, type: UploadPartUrlsResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or INVALID_PART_NUMBER',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload already completed (VIDEO_NOT_DRAFT)',
    schema: ERROR_SCHEMA,
  })
  async signUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadPartUrlsDto,
  ): Promise<UploadPartUrlsResponseDto> {
    const parts = await this.videosService.presignUploadParts(
      user.sub,
      id,
      dto.part_numbers,
    );
    return {
      expires_in: PRESIGNED_URL_EXPIRES_IN_SECONDS,
      parts: parts.map(({ partNumber, url }) => ({
        part_number: partNumber,
        url,
      })),
    };
  }

  @Post(':id/upload/complete')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete the upload',
    description:
      'Assembles the stored parts, queues the processing job and moves the video to processing. Idempotent.',
  })
  @ApiResponse({ status: 202, type: VideoResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid video id',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'Parts missing (UPLOAD_INCOMPLETE)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 422,
    description:
      'Uploaded size differs from the declared size (UPLOAD_SIZE_MISMATCH)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 503,
    description:
      'Queue did not confirm the job (PROCESSING_QUEUE_UNAVAILABLE) — retry',
    schema: ERROR_SCHEMA,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.completeUpload(user.sub, id);
    return this.responseMapper.toResponse(video);
  }

  @Delete(':id/upload')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cancel a draft upload',
    description: 'Aborts the multipart upload and deletes the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Draft cancelled' })
  @ApiResponse({
    status: 400,
    description: 'Invalid video id',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload already completed (VIDEO_NOT_DRAFT)',
    schema: ERROR_SCHEMA,
  })
  async cancelUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.videosService.cancelUpload(user.sub, id);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a video of the caller channel',
    description:
      'Returns the status lifecycle (draft, processing, ready, failed) and the extracted metadata.',
  })
  @ApiResponse({ status: 200, type: VideoResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid video id',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.getOwnedVideo(user.sub, id);
    return this.responseMapper.toResponse(video);
  }

  @Public()
  @Get(':publicId/stream')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Stream a ready video',
    description:
      'Unique public URL of the video. Redirects to a short-lived storage URL that serves Range requests (206 Partial Content), so playback starts without a full download.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned storage URL',
  })
  @ApiResponse({
    status: 404,
    description: 'No ready video for this id (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  async stream(@Param('publicId') publicId: string): Promise<RedirectTarget> {
    return this.playbackRedirect(publicId, 'stream');
  }

  @Public()
  @Get(':publicId/download')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Download a ready video',
    description:
      'Redirects to a short-lived storage URL that serves the original file as an attachment.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned storage URL',
  })
  @ApiResponse({
    status: 404,
    description: 'No ready video for this id (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  async download(@Param('publicId') publicId: string): Promise<RedirectTarget> {
    return this.playbackRedirect(publicId, 'download');
  }

  private async playbackRedirect(
    publicId: string,
    mode: PlaybackMode,
  ): Promise<RedirectTarget> {
    const url = await this.videosService.resolvePlaybackUrl(publicId, mode);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
