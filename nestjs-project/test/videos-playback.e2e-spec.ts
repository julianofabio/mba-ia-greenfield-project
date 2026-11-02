import { readFile } from 'node:fs/promises';
import * as amqp from 'amqplib';
import type { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { MicroserviceOptions } from '@nestjs/microservices';
import request from 'supertest';
import messagingConfig from '../src/config/messaging.config';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createTestFiles,
  generateTestVideo,
  type TestFiles,
} from '../src/test/video-fixtures';
import { ensureDeadLetterQueue } from '../src/video-processing/dead-letter-queue';
import {
  buildVideoProcessingClientOptions,
  buildVideoProcessingServerOptions,
} from '../src/video-processing/video-processing.queue';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { WorkerModule } from '../src/worker.module';
import {
  createConfirmedUser,
  createE2EApp,
  type E2EApp,
} from './support/e2e-app';

// Spec: specs/videos-playback.plan.md (SI-03.12)
const PROCESSING_TIMEOUT_MS = 60_000;

interface UploadedVideo {
  id: string;
  publicId: string;
  content: Buffer;
  fileName: string;
}

describe('videos-playback', () => {
  let e2e: E2EApp;
  let worker: INestMicroservice;
  let files: TestFiles;
  let token: string;
  let mp4: Buffer;

  const server = () => e2e.app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const config = messagingConfig();
    const connection = await amqp.connect(config.rabbitmqUrl);
    const channel = await connection.createChannel();
    await channel.assertQueue(
      config.videoProcessingQueue,
      buildVideoProcessingClientOptions(config).options?.queueOptions,
    );
    await channel.purgeQueue(config.videoProcessingQueue);
    await connection.close();
    await ensureDeadLetterQueue(config);

    e2e = await createE2EApp();
    worker = await NestFactory.createMicroservice<MicroserviceOptions>(
      WorkerModule,
      {
        ...buildVideoProcessingServerOptions(config),
        logger: ['error'],
        abortOnError: false,
      },
    );
    await worker.listen();

    files = await createTestFiles();
    mp4 = await readFile(await generateTestVideo(files, 'clip.mp4'));
  });

  afterAll(async () => {
    await worker.close();
    await e2e.app.close();
    await files.cleanup();
  });

  beforeEach(async () => {
    await cleanAllTables(e2e.dataSource);
    e2e.clearThrottle();
    ({ accessToken: token } = await createConfirmedUser(e2e));
  });

  /** Initiate → presigned part PUT → complete, through the real API. */
  async function upload(
    content: Buffer,
    fileName = 'clip.mp4',
  ): Promise<UploadedVideo> {
    const initiated = await request(server())
      .post('/videos')
      .set(auth(token))
      .send({
        file_name: fileName,
        file_size: content.length,
        content_type: 'video/mp4',
      })
      .expect(201);
    const { id, public_id } = initiated.body as {
      id: string;
      public_id: string;
    };
    const signed = await request(server())
      .post(`/videos/${id}/upload/part-urls`)
      .set(auth(token))
      .send({ part_numbers: [1] })
      .expect(200);
    const put = await fetch(signed.body.parts[0].url as string, {
      method: 'PUT',
      body: new Uint8Array(content),
    });
    expect(put.status).toBe(200);
    await request(server())
      .post(`/videos/${id}/upload/complete`)
      .set(auth(token))
      .expect(202);
    return { id, publicId: public_id, content, fileName };
  }

  async function waitUntilProcessed(id: string): Promise<Record<string, any>> {
    const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
    for (;;) {
      const res = await request(server())
        .get(`/videos/${id}`)
        .set(auth(token))
        .expect(200);
      if (res.body.status === 'ready' || res.body.status === 'failed') {
        return res.body as Record<string, any>;
      }
      if (Date.now() > deadline) throw new Error(`Video ${id} not processed`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async function readyVideo(content = mp4): Promise<UploadedVideo> {
    const video = await upload(content);
    expect((await waitUntilProcessed(video.id)).status).toBe('ready');
    return video;
  }

  // 1. Owner details and processing outcome

  it('owner-sees-ready-video-with-metadata (AC #1)', async () => {
    const video = await upload(mp4);
    const right = await request(server())
      .get(`/videos/${video.id}`)
      .set(auth(token))
      .expect(200);
    expect(['processing', 'ready']).toContain(right.body.status);

    const processed = await waitUntilProcessed(video.id);

    expect(processed).toMatchObject({
      status: 'ready',
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
    });
    expect(processed.duration_seconds).toBeCloseTo(3, 1);
    const thumbnail = await fetch(processed.thumbnail_url as string);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
  });

  it('details-hidden-from-other-users-and-anonymous (AC #2)', async () => {
    const video = await upload(mp4);
    const { accessToken: other } = await createConfirmedUser(e2e);

    const res = await request(server())
      .get(`/videos/${video.id}`)
      .set(auth(other))
      .expect(404);
    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    await request(server()).get(`/videos/${video.id}`).expect(401);
  });

  // 2. Streaming and download of a ready video

  it('stream-redirects-and-serves-partial-content (AC #3)', async () => {
    const video = await readyVideo();

    const res = await request(server())
      .get(`/videos/${video.publicId}/stream`)
      .expect(302);
    expect(res.headers['cache-control']).toBe('no-store');

    const partial = await fetch(res.headers.location, {
      headers: { Range: 'bytes=0-1023' },
    });
    const body = Buffer.from(await partial.arrayBuffer());
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(
      `bytes 0-1023/${video.content.length}`,
    );
    expect(body.equals(video.content.subarray(0, 1024))).toBe(true);
  });

  it('download-redirects-to-attachment (AC #4)', async () => {
    const video = await readyVideo();

    const res = await request(server())
      .get(`/videos/${video.publicId}/download`)
      .expect(302);
    const file = await fetch(res.headers.location);
    const body = Buffer.from(await file.arrayBuffer());

    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toMatch(
      new RegExp(`^attachment; filename="${video.fileName}"`),
    );
    expect(body.equals(video.content)).toBe(true);
  });

  it('each-video-has-its-own-unique-url (AC #7)', async () => {
    const other = await readFile(
      await generateTestVideo(files, 'other.mp4', { durationSeconds: 2 }),
    );
    const first = await readyVideo(mp4);
    const second = await readyVideo(other);

    expect(first.publicId).not.toBe(second.publicId);
    for (const video of [first, second]) {
      const res = await request(server())
        .get(`/videos/${video.publicId}/stream`)
        .expect(302);
      const body = Buffer.from(
        await (await fetch(res.headers.location)).arrayBuffer(),
      );
      expect(body.equals(video.content)).toBe(true);
    }
  });

  // 3. Playback of unavailable videos

  it('stream-not-available-before-ready (AC #5)', async () => {
    const initiated = await request(server())
      .post('/videos')
      .set(auth(token))
      .send({
        file_name: 'draft.mp4',
        file_size: 1024,
        content_type: 'video/mp4',
      })
      .expect(201);
    const { id, public_id } = initiated.body as {
      id: string;
      public_id: string;
    };
    const draft = await request(server())
      .get(`/videos/${public_id}/stream`)
      .expect(404);
    expect(draft.body.error).toBe('VIDEO_NOT_FOUND');

    const repository = e2e.dataSource.getRepository(Video);
    for (const status of [VideoStatus.PROCESSING, VideoStatus.FAILED]) {
      await repository.update({ id }, { status });
      for (const route of ['stream', 'download']) {
        const res = await request(server())
          .get(`/videos/${public_id}/${route}`)
          .expect(404);
        expect(res.body.error).toBe('VIDEO_NOT_FOUND');
      }
    }
  });

  it('unknown-and-malformed-ids-look-the-same (AC #6)', async () => {
    const malformed = await request(server())
      .get('/videos/xyz/stream')
      .expect(404);
    const unknown = await request(server())
      .get('/videos/AAAAAAAAAAA/stream')
      .expect(404);

    expect(malformed.body).toEqual(unknown.body);
    expect(unknown.body.error).toBe('VIDEO_NOT_FOUND');
  });
});
