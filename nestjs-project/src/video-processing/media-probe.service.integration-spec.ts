import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  createTestFiles,
  generateTestVideo,
  generateTextFile,
  type TestFiles,
} from '../test/video-fixtures';
import { MediaProbeService } from './media-probe.service';
import { MediaProcessingError } from './media-processing.error';

describe('MediaProbeService (integration — FFmpeg + MinIO)', () => {
  let moduleRef: TestingModule;
  let probe: MediaProbeService;
  let storage: StorageService;
  let files: TestFiles;
  let videoWithAudio: string;
  const storedKeys: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [MediaProbeService],
    }).compile();
    probe = moduleRef.get(MediaProbeService);
    storage = moduleRef.get(StorageService);
    files = await createTestFiles();
    videoWithAudio = await generateTestVideo(files, 'with-audio.mp4');
  });

  afterAll(async () => {
    await Promise.all(storedKeys.map((key) => storage.deleteObject(key)));
    await files.cleanup();
    await moduleRef.close();
  });

  it('should extract duration, resolution and codecs of an H.264/AAC MP4', async () => {
    const metadata = await probe.probe(videoWithAudio);

    expect(metadata.durationSeconds).toBeCloseTo(3, 1);
    expect(metadata).toMatchObject({
      width: 320,
      height: 240,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
    expect(metadata.containerFormat).toContain('mp4');
    expect(metadata.bitrate).toBeGreaterThan(0);
  });

  it('should report no audio codec for a silent video', async () => {
    const silent = await generateTestVideo(files, 'silent.mp4', {
      withAudio: false,
    });

    expect((await probe.probe(silent)).audioCodec).toBeNull();
  });

  it('should fail with MediaProcessingError for a file that is not a video', async () => {
    const text = await generateTextFile(files, 'not-a-video.mp4');

    await expect(probe.probe(text)).rejects.toThrow(MediaProcessingError);
  });

  it('should extract a JPEG frame no wider than the source', async () => {
    const frame = await probe.extractFrame(videoWithAudio, 0.3);
    const framePath = join(files.dir, 'frame.jpg');
    await writeFile(framePath, frame);

    expect(frame.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const frameInfo = await probe.probe(framePath);
    expect(frameInfo).toMatchObject({ width: 320, height: 240 });
  });

  it('should scale frames of wide videos down to 1280 px keeping an even height', async () => {
    const wide = await generateTestVideo(files, 'wide.mp4', {
      durationSeconds: 1,
      width: 1920,
      height: 1080,
      withAudio: false,
    });
    const framePath = join(files.dir, 'wide-frame.jpg');
    await writeFile(framePath, await probe.extractFrame(wide, 0));

    expect(await probe.probe(framePath)).toMatchObject({
      width: 1280,
      height: 720,
    });
  });

  it('should read the same metadata through a presigned storage URL', async () => {
    const key = `test/${randomUUID()}/original`;
    storedKeys.push(key);
    await storage.putObject(key, await readFile(videoWithAudio), 'video/mp4');
    const url = await storage.presignGetObject(key, { audience: 'internal' });

    expect(await probe.probe(url)).toEqual(await probe.probe(videoWithAudio));
    const frame = await probe.extractFrame(url, 0.3);
    expect(frame.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });
});
