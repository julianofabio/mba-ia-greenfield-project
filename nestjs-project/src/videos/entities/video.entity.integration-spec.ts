import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoStatus } from './video.entity';

const TEN_GIB = 10_737_418_240;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    // The schema comes from the migrations (CreateVideos) — no synchronize.
    dataSource = createTestDataSource([User, Channel, Video], {
      synchronize: false,
    });
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `video_owner_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'owner',
      nickname: `owner_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
  });

  function buildVideo(overrides: Partial<Video> = {}): Partial<Video> {
    return {
      public_id: randomUUID().replace(/-/g, '').slice(0, 11),
      channel_id: channel.id,
      title: 'aula',
      original_file_name: 'aula.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: 1024,
      storage_key: 'videos/placeholder/original',
      ...overrides,
    };
  }

  it('should default status to draft and leave processing metadata null', async () => {
    const saved = await videoRepository.save(buildVideo());
    const video = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video).toMatchObject({
      upload_id: null,
      thumbnail_key: null,
      size_bytes: null,
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
      audio_codec: null,
      container_format: null,
      bitrate: null,
      failure_reason: null,
    });
  });

  it('should reject two videos with the same public_id', async () => {
    await videoRepository.save(buildVideo({ public_id: 'AAAAAAAAAAA' }));

    await expect(
      videoRepository.save(buildVideo({ public_id: 'AAAAAAAAAAA' })),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should reject a video whose channel does not exist', async () => {
    await expect(
      videoRepository.save(buildVideo({ channel_id: randomUUID() })),
    ).rejects.toThrow(/foreign key/);
  });

  it('should read bigint and numeric columns back as numbers', async () => {
    const saved = await videoRepository.save(
      buildVideo({
        declared_size_bytes: TEN_GIB,
        size_bytes: TEN_GIB,
        duration_seconds: 3.025,
        bitrate: 2_500_000,
      }),
    );
    const video = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(video.declared_size_bytes).toBe(TEN_GIB);
    expect(video.size_bytes).toBe(TEN_GIB);
    expect(video.duration_seconds).toBe(3.025);
    expect(video.bitrate).toBe(2_500_000);
  });
});
