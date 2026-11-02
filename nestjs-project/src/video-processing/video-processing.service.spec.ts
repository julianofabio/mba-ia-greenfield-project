import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessingService } from './video-processing.service';

function makeVideo(status: VideoStatus): Video {
  return Object.assign(new Video(), {
    id: 'video-1',
    status,
    storage_key: 'videos/video-1/original',
    size_bytes: 2048,
  });
}

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  const repo = { findOneBy: jest.fn(), update: jest.fn() };
  const storage = {
    presignGetObject: jest.fn(),
    putObject: jest.fn(),
    headObject: jest.fn(),
  };
  const mediaProbe = { probe: jest.fn(), extractFrame: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    storage.presignGetObject.mockResolvedValue('http://minio/original?sig');
    storage.headObject.mockResolvedValue({ sizeBytes: 2048 });
    mediaProbe.probe.mockResolvedValue({
      durationSeconds: 3.0004,
      width: 320,
      height: 240,
      videoCodec: 'h264',
      audioCodec: 'aac',
      containerFormat: 'mov,mp4',
      bitrate: 1000,
    });
    mediaProbe.extractFrame.mockResolvedValue(Buffer.from([0xff, 0xd8]));
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: storage },
        { provide: MediaProbeService, useValue: mediaProbe },
      ],
    }).compile();
    service = moduleRef.get(VideoProcessingService);
  });

  describe('process — idempotency', () => {
    it.each([
      ['missing', null],
      ['ready', makeVideo(VideoStatus.READY)],
      ['failed', makeVideo(VideoStatus.FAILED)],
    ])(
      'should skip a %s video without touching storage or the row',
      async (_label, video) => {
        repo.findOneBy.mockResolvedValue(video);

        await service.process('video-1');

        expect(mediaProbe.probe).not.toHaveBeenCalled();
        expect(storage.putObject).not.toHaveBeenCalled();
        expect(repo.update).not.toHaveBeenCalled();
      },
    );
  });

  describe('process — happy path', () => {
    it('should move a draft to processing before processing it', async () => {
      repo.findOneBy.mockResolvedValue(makeVideo(VideoStatus.DRAFT));

      await service.process('video-1');

      expect(repo.update).toHaveBeenNthCalledWith(
        1,
        { id: 'video-1', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING },
      );
    });

    it('should store the thumbnail and persist the metadata as ready', async () => {
      repo.findOneBy.mockResolvedValue(makeVideo(VideoStatus.PROCESSING));

      await service.process('video-1');

      expect(mediaProbe.probe).toHaveBeenCalledWith(
        'http://minio/original?sig',
      );
      expect(mediaProbe.extractFrame).toHaveBeenCalledWith(
        'http://minio/original?sig',
        0.3,
      );
      expect(storage.putObject).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
        Buffer.from([0xff, 0xd8]),
        'image/jpeg',
      );
      expect(repo.update).toHaveBeenCalledWith(
        {
          id: 'video-1',
          status: In([VideoStatus.DRAFT, VideoStatus.PROCESSING]),
        },
        expect.objectContaining({
          status: VideoStatus.READY,
          duration_seconds: 3,
          width: 320,
          height: 240,
          thumbnail_key: 'videos/video-1/thumbnail.jpg',
          failure_reason: null,
        }),
      );
    });
  });

  describe('markFailed', () => {
    it('should only fail non-terminal videos and cap the reason at 500 chars', async () => {
      await service.markFailed('video-1', 'x'.repeat(800));

      expect(repo.update).toHaveBeenCalledWith(
        {
          id: 'video-1',
          status: In([VideoStatus.DRAFT, VideoStatus.PROCESSING]),
        },
        { status: VideoStatus.FAILED, failure_reason: 'x'.repeat(500) },
      );
    });

    it('should store a default reason when none is given', async () => {
      await service.markFailed('video-1', '   ');

      expect(repo.update).toHaveBeenCalledWith(expect.anything(), {
        status: VideoStatus.FAILED,
        failure_reason: 'Video processing failed',
      });
    });
  });
});
