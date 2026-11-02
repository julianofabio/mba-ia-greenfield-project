import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createTestFiles,
  generateTestVideo,
  generateTextFile,
  type TestFiles,
} from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import {
  videoOriginalKey,
  videoThumbnailKey,
} from '../videos/video-storage-keys';
import { MediaProcessingError } from './media-processing.error';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService (integration — PostgreSQL + MinIO + FFmpeg)', () => {
  let moduleRef: TestingModule;
  let service: VideoProcessingService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let files: TestFiles;
  let channelId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(
          createTestDataSource([User, Channel, Video], { synchronize: false })
            .options,
        ),
        VideoProcessingModule,
      ],
    }).compile();
    service = moduleRef.get(VideoProcessingService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    files = await createTestFiles();
  });

  afterAll(async () => {
    await files.cleanup();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `worker_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    channelId = (
      await dataSource.getRepository(Channel).save({
        name: 'worker',
        nickname: `wk_${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      })
    ).id;
  });

  /** A video whose upload was completed: original stored, status as given. */
  async function storedVideo(
    sourcePath: string,
    status = VideoStatus.PROCESSING,
  ): Promise<Video> {
    const id = randomUUID();
    const content = await readFile(sourcePath);
    await storage.putObject(videoOriginalKey(id), content, 'video/mp4');
    return videoRepository.save({
      id,
      public_id: generatePublicId(),
      channel_id: channelId,
      title: 'aula',
      status,
      original_file_name: 'aula.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: content.length,
      size_bytes: content.length,
      storage_key: videoOriginalKey(id),
    });
  }

  it('should extract metadata, store the thumbnail and mark the video ready', async () => {
    const source = await generateTestVideo(files, 'ok.mp4');
    const video = await storedVideo(source);

    await service.process(video.id);

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed).toMatchObject({
      status: VideoStatus.READY,
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
      thumbnail_key: videoThumbnailKey(video.id),
      failure_reason: null,
    });
    expect(processed.duration_seconds).toBeCloseTo(3, 1);
    expect(processed.container_format).toContain('mp4');
    expect(processed.size_bytes).toBe(video.declared_size_bytes);
    const thumbnail = await storage.headObject(videoThumbnailKey(video.id));
    expect(thumbnail).toMatchObject({ contentType: 'image/jpeg' });
    expect(thumbnail!.sizeBytes).toBeGreaterThan(0);
  });

  it('should also complete a job that arrives while the video is still a draft', async () => {
    const source = await generateTestVideo(files, 'draft.mp4', {
      durationSeconds: 1,
    });
    const video = await storedVideo(source, VideoStatus.DRAFT);

    await service.process(video.id);

    expect(
      (await videoRepository.findOneByOrFail({ id: video.id })).status,
    ).toBe(VideoStatus.READY);
  });

  it('should leave a ready video untouched when the job is repeated', async () => {
    const source = await generateTestVideo(files, 'twice.mp4', {
      durationSeconds: 1,
    });
    const video = await storedVideo(source);
    await service.process(video.id);
    const first = await videoRepository.findOneByOrFail({ id: video.id });
    await storage.deleteObject(videoThumbnailKey(video.id));

    await service.process(video.id);

    expect(await videoRepository.findOneByOrFail({ id: video.id })).toEqual(
      first,
    );
    expect(await storage.headObject(videoThumbnailKey(video.id))).toBeNull();
  });

  it('should reject a file that is not a video and mark it failed with a reason', async () => {
    const video = await storedVideo(
      await generateTextFile(files, 'not-a-video.mp4'),
    );

    await expect(service.process(video.id)).rejects.toThrow(
      MediaProcessingError,
    );
    await service.markFailed(video.id, 'ffprobe failed: invalid data');

    const failed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe(VideoStatus.FAILED);
    expect(failed.failure_reason).toBe('ffprobe failed: invalid data');
  });

  it('should not overwrite a ready video when markFailed arrives late', async () => {
    const source = await generateTestVideo(files, 'late.mp4', {
      durationSeconds: 1,
    });
    const video = await storedVideo(source);
    await service.process(video.id);

    await service.markFailed(video.id, 'late failure');

    expect(
      (await videoRepository.findOneByOrFail({ id: video.id })).status,
    ).toBe(VideoStatus.READY);
  });
});
