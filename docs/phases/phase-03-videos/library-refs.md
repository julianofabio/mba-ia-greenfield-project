---
libs:
  "@nestjs/microservices":
    version: "11.1.16"
    context7_id: "/nestjs/docs.nestjs.com/__branch__11.0.0"
    fetched_at: "2026-11-02T10:58:00-03:00"
  amqplib:
    version: "0.10.9"
    context7_id: "/amqp-node/amqplib"
    fetched_at: "2026-11-02T10:58:00-03:00"
  amqp-connection-manager:
    version: "5.0.0"
    context7_id: "—"
    fetched_at: "2026-11-02T10:58:00-03:00"
  "@types/amqplib":
    version: "0.10.8"
    context7_id: "—"
    fetched_at: "2026-11-02T10:58:00-03:00"
  "@aws-sdk/client-s3":
    version: "3.1152.0"
    context7_id: "/aws/aws-sdk-js-v3/v3.1153.0"
    fetched_at: "2026-11-02T10:58:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "3.1152.0"
    context7_id: "/aws/aws-sdk-js-v3/v3.1153.0"
    fetched_at: "2026-11-02T10:58:00-03:00"
  ffmpeg:
    version: "Debian bookworm apt package (5.1.x)"
    context7_id: "/websites/ffmpeg_documentation"
    fetched_at: "2026-11-02T10:58:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-02T11:05:08-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this phase. Pulled via Context7 — through its REST API (`https://context7.com/api/v1/...`) because the Context7 MCP server is not configured in this session; same index, same library IDs. Where Context7 does not index a package (`amqp-connection-manager`, `@types/amqplib`), the facts below come from the package source/registry at the pinned version and are marked as such. Re-fetch when the underlying TD changes.

**Version policy:** every pin is a release at least two weeks old on 2026-11-02 and compatible with the installed `@nestjs/core` 11.1.16 / Node 25 runtime of `Dockerfile.dev`.

## @nestjs/microservices (RMQ transport) — phase-03-videos/TD-01

**Source:** `/nestjs/docs.nestjs.com` branch 11.0.0, `content/microservices/rabbitmq.md`; transport source `nestjs/nest@v11.1.16 packages/microservices/client/client-rmq.ts`.

**Peer dependencies to install:** `amqplib` + `amqp-connection-manager` (declared as optional peers `"*"` by `@nestjs/microservices@11`).

### Consumer (worker) — microservice with manual ack

```typescript
const app = await NestFactory.createMicroservice<MicroserviceOptions>(WorkerModule, {
  transport: Transport.RMQ,
  options: {
    urls: ['amqp://rabbitmq:5672'],
    queue: 'video-processing',
    noAck: false,                 // manual acknowledgement — unacked messages are redelivered if the consumer dies
    prefetchCount: 1,             // one video at a time per worker process
    queueOptions: { durable: true, arguments: { 'x-queue-type': 'quorum' } },
  },
});
```

Handlers read the raw message and channel through `RmqContext`:

```typescript
@EventPattern('video.uploaded')
async handle(@Payload() data: VideoUploadedEvent, @Ctx() context: RmqContext) {
  const channel = context.getChannelRef();
  const originalMsg = context.getMessage();   // amqplib ConsumeMessage: properties.headers, fields.redelivered
  channel.ack(originalMsg);                   // or channel.nack(originalMsg, false, requeue)
}
```

With `noAck: false` Nest does **not** ack/nack on the handler's behalf — every code path must call `ack` or `nack` exactly once (a missing ack leaves the message unacked until the channel closes).

### Producer (API) — ClientsModule + emit

`ClientsModule.register([{ name: TOKEN, transport: Transport.RMQ, options: { ...same urls/queue/queueOptions } }])`, then `client.emit(pattern, data)`.

Verified in `client-rmq.ts@v11.1.16`:

- `emit()` returns a **cold Observable** — nothing is published until it is subscribed; use `await lastValueFrom(client.emit(...))`.
- `dispatchEvent` publishes with `sendToQueue(queue, content, { persistent: true by default, headers })` on an `amqp-connection-manager` channel wrapper and resolves in the publish callback, i.e. after the broker's **publisher confirm** (the wrapper uses a confirm channel). This is what phase-03-videos/TD-10 relies on.
- The client asserts the queue with the same `queueOptions` on connect (`assertQueue(queue, queueOptions)` unless `noAssert`), so producer and consumer **must** pass identical queue arguments or RabbitMQ rejects the second declaration (`PRECONDITION_FAILED`).
- Wire format: JSON `{ "pattern": "<pattern>", "data": <payload> }`.

### Quorum queue arguments (RabbitMQ 4.1 docs, `/rabbitmq/rabbitmq-website`)

- `x-queue-type: quorum` requires `durable: true`.
- `x-delivery-limit: N` — after N redeliveries (nack with requeue) the message is dropped or dead-lettered; the current count is exposed to consumers in the `x-delivery-count` message header (absent on first delivery).
- `x-dead-letter-exchange: ''` + `x-dead-letter-routing-key: <dlq>` — routes dead-lettered messages to a DLQ through the default exchange.

## amqplib / amqp-connection-manager / @types/amqplib — phase-03-videos/TD-01

**Source:** `/amqp-node/amqplib` (Context7) + `nestjs/nest@v11.1.10 package.json` devDependencies (`amqplib` 0.10.9, `amqp-connection-manager` 5.0.0, `@types/amqplib` 0.10.8) — the versions Nest's own RMQ tests run against. `amqplib` 2.x (2026-05+, breaking `heartbeat: 0` semantics, new bundled types) is not adopted.

- `amqp-connection-manager` reconnects automatically. While the broker is unreachable, `ChannelWrapper.sendToQueue` **buffers the message in memory and the returned promise stays pending** until reconnect — the API must bound the publish with a timeout (e.g. RxJS `timeout()` on the emit Observable) to fail fast with 503, as TD-10 requires.
- `@types/amqplib` is a dev dependency only (types for `ConsumeMessage`, `Channel` used with `RmqContext`).

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner — phase-03-videos/TD-03, TD-02, TD-07

**Source:** `/aws/aws-sdk-js-v3` (Context7, v3.1153.0 docs; pinned package 3.1152.0).

### Client against MinIO

```typescript
const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: 'http://minio:9000',        // internal endpoint (server-side calls)
  forcePathStyle: true,                 // MinIO: http://host/bucket/key, no virtual-host buckets
  credentials: { accessKeyId, secretAccessKey },
});
```

A **second** `S3Client` built with the public endpoint (`S3_PUBLIC_ENDPOINT`) is used only for `getSignedUrl` of URLs handed to clients — SigV4 signs the `host` header, so a URL signed for `minio:9000` is rejected when called as `localhost:9000` and vice versa.

### Presigning

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
const url = await getSignedUrl(publicS3, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 });
```

### Multipart upload commands used (TD-02)

| Command | Role |
|---|---|
| `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` | initiation → `UploadId` |
| `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` | presigned per part; client PUTs the bytes; response header `ETag` |
| `ListPartsCommand({ Bucket, Key, UploadId })` | resume: which parts exist (`Parts[].PartNumber/ETag/Size`) |
| `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` | assemble the object |
| `AbortMultipartUploadCommand({ Bucket, Key, UploadId })` | cancel a draft |
| `HeadObjectCommand({ Bucket, Key })` | completion size check (`ContentLength`) and idempotent re-completion detection |

S3 limits: part size 5 MiB–5 GiB (last part may be smaller), at most 10 000 parts per upload.

### Streaming / download (TD-07)

- `GetObjectCommand({ Bucket, Key })` presigned → storage answers `Range: bytes=a-b` with `206 Partial Content`, `Accept-Ranges: bytes`, `Content-Range`.
- `GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="..."' })` presigned → download with the attachment header set by storage.
- Thumbnail upload by the worker: `PutObjectCommand({ Bucket, Key, Body: Buffer, ContentType: 'image/jpeg' })`.

**Checksum note (AWS SDK ≥ 3.729):** the SDK adds CRC32 checksum headers by default (`requestChecksumCalculation: 'WHEN_SUPPORTED'`). For presigned `UploadPart` URLs used by third-party clients, configure `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'` on the client so the signed URL does not require checksum headers the uploader will not send.

## ffmpeg / ffprobe — phase-03-videos/TD-05

**Source:** `/websites/ffmpeg_documentation` (Context7). Installed with `apt install ffmpeg` on the `node:25.6.0-slim` (Debian 12 bookworm) image — provides `ffmpeg` and `ffprobe` 5.1.x.

- Metadata: `ffprobe -v error -print_format json -show_format -show_streams <input>` → `format.duration` (string seconds), `format.format_name`, `format.bit_rate`, `streams[].codec_type` (`video`/`audio`), `streams[].codec_name`, `streams[].width/height`.
- Single frame: `ffmpeg -v error -ss <seconds> -i <input> -frames:v 1 -vf scale=1280:-2 -q:v 3 -f image2 -c:v mjpeg pipe:1` (input seeking with `-ss` before `-i` is fast and keyframe-accurate enough for a thumbnail; `scale=1280:-2` keeps aspect ratio with an even height).
- HTTP input: an `http(s)://` presigned URL is a seekable input — FFmpeg issues `Range` requests, so probing and frame extraction read only the parts they need.
- Test fixtures: `ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=25 -f lavfi -i sine=frequency=440:duration=3 -c:v libx264 -c:a aac -movflags +faststart out.mp4` generates a small valid video without binary files in git.
- Invoke from Node with `child_process.execFile`/`spawn` and an argument array (no shell). Non-zero exit code → stderr carries the reason.
