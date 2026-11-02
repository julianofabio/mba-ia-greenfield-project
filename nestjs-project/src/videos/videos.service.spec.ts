import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  ProcessingQueueUnavailableException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotDraftException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { PART_SIZE_BYTES } from './upload-plan';
import { VideoProcessingPublisher } from './video-processing.publisher';
import { VideosService } from './videos.service';

const USER_ID = 'user-1';
const CHANNEL = { id: 'channel-1' };
const TWO_PARTS_SIZE = PART_SIZE_BYTES + 1024;

function makeVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: 'video-1',
    public_id: 'AAAAAAAAAAA',
    channel_id: CHANNEL.id,
    title: 'aula',
    status: VideoStatus.DRAFT,
    original_file_name: 'aula.mp4',
    content_type: 'video/mp4',
    declared_size_bytes: TWO_PARTS_SIZE,
    storage_key: 'videos/video-1/original',
    upload_id: 'upload-1',
    ...overrides,
  });
}

function uniqueViolation(column: string): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error('dup')) as any;
  err.code = '23505';
  err.detail = `Key (${column})=(x) already exists.`;
  return err;
}

function noSuchUpload(): Error {
  return Object.assign(new Error('upload not found'), { name: 'NoSuchUpload' });
}

describe('VideosService', () => {
  let service: VideosService;
  const repo = {
    create: jest.fn((v: Partial<Video>) => Object.assign(new Video(), v)),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findOne: jest.fn(),
    findOneByOrFail: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    listParts: jest.fn(),
    presignUploadPart: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
    presignGetObject: jest.fn(),
  };
  const publisher = { publishVideoUploaded: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    repo.create.mockImplementation((v: Partial<Video>) =>
      Object.assign(new Video(), v),
    );
    channelsService.findByUserId.mockResolvedValue(CHANNEL);
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storage },
        { provide: VideoProcessingPublisher, useValue: publisher },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  });

  describe('initiateUpload', () => {
    const input = {
      file_name: 'aula.mp4',
      file_size: TWO_PARTS_SIZE,
      content_type: 'video/mp4',
    };

    it('should fail with CHANNEL_NOT_FOUND when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.initiateUpload(USER_ID, input)).rejects.toThrow(
        ChannelNotFoundException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('should retry with a new public_id after a unique violation on public_id', async () => {
      repo.save
        .mockRejectedValueOnce(uniqueViolation('public_id'))
        .mockImplementationOnce((v: Video) => Promise.resolve(v));
      storage.createMultipartUpload.mockResolvedValue('upload-1');

      const plan = await service.initiateUpload(USER_ID, input);

      expect(repo.save).toHaveBeenCalledTimes(2);
      const [first, second] = repo.save.mock.calls.map(([v]) => v as Video);
      expect(first.public_id).not.toBe(second.public_id);
      expect(first.id).toBe(second.id);
      expect(plan).toMatchObject({ partSize: PART_SIZE_BYTES, partCount: 2 });
      expect(plan.video.upload_id).toBe('upload-1');
    });

    it('should not retry other database errors', async () => {
      repo.save.mockRejectedValue(uniqueViolation('id'));

      await expect(service.initiateUpload(USER_ID, input)).rejects.toThrow(
        QueryFailedError,
      );
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('should remove the draft when the storage cannot open the upload', async () => {
      repo.save.mockImplementation((v: Video) => Promise.resolve(v));
      storage.createMultipartUpload.mockRejectedValue(
        new Error('storage down'),
      );

      await expect(service.initiateUpload(USER_ID, input)).rejects.toThrow(
        'storage down',
      );
      const saved = repo.save.mock.calls[0][0] as Video;
      expect(repo.delete).toHaveBeenCalledWith({ id: saved.id });
    });
  });

  describe('ownership and draft guards', () => {
    it('should hide videos of other channels with VIDEO_NOT_FOUND', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.getUploadState(USER_ID, 'video-1')).rejects.toThrow(
        VideoNotFoundException,
      );
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 'video-1', channel_id: CHANNEL.id },
      });
    });

    it('should reject upload operations on videos past draft with VIDEO_NOT_DRAFT', async () => {
      repo.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.presignUploadParts(USER_ID, 'video-1', [1]),
      ).rejects.toThrow(VideoNotDraftException);
      await expect(service.cancelUpload(USER_ID, 'video-1')).rejects.toThrow(
        VideoNotDraftException,
      );
    });

    it('should reject part numbers beyond part_count with INVALID_PART_NUMBER', async () => {
      repo.findOne.mockResolvedValue(makeVideo());

      await expect(
        service.presignUploadParts(USER_ID, 'video-1', [1, 3]),
      ).rejects.toThrow(InvalidPartNumberException);
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });
  });

  describe('completeUpload', () => {
    const fullParts = [
      { partNumber: 1, sizeBytes: PART_SIZE_BYTES, etag: 'e1' },
      { partNumber: 2, sizeBytes: 1024, etag: 'e2' },
    ];

    it('should return a video past draft without publishing again', async () => {
      const processing = makeVideo({ status: VideoStatus.PROCESSING });
      repo.findOne.mockResolvedValue(processing);

      await expect(service.completeUpload(USER_ID, 'video-1')).resolves.toBe(
        processing,
      );
      expect(publisher.publishVideoUploaded).not.toHaveBeenCalled();
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should fail with UPLOAD_INCOMPLETE when parts are missing', async () => {
      repo.findOne.mockResolvedValue(makeVideo());
      storage.listParts.mockResolvedValue([fullParts[0]]);

      await expect(service.completeUpload(USER_ID, 'video-1')).rejects.toThrow(
        UploadIncompleteException,
      );
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should fail with UPLOAD_SIZE_MISMATCH when the parts do not add up', async () => {
      repo.findOne.mockResolvedValue(makeVideo());
      storage.listParts.mockResolvedValue([
        fullParts[0],
        { ...fullParts[1], sizeBytes: 2048 },
      ]);

      await expect(service.completeUpload(USER_ID, 'video-1')).rejects.toThrow(
        UploadSizeMismatchException,
      );
    });

    it('should keep the video untouched when the job cannot be published', async () => {
      repo.findOne.mockResolvedValue(makeVideo());
      storage.listParts.mockResolvedValue(fullParts);
      publisher.publishVideoUploaded.mockRejectedValue(
        new ProcessingQueueUnavailableException(),
      );

      await expect(service.completeUpload(USER_ID, 'video-1')).rejects.toThrow(
        ProcessingQueueUnavailableException,
      );
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('should publish and move to processing after assembling the parts', async () => {
      repo.findOne.mockResolvedValue(makeVideo());
      storage.listParts.mockResolvedValue(fullParts);
      repo.findOneByOrFail.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );

      await service.completeUpload(USER_ID, 'video-1');

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
        fullParts,
      );
      expect(publisher.publishVideoUploaded).toHaveBeenCalledWith('video-1');
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'video-1', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING },
      );
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        { upload_id: null, size_bytes: TWO_PARTS_SIZE },
      );
    });

    it('should publish on retry when an earlier attempt already assembled the object', async () => {
      repo.findOne.mockResolvedValue(makeVideo());
      storage.listParts.mockRejectedValue(noSuchUpload());
      storage.headObject.mockResolvedValue({
        sizeBytes: TWO_PARTS_SIZE,
        contentType: 'video/mp4',
      });
      repo.findOneByOrFail.mockResolvedValue(makeVideo());

      await service.completeUpload(USER_ID, 'video-1');

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(publisher.publishVideoUploaded).toHaveBeenCalledWith('video-1');
    });
  });

  describe('cancelUpload', () => {
    it('should abort the upload, delete any stored object and the record', async () => {
      repo.findOne.mockResolvedValue(makeVideo());

      await service.cancelUpload(USER_ID, 'video-1');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
      );
      expect(storage.deleteObject).toHaveBeenCalledWith(
        'videos/video-1/original',
      );
      expect(repo.delete).toHaveBeenCalledWith({ id: 'video-1' });
    });

    it('should still remove a draft whose upload was already assembled', async () => {
      repo.findOne.mockResolvedValue(makeVideo());
      storage.abortMultipartUpload.mockRejectedValue(noSuchUpload());

      await service.cancelUpload(USER_ID, 'video-1');

      expect(repo.delete).toHaveBeenCalledWith({ id: 'video-1' });
    });
  });

  describe('getOwnedVideo', () => {
    it('should return the video of the caller channel', async () => {
      const video = makeVideo({ status: VideoStatus.READY });
      repo.findOne.mockResolvedValue(video);

      await expect(service.getOwnedVideo(USER_ID, 'video-1')).resolves.toBe(
        video,
      );
    });

    it('should hide videos of other channels with VIDEO_NOT_FOUND', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.getOwnedVideo(USER_ID, 'video-1')).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });

  describe('resolvePlaybackUrl', () => {
    it('should reject a malformed public id without querying the database', async () => {
      await expect(service.resolvePlaybackUrl('xyz', 'stream')).rejects.toThrow(
        VideoNotFoundException,
      );
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('should only look up ready videos and answer VIDEO_NOT_FOUND otherwise', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.resolvePlaybackUrl('AAAAAAAAAAA', 'stream'),
      ).rejects.toThrow(VideoNotFoundException);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { public_id: 'AAAAAAAAAAA', status: VideoStatus.READY },
      });
    });

    it('should sign a public URL for streaming', async () => {
      repo.findOne.mockResolvedValue(makeVideo({ status: VideoStatus.READY }));
      storage.presignGetObject.mockResolvedValue('http://storage/video?sig');

      await expect(
        service.resolvePlaybackUrl('AAAAAAAAAAA', 'stream'),
      ).resolves.toBe('http://storage/video?sig');
      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/original',
        { audience: 'public', downloadFileName: undefined },
      );
    });

    it('should sign the download URL with the original file name', async () => {
      repo.findOne.mockResolvedValue(makeVideo({ status: VideoStatus.READY }));

      await service.resolvePlaybackUrl('AAAAAAAAAAA', 'download');

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/original',
        { audience: 'public', downloadFileName: 'aula.mp4' },
      );
    });
  });
});
