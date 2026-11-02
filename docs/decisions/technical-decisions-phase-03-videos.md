---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-02
scope_description: "Backend video pipeline: S3-compatible object storage usage, RabbitMQ job queue integration, direct-to-storage resumable upload of files up to 10GB, FFmpeg worker (metadata + thumbnail), unique video URL identifiers, range-based streaming and download, video status lifecycle and failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the `videos` module (upload orchestration, streaming/download endpoints), the storage and queue integrations, the `videos` migration, the video worker entrypoint, and the new Compose services (object storage, message broker, worker).
- `next-frontend/` — no open decision. Phase 03 capabilities in `docs/project-plan.md` contain no UI bullet, and the phase brief (`docs/phases/phase-03-videos/brief.md`) states that the video interface is out of scope. The upload/streaming contract is published through the existing OpenAPI pipeline (`technical-decisions-openapi-docs-nestjs.md`) for a future frontend phase to consume.

**Fixed by the project, not reopened here:** the object storage technology is S3-compatible (MinIO locally, S3 in production — `docs/diagrams/software-arch.mermaid` + root `CLAUDE.md`); the message broker is RabbitMQ (phase brief, "Decisões a tomar" item 1); the worker processes videos with FFmpeg (`software-arch.mermaid`: "Video Worker (FFmpeg)"). Inherited from Phase 02: global `JwtAuthGuard` with `@Public()` opt-out, `DomainException` + `DomainExceptionFilter` error envelope, class-validator DTOs, TypeORM migrations with `synchronize: false`, tests against the real Compose services.

**Documentation lookup:** library documentation for this research was retrieved from Context7 (REST API `context7.com/api/v1`, used because the Context7 MCP server is not configured in this session): `/nestjs/docs.nestjs.com` (branch 11.0.0, RabbitMQ transport), `/aws/aws-sdk-js-v3` (v3.1153.0), `/minio/docs`, `/rabbitmq/rabbitmq-website`, `/websites/golevelup_github_io_nestjs_modules_rabbitmq`, `/fluent-ffmpeg/node-fluent-ffmpeg`, `/websites/ffmpeg_documentation`. Registry facts (versions, deprecation flags) were checked with `npm view` inside the `nestjs-api` container.

---

## TD-01: RabbitMQ Client Integration

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** RabbitMQ is fixed as the broker. The API must publish processing jobs and the worker must consume them with manual acknowledgement (a crashed worker must not lose a job). The integration library shapes how producer and consumer are wired into NestJS DI, how queues are declared, and how acks/nacks are issued.

**Options:**

### Option A: `@nestjs/microservices` RMQ transport (official)
- Producer: `ClientsModule.register({ transport: Transport.RMQ, ... })` + `ClientProxy.emit(pattern, data)`. Consumer: `NestFactory.createMicroservice(..., { transport: Transport.RMQ, options: { noAck: false, queueOptions } })` + `@EventPattern` handlers; manual `channel.ack/nack` through `RmqContext.getChannelRef()`.
- **Pros:** Official NestJS package, same major as the installed `@nestjs/core` 11.1.x; documented in the NestJS 11 docs (manual ack, `queueOptions`, `RmqContext`). Producer and consumer share one options object. Queue arguments (quorum type, dead-letter) pass through `queueOptions`.
- **Cons:** Opinionated message envelope (`{ pattern, data }`); single-queue-per-server model (no exchange topology out of the box). Retry policy must be coded by hand in the handler.

### Option B: `@golevelup/nestjs-rabbitmq`
- Community module with `@RabbitSubscribe({ exchange, routingKey, queue })` handlers and `AmqpConnection.publish()`; exchange-based topology, built-in error handlers (nack/requeue strategies).
- **Pros:** Richer RabbitMQ semantics (exchanges, routing keys, RPC), declarative error behaviour.
- **Cons:** Third-party dependency outside the NestJS release train; exchange topology is more than one job type needs; its decorators require the module to be bootstrapped in a full Nest application context.

### Option C: Thin wrapper over `amqplib` / `amqp-connection-manager`
- Hand-written `QueueService` that opens a confirm channel, asserts the queue and exposes `publish()` / `consume()`.
- **Pros:** Total control over envelope, confirms and reconnection; no framework coupling.
- **Cons:** Re-implements connection management, DI wiring and graceful shutdown that Option A already provides; more code to test.

**Recommendation:** **Option A (`@nestjs/microservices` RMQ)** — it is the official path for the installed NestJS 11 stack, supports everything one job type needs (durable queue, manual ack, queue arguments), and keeps the producer and the worker on the same configuration object; the hand-coded retry policy is small (see TD-09).

**Decision:** A (`@nestjs/microservices` RMQ transport)

**Libraries:** @nestjs/microservices@11.1.16, amqplib@0.10.9, amqp-connection-manager@5.0.0, @types/amqplib@0.10.8

**Note:** Versions pinned to what the NestJS 11.1.x monorepo is built and tested with (`nestjs/nest` `package.json`: `amqplib` 0.10.9, `amqp-connection-manager` 5.0.0, `@types/amqplib` 0.10.8); `@nestjs/microservices` is kept in lockstep with the installed `@nestjs/core` 11.1.16. `amqplib` 2.x (new major line started 2026-05) is deliberately not adopted — Nest's RMQ transport is not tested against it. Broker image: `rabbitmq:4.1.8-management` (quorum queues, delivery limit, management UI on 15672).

---

## TD-02: Large File Upload Strategy (up to 10GB)

**Scope:** Backend

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** Files of up to 10GB must be uploaded without holding API resources for the duration of the transfer. `docs/project-plan.md` § Pontos de Atenção also requires that the upload can be resumed after a connection failure. The upload protocol defines the HTTP handshake between client, API and storage. The frontend that will drive it is out of scope in this phase, so the contract is published via OpenAPI only.

**Options:**

### Option A: Presigned S3 multipart upload (client → storage directly)
- The API pre-registers the video (draft), calls `CreateMultipartUpload` and returns `uploadId` + part size; the client asks the API for presigned `UploadPart` URLs, PUTs the parts straight to storage, then calls the API to `CompleteMultipartUpload`. Resume = ask the API which parts already exist (`ListParts`) and upload only the missing ones.
- **Pros:** No video byte crosses the API — API cost per upload is a handful of small JSON calls, independent of file size. Native S3 feature (works unchanged on MinIO and AWS S3). Resumable per part. Parts upload in parallel.
- **Cons:** Multi-step handshake on the client. The presigned URL host must be reachable by the client (public endpoint ≠ internal Compose host — see TD-03). Abandoned uploads leave incomplete multipart data until aborted.

### Option B: tus resumable protocol (`@tus/server` + S3 store)
- A tus server endpoint receives `PATCH` chunks and writes them to S3 through `@tus/s3-store`.
- **Pros:** Standard resumable protocol with mature client libraries; resume is built into the protocol.
- **Cons:** Every byte still flows through a Node process — 10GB per upload of API (or extra service) bandwidth and socket time; adds a new server component and its state.

### Option C: Streamed `multipart/form-data` through the API
- The API pipes the request stream (busboy) into an S3 `Upload` without buffering.
- **Pros:** Simplest client (one POST).
- **Cons:** Holds an API connection for the entire transfer; no resume; the API becomes the bandwidth bottleneck — exactly what the capability forbids.

**Recommendation:** **Option A (presigned multipart)** — it is the only option where the API is out of the data path, which is the literal requirement ("sem impacto na performance"), and S3 multipart gives per-part resume with no extra component. Parameters to carry into the plan: maximum size 10 GiB (10 737 418 240 bytes) declared at initiation and re-checked against the stored object size at completion; fixed part size of 64 MiB (≈160 parts for 10 GiB, well under the S3 limit of 10 000 parts and above the 5 MiB minimum); presigned part URLs expire after 1 hour and are re-requestable at any time.

**Decision:** A (Presigned S3 multipart upload)

**Libraries:** —

**Note (resolves AMB-1):** Initiation input is `fileName` (1–255 chars), `fileSize` (integer bytes, 1 … 10 737 418 240) and `contentType` (must start with `video/`), plus an optional `title` (1–100 chars). When `title` is omitted the draft title is the file name without its extension, truncated to 100 chars — Phase 04 owns title editing. The 10 GiB limit is enforced twice: by DTO validation at initiation and, at completion, by comparing the stored object size (`HeadObject`) with the declared `fileSize`; a mismatch aborts completion. `contentType` is only a first filter — `ffprobe` (TD-05) is the authoritative check that the file is a video.

**Depends on:** TD-03 (storage layout and public endpoint).

---

## TD-03: Object Storage Layout and Access Model

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The S3-compatible storage is fixed; how it is organized is not. The choice defines bucket(s), object key scheme, how clients reach objects (public vs presigned), how the bucket is provisioned in Docker, and the canonical environment keys shared by the Joi schema, `compose.yaml`, `.env.example`, the API and the worker. Inside Compose, services reach MinIO at `minio:9000`, while a client outside Docker (browser, curl on the host) must use the published host port — and S3 SigV4 signs the host, so presigned URLs must be generated against the endpoint the client will use.

**Options:**

### Option A: Single private bucket, keys by video id, presigned access, dual endpoint
- One bucket (`streamtube-videos`), keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. No public policy; every client read or write uses a short-lived presigned URL. Two endpoint settings: `S3_ENDPOINT` (internal, used by the API/worker for server-side calls) and `S3_PUBLIC_ENDPOINT` (used only to sign URLs handed to clients). The bucket is created by a one-shot `mc` init container in Compose.
- **Pros:** All objects of a video live under one prefix (deletion and cost accounting by prefix). Private by default — access policy stays in the API. Works identically on AWS S3 (only endpoints and credentials change).
- **Cons:** Two endpoint settings to keep consistent; every read needs an API round-trip to obtain a signed URL.

### Option B: Two buckets (`videos` private, `thumbnails` public-read)
- Originals stay private behind presigned URLs; thumbnails are served by a public-read bucket policy.
- **Pros:** Thumbnails can be embedded without a signed URL (useful for future listing pages).
- **Cons:** Two lifecycles/policies to manage; public-read is a decision for the listing phases (04/07), not needed by any Phase 03 capability.

### Option C: Keys prefixed by channel (`channels/{channelId}/videos/{videoId}/...`)
- Same as A but grouped by owner.
- **Pros:** Per-channel storage accounting by prefix.
- **Cons:** Ownership changes or channel deletion force key rewrites; the video id is already globally unique, so the extra level only adds coupling.

**Recommendation:** **Option A** — one private bucket with video-id prefixes keeps the access policy in a single place (the API) and maps 1:1 to S3 in production. Canonical env keys: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`; path-style addressing (`forcePathStyle: true`) for MinIO. Client SDK: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (AWS SDK v3, the official S3 client; the same code targets MinIO and S3).

**Decision:** A (Single private bucket, video-id keys, presigned access, dual endpoint)

**Libraries:** @aws-sdk/client-s3@3.1152.0, @aws-sdk/s3-request-presigner@3.1152.0

**Note:** MinIO image source verified on 2026-11-02: `minio/minio` and `minio/mc` are no longer pullable from Docker Hub ("pull access denied … repository does not exist") and `quay.io/minio/*` returns 401. The Compose service therefore uses `cgr.dev/chainguard/minio` (MinIO RELEASE.2026-10-23T20-06-51Z built from source) and the bucket init uses `cgr.dev/chainguard/minio-client`; both are pinned by digest because the free Chainguard tier publishes only `latest`. The S3 API is unchanged, so the decision and its production mapping to AWS S3 stand. AWS SDK pinned to 3.1152.0 (released 2026-10-14) — the latest release older than two weeks.

---

## TD-04: Video Worker Runtime Topology

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Video processing is CPU-heavy and must not run in the API process. The worker needs the `videos` table, the storage client, the queue consumer and the FFmpeg binaries. Where its code lives and how it runs determines code reuse, the Docker setup and how tests exercise it.

**Options:**

### Option A: Second entrypoint of the same NestJS project, separate Compose service
- `nestjs-project/src/worker.ts` bootstraps a NestJS RMQ microservice with a dedicated `WorkerModule` (reusing the `Video` entity, storage service and config). Compose adds a `video-worker` service built from the same dev image (now with `ffmpeg`), running only that entrypoint.
- **Pros:** Single codebase: entity, config, storage client and test helpers are shared, no duplicated contracts. Process/container isolation from the API (CPU, crashes, scaling by replicas). Tests in the `nestjs-api` container can boot the worker module in-process because the image has FFmpeg.
- **Cons:** The image carries FFmpeg for the API too (dev only; a production image split is a Phase 07 concern). Two processes compile from the same source tree, so their build outputs must not collide.

### Option B: Separate subproject (`video-worker/`) with its own `package.json`
- Standalone Node service with its own dependencies and Dockerfile.
- **Pros:** Independent dependency set and image; clear deployment boundary.
- **Cons:** Duplicates the entity/schema knowledge and the storage client; a new subproject with its own lint/test/tsc pipeline; the schema contract between API and worker drifts silently.

### Option C: Consumer inside the API process
- The API registers the RMQ microservice via `connectMicroservice()` and processes jobs itself.
- **Pros:** Zero new runtime components.
- **Cons:** FFmpeg runs on the API's CPU — directly contradicts "sem impacto na performance"; no independent scaling.

**Recommendation:** **Option A** — container isolation gives the performance guarantee, while one codebase keeps entity and message contracts compile-time checked on both sides; the build-output collision is solved with a dedicated tsconfig/out dir for the worker.

**Decision:** A (Second entrypoint of the NestJS project, separate Compose service)

**Libraries:** —

**Depends on:** TD-01.

---

## TD-05: Media Probing and Thumbnail Extraction

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must extract duration and technical metadata and render one frame as the thumbnail. The source object can be 10GB, so how FFmpeg reads it (full download vs ranged reads) matters as much as how Node invokes FFmpeg.

**Options:**

### Option A: `ffprobe`/`ffmpeg` CLI via `node:child_process` reading a presigned URL
- `ffprobe -v error -print_format json -show_format -show_streams <url>` for metadata; `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=... -f image2 pipe:1` for the thumbnail, then `PutObject`. `<url>` is a presigned GET URL against the internal endpoint; FFmpeg's HTTP input issues Range requests, so only the container header/index and the frames around the seek point are read.
- **Pros:** No temp copy of a 10GB file; no wrapper library; JSON output parsed with typed DTOs; arguments passed as an array (`execFile`/`spawn`, no shell).
- **Cons:** Error handling of CLI exit codes/stderr must be written; FFmpeg must be in the image.

### Option B: `fluent-ffmpeg` wrapper
- Fluent API over the same binaries (`ffprobe()`, `screenshots()`).
- **Pros:** Convenience API.
- **Cons:** The npm package is flagged deprecated ("Package no longer supported", checked with `npm view fluent-ffmpeg deprecated`) — not acceptable for new code.

### Option C: Download the object to local disk, then run FFmpeg on the file
- Stream the object to a temp file, process it, delete it.
- **Pros:** Local-file seeks are fastest and avoid HTTP edge cases.
- **Cons:** Up to 10GB of disk and transfer per job just to read headers and one frame; worker disk becomes a capacity constraint.

**Recommendation:** **Option A** — ranged reads make metadata and thumbnail cost proportional to what is read, not to file size, and calling the binaries directly avoids a deprecated wrapper. Thumbnail frame: the frame at 10% of the duration (clamped to the first frame for very short or duration-less inputs), JPEG, scaled to 1280 px wide preserving aspect ratio. Any `ffprobe` failure or a file without a video stream is a processing failure (see TD-09).

**Decision:** A (ffprobe/ffmpeg CLI over a presigned URL)

**Libraries:** ffmpeg (Debian bookworm `apt` package in `Dockerfile.dev`, provides `ffmpeg` + `ffprobe`)

**Note (resolves AMB-2):** Persisted technical metadata, as typed nullable columns on the video row (queryable by later phases, e.g. duration on listings): `duration_seconds` (numeric, 3 decimals), `width`, `height` (integers), `video_codec`, `audio_codec` (nullable — silent videos), `container_format` (strings), `bitrate` (bigint, bits/s) and `size_bytes` (bigint, from the stored object). Values come from `ffprobe -show_format -show_streams` (first video stream, first audio stream).

**Depends on:** TD-03 (internal endpoint for presigning), TD-04.


**Revisions:**
- 2026-11-02 — Thumbnail scaled to `min(1280, source width)` instead of always 1280 px wide (no upscaling of smaller sources). Rationale: upscaling adds bytes without adding detail; aspect ratio and the JPEG/frame-at-10% choice are unchanged.
---

## TD-06: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short public identifier used in its URL that never collides with another video (`docs/project-plan.md` § Pontos de Atenção: "URL curta e única"). It must not leak ordering or volume, and it must be guaranteed unique at the database level.

**Options:**

### Option A: 11-character random base64url id (`node:crypto`) + unique constraint + retry
- `randomBytes(8)` → base64url → 11 chars (64 bits of entropy). Stored in a `UNIQUE` column; on a unique-violation the insert retries with a new id (bounded attempts), mirroring the nickname retry pattern in `ChannelsService`.
- **Pros:** Short, URL-safe, unguessable, non-sequential; uniqueness enforced by the database, not by probability; no dependency.
- **Cons:** A second identifier beside the UUID primary key; a retry loop for an astronomically rare collision.

### Option B: UUID primary key in the URL
- Use the existing UUID `id` directly.
- **Pros:** No extra column or generation logic.
- **Cons:** 36 characters — not "curta"; exposes the internal primary key.

### Option C: Sqids/Hashids encoding of a sequential integer
- Encode an auto-increment id into a short string.
- **Pros:** Very short, deterministic, collision-free by construction.
- **Cons:** Reversible encoding leaks creation order and volume; requires a sequence column and a new dependency.

**Recommendation:** **Option A** — it meets "curta e única" with database-enforced uniqueness and no new dependency, and keeps the UUID as the internal key.

**Decision:** A (11-char random base64url id + unique constraint + retry)

**Libraries:** —

---

## TD-07: Streaming and Download Delivery

**Scope:** Backend

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file, which requires HTTP Range requests answered with `206 Partial Content`. Download must deliver the file as an attachment. The delivery path decides whether video bytes flow through the API.

**Options:**

### Option A: API redirect (`302`) to a short-lived presigned GET URL
- `GET /videos/{publicId}/stream` and `GET /videos/{publicId}/download` authorize the request, then redirect to a presigned URL; storage answers Range requests with `206`. The download URL is signed with `response-content-disposition=attachment; filename=...`.
- **Pros:** Video bytes never cross the API (same principle as TD-02); Range/206, `Accept-Ranges`, `ETag` are native to S3/MinIO; works with `<video>` and download managers.
- **Cons:** The signed URL is a bearer link until it expires (mitigated by a short expiry); requires the public endpoint from TD-03.

### Option B: API proxies bytes, forwarding the Range header
- The API calls `GetObject` with the client's `Range` and pipes the body back with `206`.
- **Pros:** Storage never exposed to clients; one stable URL.
- **Cons:** Every streamed byte consumes API bandwidth and sockets — the playback load lands on the API.

### Option C: HLS/DASH segmented streaming
- The worker transcodes to segments + playlist; players fetch segments.
- **Pros:** Adaptive bitrate.
- **Cons:** Transcoding is not a Phase 03 capability and multiplies worker CPU and storage; progressive Range playback already satisfies "sem necessidade de download completo".

**Recommendation:** **Option A** — storage serves `206 Partial Content` natively and the API stays out of the data path; presigned stream/download URLs expire after 1 hour (enough to start playback; the client re-requests the API endpoint for a fresh redirect).

**Decision:** A (302 redirect to a short-lived presigned GET URL)

**Libraries:** —

**Depends on:** TD-03, TD-06.

---

## TD-08: Access Policy for Upload, Playback and Download

**Scope:** Backend

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário; URL única por vídeo, sem conflito com outros vídeos

**Context:** Phase 03 introduces videos owned by channels but not yet the publication flow or visibility (`draft → publicação`, `público/unlisted` are Phase 04 bullets). The project overview states anonymous users can watch freely. Phase 03 must still define who can start/resume/complete an upload and who can stream/download, because no skill or prior TD resolves it and it drives the Authorization Matrix.

**Options:**

### Option A: Owner-only upload operations; playback/download public by unique id when `ready`
- Upload endpoints require JWT and that the video belongs to the caller's channel. Stream/download endpoints are `@Public()` and resolve by the unguessable public id, only for videos whose processing finished (`ready`). Phase 04 adds the publication/visibility gate on top.
- **Pros:** Matches "anonymous can watch" and makes the unique URL the sharing primitive; unfinished or failed videos are never served.
- **Cons:** Until Phase 04 adds publication, a ready video is reachable by anyone holding its link (unlisted-like behaviour).

### Option B: Everything owner-only until Phase 04
- Stream/download also require JWT + ownership.
- **Pros:** Nothing is reachable anonymously before the publication flow exists.
- **Cons:** Contradicts anonymous viewing; the unique URL has no use outside the owner; Phase 04/05 would have to reopen this decision.

**Recommendation:** **Option A** — it is the coherent reading of the project's anonymous-viewing rule with the capabilities available in Phase 03; the residual exposure is limited to holders of a 64-bit random link, and Phase 04 owns the publication gate. Ownership failures on upload endpoints return 404 (not 403) so that video ids of other channels are not disclosed.

**Decision:** A (Owner-only upload operations; public playback/download by unique id when ready)

**Libraries:** —

**Note (resolves ICC-1):** The video controller opts out of the inherited global `ThrottlerGuard` with `@SkipThrottle()` at class level — the same mechanism `AppController` already uses. Rationale: phase-02-auth/TD-08's 10 req/min limit protects credential endpoints against brute force; upload orchestration is authenticated and ownership-checked, a single 10GB upload legitimately needs dozens of calls, and playback re-requests redirects. phase-02-auth/TD-08 itself is unchanged for auth endpoints.

---

## TD-09: Video Status Lifecycle and Processing Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The phase brief requires a status cycle `rascunho → processando → pronto/erro` persisted in the database, and a defined behaviour when processing fails. Failures can be transient (storage or database briefly unavailable) or permanent (corrupted file, no video stream).

**Options:**

### Option A: Four statuses + bounded retries in the worker, then `failed`
- `draft` (pre-registered, upload in progress) → `processing` (upload completed, job queued) → `ready` | `failed`. The worker retries a failing job by `nack` with requeue up to 3 deliveries (RabbitMQ quorum queue delivery count), then persists `failed` with a reason and acks. The queue's `x-delivery-limit` + dead-letter queue catch messages that crash the consumer repeatedly (poison messages).
- **Pros:** Transient errors self-heal; permanent errors end in an explicit, queryable state with a reason; nothing loops forever.
- **Cons:** A permanent error costs 3 attempts; retries are immediate (no backoff).

### Option B: Fail fast — first error marks `failed`
- **Pros:** Simplest; no retry bookkeeping.
- **Cons:** A storage hiccup permanently fails a valid 10GB upload, forcing a re-upload.

### Option C: Delayed retries with a TTL retry queue + DLX
- Failed messages go to a retry queue with `x-message-ttl`, dead-letter back to the main queue after the delay; after N attempts → `failed`.
- **Pros:** Backoff between attempts.
- **Cons:** Extra queues and topology to declare and test; the delay benefit is marginal for a single local worker.

**Recommendation:** **Option A** — it satisfies the required cycle with an explicit terminal error state and bounded self-healing using only quorum-queue features. An upload that is never completed stays `draft` and can be cancelled by its owner (abort the multipart upload and delete the record); `ready` and `failed` are terminal in Phase 03.

**Decision:** A (draft/processing/ready/failed + bounded retries, then failed)

**Libraries:** —

**Depends on:** TD-01, TD-10.

---

## TD-10: Consistency Between Database State and Job Publication

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Completing an upload must both change the video status and publish a processing job. The database and the broker cannot share a transaction, so a crash between the two can leave a video stuck (`processing` with no job) or a job for a video in an unexpected state.

**Options:**

### Option A: Publish with broker confirmation, then commit status; idempotent endpoint and consumer
- On completion the API publishes the job (waiting for the publisher confirm) and then sets `processing`. If publishing fails, the request fails with 503 and the status stays `draft`, so the client simply retries completion (completion is idempotent: an already-completed multipart upload is detected by the stored object). The worker only acts on videos in `draft`/`processing` and ignores jobs for `ready`/`failed` videos, so duplicate jobs are harmless.
- **Pros:** No new table or relay process; every failure mode is recoverable by a client retry; duplicates are safe by construction.
- **Cons:** Relies on the client retrying a failed completion; a job can briefly arrive before the status commit (handled by the worker accepting `draft`).

### Option B: Transactional outbox
- The status change and an `outbox` row commit together; a relay publishes pending rows and marks them sent.
- **Pros:** Exactly-once hand-off from database to broker without client cooperation.
- **Cons:** New table, a polling relay and its own failure handling — infrastructure heavier than one job type needs.

### Option C: Worker polls the database (no broker message)
- **Pros:** Single source of truth.
- **Cons:** Abandons the queue that the architecture and the phase brief require.

**Recommendation:** **Option A** — an idempotent completion endpoint plus an idempotent consumer covers every crash window with no extra infrastructure; the outbox would be justified only if jobs were produced where no client can retry.

**Decision:** A (Confirmed publish + idempotent completion endpoint and consumer)

**Libraries:** —

**Depends on:** TD-01.

---

## TD-11: Testing Strategy for Storage, Queue and Worker

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The phase brief requires that storage, queue and worker are exercised by tests against real infrastructure ("Não mocke o que dá para testar de verdade com a infra do Compose"). Phase 02 already tests against the shared Compose PostgreSQL and Mailpit. Integration/e2e tests also run while the `video-worker` container may be consuming the same queue, which would make test outcomes depend on another process.

**Options:**

### Option A: Real Compose services, test-scoped queue, worker booted in-process
- Integration/e2e tests use the real MinIO and RabbitMQ services. Tests set a test-only queue name (e.g. `video-processing.test`) so the running `video-worker` container never consumes them, and boot the worker module inside the Jest process. Test videos are generated on the fly with FFmpeg (`lavfi` test source), no binary fixtures in git. Presigned URLs in tests are signed against the internal endpoint because the test client runs inside the Compose network.
- **Pros:** Exercises the real S3 multipart flow, Range/206 responses, broker confirms and FFmpeg; deterministic (no foreign consumer); consistent with the Phase 02 approach.
- **Cons:** Slower suites; requires FFmpeg in the dev image (TD-04).

### Option B: Testcontainers per suite
- **Pros:** Full isolation per run.
- **Cons:** Needs Docker-in-Docker from inside the dev container; diverges from the existing shared-Compose test pattern.

### Option C: Mock S3 and AMQP clients
- **Pros:** Fast unit-style tests.
- **Cons:** Explicitly rejected by the phase brief for anything testable with the Compose infra; would not catch signature/host or confirm-channel issues.

**Recommendation:** **Option A** — it is the only option that honours the brief and the Phase 02 pattern while keeping results deterministic. Unit tests still mock collaborators where the logic is pure (state transitions, retry decisions, id generation), per the testing guide.

**Decision:** A (Real Compose services, test-scoped queue, worker booted in-process)

**Libraries:** —

**Note (resolves IC-1):** For object storage this supersedes, for Phase 03 onward, the testing guide's "Local filesystem storage in development and tests" strategy (`references/external-systems.md`), which predates any storage decision. No filesystem storage adapter is built: development and tests both use the MinIO Compose service, as the phase brief requires. The guide's queue strategy (real broker, dedicated test queues) is followed as written.

**Depends on:** TD-04.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | RabbitMQ Client Integration | A — `@nestjs/microservices` RMQ transport | A (`@nestjs/microservices` RMQ transport) |
| TD-02 | Backend | Large File Upload Strategy (up to 10GB) | A — Presigned S3 multipart upload | A (Presigned S3 multipart upload) |
| TD-03 | Backend | Object Storage Layout and Access Model | A — Single private bucket, video-id keys, presigned access, dual endpoint | A (Single private bucket, video-id keys, presigned access, dual endpoint) |
| TD-04 | Backend | Video Worker Runtime Topology | A — Second entrypoint of the NestJS project, separate Compose service | A (Second entrypoint of the NestJS project, separate Compose service) |
| TD-05 | Backend | Media Probing and Thumbnail Extraction | A — ffprobe/ffmpeg CLI over a presigned URL | A (ffprobe/ffmpeg CLI over a presigned URL) |
| TD-06 | Backend | Unique Video URL Identifier | A — 11-char random base64url + unique constraint | A (11-char random base64url id + unique constraint + retry) |
| TD-07 | Backend | Streaming and Download Delivery | A — 302 redirect to presigned GET (storage serves 206) | A (302 redirect to a short-lived presigned GET URL) |
| TD-08 | Backend | Access Policy for Upload, Playback and Download | A — Owner-only upload; public playback/download by id when ready | A (Owner-only upload operations; public playback/download by unique id when ready) |
| TD-09 | Backend | Video Status Lifecycle and Failure Handling | A — draft/processing/ready/failed + bounded retries | A (draft/processing/ready/failed + bounded retries, then failed) |
| TD-10 | Backend | DB State vs Job Publication Consistency | A — Confirmed publish + idempotent endpoint and consumer | A (Confirmed publish + idempotent completion endpoint and consumer) |
| TD-11 | Backend | Testing Strategy for Storage, Queue and Worker | A — Real Compose services, test-scoped queue, in-process worker | A (Real Compose services, test-scoped queue, worker booted in-process) |
