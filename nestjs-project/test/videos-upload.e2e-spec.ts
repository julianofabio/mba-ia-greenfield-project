import * as amqp from 'amqplib';
import request from 'supertest';
import { buildVideoProcessingClientOptions } from '../src/video-processing/video-processing.queue';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { PART_SIZE_BYTES } from '../src/videos/upload-plan';
import {
  createConfirmedUser,
  createE2EApp,
  type E2EApp,
} from './support/e2e-app';

// Spec: specs/videos-upload.plan.md (SI-03.8)
const QUEUE = process.env.VIDEO_PROCESSING_QUEUE!;
const THREE_PARTS_SIZE = 150 * 1024 * 1024;
const TWO_PARTS_SIZE = PART_SIZE_BYTES + 1024;

describe('videos-upload', () => {
  let e2e: E2EApp;
  let amqpConnection: amqp.ChannelModel;
  let amqpChannel: amqp.Channel;
  let token: string;

  const server = () => e2e.app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    e2e = await createE2EApp();
    amqpConnection = await amqp.connect(process.env.RABBITMQ_URL!);
    amqpChannel = await amqpConnection.createChannel();
    const { options } = buildVideoProcessingClientOptions({
      rabbitmqUrl: process.env.RABBITMQ_URL!,
      videoProcessingQueue: QUEUE,
    });
    await amqpChannel.assertQueue(QUEUE, options?.queueOptions);
  });

  afterAll(async () => {
    await amqpChannel.close();
    await amqpConnection.close();
    await e2e.app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(e2e.dataSource);
    await amqpChannel.purgeQueue(QUEUE);
    e2e.clearThrottle();
    ({ accessToken: token } = await createConfirmedUser(e2e));
  });

  function initiate(fileSize: number, as = token) {
    return request(server()).post('/videos').set(auth(as)).send({
      file_name: 'aula.mp4',
      file_size: fileSize,
      content_type: 'video/mp4',
    });
  }

  async function putPart(
    videoId: string,
    partNumber: number,
    sizeBytes: number,
  ) {
    const res = await request(server())
      .post(`/videos/${videoId}/upload/part-urls`)
      .set(auth(token))
      .send({ part_numbers: [partNumber] })
      .expect(200);
    const url = (res.body as { parts: { url: string }[] }).parts[0].url;
    return fetch(url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(sizeBytes, partNumber)),
    });
  }

  // 1. Draft pre-registration — POST /videos

  it('initiate-upload-creates-draft (AC #1)', async () => {
    const res = await initiate(THREE_PARTS_SIZE).expect(201);

    expect(res.body).toEqual({
      id: expect.any(String),
      public_id: expect.stringMatching(/^[A-Za-z0-9_-]{11}$/),
      title: 'aula',
      status: 'draft',
      part_size: PART_SIZE_BYTES,
      part_count: 3,
    });
    const video = await e2e.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: res.body.id });
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.upload_id).toEqual(expect.any(String));
  });

  it('initiate-upload-rejects-invalid-body (AC #2)', async () => {
    const valid = {
      file_name: 'aula.mp4',
      file_size: 1024,
      content_type: 'video/mp4',
    };
    for (const body of [
      { ...valid, file_size: 10737418241 },
      { ...valid, content_type: 'image/png' },
      { ...valid, foo: 'bar' },
    ]) {
      const res = await request(server())
        .post('/videos')
        .set(auth(token))
        .send(body)
        .expect(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    }
    expect(await e2e.dataSource.getRepository(Video).count()).toBe(0);
  });

  it('initiate-upload-requires-authentication (AC #3)', async () => {
    await request(server())
      .post('/videos')
      .send({
        file_name: 'aula.mp4',
        file_size: 1024,
        content_type: 'video/mp4',
      })
      .expect(401);
  });

  // 2. Direct-to-storage part upload and resume

  it('part-urls-accept-direct-put (AC #4)', async () => {
    const { body } = await initiate(THREE_PARTS_SIZE).expect(201);

    const res = await request(server())
      .post(`/videos/${body.id}/upload/part-urls`)
      .set(auth(token))
      .send({ part_numbers: [1, 2] })
      .expect(200);

    expect(res.body.expires_in).toBe(3600);
    expect(
      res.body.parts.map((p: { part_number: number }) => p.part_number),
    ).toEqual([1, 2]);
    const put = await fetch(res.body.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(PART_SIZE_BYTES, 1)),
    });
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toEqual(expect.any(String));
  });

  it('upload-state-lists-stored-parts (AC #5)', async () => {
    const { body } = await initiate(TWO_PARTS_SIZE).expect(201);
    expect((await putPart(body.id, 1, PART_SIZE_BYTES)).status).toBe(200);

    const res = await request(server())
      .get(`/videos/${body.id}/upload`)
      .set(auth(token))
      .expect(200);

    expect(res.body).toEqual({
      part_size: PART_SIZE_BYTES,
      part_count: 2,
      uploaded_parts: [{ part_number: 1, size_bytes: PART_SIZE_BYTES }],
    });
  });

  it('part-urls-reject-out-of-range-part (AC #7)', async () => {
    const { body } = await initiate(THREE_PARTS_SIZE).expect(201);

    const res = await request(server())
      .post(`/videos/${body.id}/upload/part-urls`)
      .set(auth(token))
      .send({ part_numbers: [4] })
      .expect(400);

    expect(res.body.error).toBe('INVALID_PART_NUMBER');
  });

  // 3. Completion and cancellation

  it('complete-upload-moves-to-processing (AC #6)', async () => {
    const { body } = await initiate(TWO_PARTS_SIZE).expect(201);
    await putPart(body.id, 1, PART_SIZE_BYTES);
    await putPart(body.id, 2, 1024);

    const res = await request(server())
      .post(`/videos/${body.id}/upload/complete`)
      .set(auth(token))
      .expect(202);

    expect(res.body).toMatchObject({
      id: body.id,
      status: 'processing',
      size_bytes: TWO_PARTS_SIZE,
    });
    const message = await amqpChannel.get(QUEUE, { noAck: true });
    expect(message).not.toBe(false);
    if (message === false) return;
    expect(JSON.parse(message.content.toString())).toEqual({
      pattern: 'video.uploaded',
      data: { videoId: body.id },
    });
  });

  it('cancel-draft-removes-video (AC #9)', async () => {
    const { body } = await initiate(TWO_PARTS_SIZE).expect(201);

    await request(server())
      .delete(`/videos/${body.id}/upload`)
      .set(auth(token))
      .expect(204);
    expect(
      await e2e.dataSource.getRepository(Video).findOneBy({ id: body.id }),
    ).toBeNull();

    const again = await request(server())
      .delete(`/videos/${body.id}/upload`)
      .set(auth(token))
      .expect(404);
    expect(again.body.error).toBe('VIDEO_NOT_FOUND');
  });

  // 4. Ownership and rate limiting

  it('upload-routes-hide-other-channels-videos (AC #8)', async () => {
    const { body } = await initiate(TWO_PARTS_SIZE).expect(201);
    const { accessToken: other } = await createConfirmedUser(e2e);

    // Built lazily: each supertest request binds its own ephemeral server.
    const calls = [
      () => request(server()).get(`/videos/${body.id}/upload`),
      () =>
        request(server())
          .post(`/videos/${body.id}/upload/part-urls`)
          .send({ part_numbers: [1] }),
      () => request(server()).post(`/videos/${body.id}/upload/complete`),
      () => request(server()).delete(`/videos/${body.id}/upload`),
    ];
    for (const call of calls) {
      const res = await call().set(auth(other)).expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    }
    const video = await e2e.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: body.id });
    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('upload-routes-skip-global-throttle (AC #10)', async () => {
    const { body } = await initiate(TWO_PARTS_SIZE).expect(201);

    for (let i = 0; i < 12; i++) {
      await request(server())
        .get(`/videos/${body.id}/upload`)
        .set(auth(token))
        .expect(200);
    }
  });
});
