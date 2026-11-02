import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

// S3 requires every part but the last to be at least 5 MiB.
const MIN_PART_SIZE = 5 * 1024 * 1024;

async function putBytes(url: string, body: Buffer): Promise<Response> {
  return fetch(url, { method: 'PUT', body: new Uint8Array(body) });
}

describe('StorageService (integration — MinIO)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;
  const createdKeys: string[] = [];

  const newKey = (name: string): string => {
    const key = `test/${randomUUID()}/${name}`;
    createdKeys.push(key);
    return key;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await Promise.all(createdKeys.map((key) => storage.deleteObject(key)));
    await moduleRef.close();
  });

  describe('multipart upload through presigned part URLs', () => {
    it('should assemble the object from parts PUT directly to storage', async () => {
      const key = newKey('original');
      const part1 = randomBytes(MIN_PART_SIZE);
      const part2 = randomBytes(1024);
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      for (const [partNumber, bytes] of [
        [1, part1],
        [2, part2],
      ] as const) {
        const url = await storage.presignUploadPart(key, uploadId, partNumber);
        const res = await putBytes(url, bytes);
        expect(res.status).toBe(200);
      }
      const parts = await storage.listParts(key, uploadId);
      await storage.completeMultipartUpload(key, uploadId, parts);

      const head = await storage.headObject(key);
      expect(head).toEqual({
        sizeBytes: part1.length + part2.length,
        contentType: 'video/mp4',
      });
    });

    it('should list exactly the parts already uploaded', async () => {
      const key = newKey('original');
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const url = await storage.presignUploadPart(key, uploadId, 1);
      await putBytes(url, randomBytes(MIN_PART_SIZE));

      const parts = await storage.listParts(key, uploadId);

      expect(parts).toEqual([
        { partNumber: 1, sizeBytes: MIN_PART_SIZE, etag: expect.any(String) },
      ]);
      await storage.abortMultipartUpload(key, uploadId);
    });

    it('should make the upload unknown after abort', async () => {
      const key = newKey('original');
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      await storage.abortMultipartUpload(key, uploadId);

      await expect(storage.listParts(key, uploadId)).rejects.toMatchObject({
        name: 'NoSuchUpload',
      });
    });
  });

  describe('presigned GET', () => {
    let key: string;
    let content: Buffer;

    beforeAll(async () => {
      key = newKey('original');
      content = randomBytes(4096);
      await storage.putObject(key, content, 'video/mp4');
    });

    it('should answer a Range request with 206 Partial Content', async () => {
      const url = await storage.presignGetObject(key, { audience: 'public' });

      const res = await fetch(url, { headers: { Range: 'bytes=0-99' } });
      const body = Buffer.from(await res.arrayBuffer());

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(
        `bytes 0-99/${content.length}`,
      );
      expect(body.equals(content.subarray(0, 100))).toBe(true);
    });

    it('should serve the download URL as an attachment with the file name', async () => {
      const url = await storage.presignGetObject(key, {
        audience: 'public',
        downloadFileName: 'aula final.mp4',
      });

      const res = await fetch(url);
      const body = Buffer.from(await res.arrayBuffer());

      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toMatch(
        /^attachment; filename="aula final\.mp4"/,
      );
      expect(body.equals(content)).toBe(true);
    });
  });

  describe('object operations', () => {
    it('should put, head and delete an object', async () => {
      const key = newKey('thumbnail.jpg');
      await storage.putObject(key, randomBytes(10), 'image/jpeg');

      expect(await storage.headObject(key)).toEqual({
        sizeBytes: 10,
        contentType: 'image/jpeg',
      });

      await storage.deleteObject(key);
      expect(await storage.headObject(key)).toBeNull();
    });
  });

  describe('endpoint selection', () => {
    it('should sign public URLs for S3_PUBLIC_ENDPOINT and internal ones for S3_ENDPOINT', async () => {
      const service = new StorageService({
        endpoint: 'http://minio:9000',
        publicEndpoint: 'http://public.example:9000',
        region: 'us-east-1',
        accessKey: 'key',
        secretKey: 'secret',
        bucket: 'bucket',
      });

      const publicUrl = new URL(
        await service.presignGetObject('k', { audience: 'public' }),
      );
      const internalUrl = new URL(
        await service.presignGetObject('k', { audience: 'internal' }),
      );
      const partUrl = new URL(await service.presignUploadPart('k', 'u', 1));

      expect(publicUrl.host).toBe('public.example:9000');
      expect(partUrl.host).toBe('public.example:9000');
      expect(internalUrl.host).toBe('minio:9000');
      service.onModuleDestroy();
    });
  });
});
