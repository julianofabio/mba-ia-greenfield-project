import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoResponseMapper } from './video-response.mapper';

function makeVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: 'video-1',
    public_id: 'AAAAAAAAAAA',
    channel_id: 'channel-1',
    title: 'aula',
    status: VideoStatus.READY,
    original_file_name: 'aula.mp4',
    content_type: 'video/mp4',
    declared_size_bytes: 2048,
    storage_key: 'videos/video-1/original',
    upload_id: null,
    thumbnail_key: null,
    size_bytes: 2048,
    duration_seconds: 3,
    width: 320,
    height: 240,
    video_codec: 'h264',
    audio_codec: null,
    container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
    bitrate: 1000,
    failure_reason: null,
    created_at: new Date('2026-11-02T10:00:00Z'),
    updated_at: new Date('2026-11-02T10:01:00Z'),
    ...overrides,
  });
}

describe('VideoResponseMapper', () => {
  const storage = { presignGetObject: jest.fn() };
  const mapper = new VideoResponseMapper(storage as unknown as StorageService);

  beforeEach(() => jest.resetAllMocks());

  it('should expose snake_case fields without internal storage data', async () => {
    const response = await mapper.toResponse(makeVideo());

    expect(response).toEqual({
      id: 'video-1',
      public_id: 'AAAAAAAAAAA',
      title: 'aula',
      status: 'ready',
      original_file_name: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: 2048,
      duration_seconds: 3,
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: null,
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitrate: 1000,
      thumbnail_url: null,
      failure_reason: null,
      created_at: new Date('2026-11-02T10:00:00Z'),
      updated_at: new Date('2026-11-02T10:01:00Z'),
    });
    expect(response).not.toHaveProperty('storage_key');
    expect(response).not.toHaveProperty('upload_id');
    expect(storage.presignGetObject).not.toHaveBeenCalled();
  });

  it('should presign the thumbnail URL for clients when a thumbnail exists', async () => {
    storage.presignGetObject.mockResolvedValue('http://storage/thumb?sig');

    const response = await mapper.toResponse(
      makeVideo({ thumbnail_key: 'videos/video-1/thumbnail.jpg' }),
    );

    expect(response.thumbnail_url).toBe('http://storage/thumb?sig');
    expect(storage.presignGetObject).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
      { audience: 'public' },
    );
  });
});
