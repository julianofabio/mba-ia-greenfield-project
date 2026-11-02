# phase-03-videos — Progress

**Status:** completed
**SIs:** 13/13 completed

## Setup and execution notes

- **Git Flow:** no local `dev` existed and `origin/dev` was 41 commits behind `main` (ancestor, no divergence). Local `dev` was created from `origin/dev` and fast-forwarded to `main` (no merge commit, `main` untouched), then `feature/phase-03-videos` was branched from it. Nothing was pushed.
- **Context7:** the Context7 MCP server is not configured in this session (`.mcp.json` only has `postgres`). Library documentation was fetched from the same Context7 index through its REST API (`https://context7.com/api/v1`). See `library-refs.md`.
- **Pipeline subagents:** only `plan-reader` and `decisions-detail-reader` are registered agent types in this session; the other read-only subagents used by `plan-context`/`plan-resolve` (`decisions-reader`, `decisions-correlator`, `phases-reader`) were emulated in the main thread following their output contracts.
- **Autonomy:** per the phase brief, `plan-resolve` decisions (normally asked via `AskUserQuestion`) and the `plan-build` A5 pause were decided by the agent, with rationale recorded in the decisions doc notes and `validation.md`. `/implement` runs in continuous mode (brief: "sem pedir confirmação").
- **Test execution:** SI tests are run directly in the `nestjs-api` container (output filtered to failures/summary) instead of one subagent per SI; `TaskCreate` is not available in this session, so this file is the only SI tracker.
- **Local environment (not committed):** host ports 3000/5432 are taken by another Compose stack on this machine, so the stack runs with a local override (`3010:3000`, `5433:5432`); `.env` was created from `.env.example` with the `MAIL_FROM` value quoted (see follow-ups).
- **MinIO images:** `minio/minio` and `minio/mc` are no longer pullable from Docker Hub, and `quay.io/minio/*` returns 401 (verified 2026-11-02). Compose uses `cgr.dev/chainguard/minio` and `cgr.dev/chainguard/minio-client` pinned by digest (`phase-03-videos/TD-03` note).

## Baseline (before any Phase 03 code)

- `npm test -- --runInBand`: 2 suites / 5 tests failing (`auth.service.integration-spec.ts`, `migrations.integration-spec.ts`); `npm run test:e2e`: 3 suites / 49 tests failing. Root causes: Jest's 5 s hook timeout (booting `AppModule` from the bind-mounted `node_modules` takes longer on Docker Desktop for Windows); `migrations.integration-spec.ts` dropped tables but not `verification_tokens_type_enum`, so `CreateAuthTokens` failed and left the shared DB without token tables (cascading into the 45 `auth.e2e` failures); 150 pre-existing lint errors. Fixed on `bugfix/baseline-test-suite` (merged `--no-ff` into `dev`, then `dev` into this branch): lint 0 errors, tsc 0, 144/144 unit+integration, 52/52 e2e.

## Final verification

Run inside `nestjs-api` on `feature/phase-03-videos` after SI-03.13:

- `npm test -- --runInBand`: 42 suites / 267 tests passing
- `npm run test:e2e`: 5 suites / 69 tests passing
- `npx tsc --noEmit`: exit 0
- `npm run lint`: 0 errors (44 warnings — `no-unsafe-argument` / `no-floating-promises`, configured as warnings)
- `npm run build` and `npm run build:worker`: success (`dist/main.js`, `dist-worker/worker.js`)
- Host smoke test against the running stack (compiled API + `video-worker` container): register/login → `POST /videos` → `PUT` of the part to the presigned `localhost:9000` URL → complete (202) → `ready` processed by the container worker (4 s, 640x360, h264/aac, JPEG thumbnail) → `/stream` 302 + `Range` 206 → `/download` attachment, byte-identical.

## Follow-ups (out of scope)

- `nestjs-project/.env.example`: `MAIL_FROM="StreamTube" <noreply@streamtube.com>` breaks `docker compose` env parsing — must be quoted as a whole (`'"StreamTube" <noreply@streamtube.com>'`).
- `next-frontend/.env.example` is referenced by the README but does not exist.
- Password-reset e-mail link points to `{APP_URL}/auth/reset-password`, which is a `POST`-only API route.
- `ChannelsService` keeps a local copy of the Postgres unique-violation helper; Phase 03 adds `src/common/database/pg-errors.ts` — migrating `ChannelsService` to it is a separate refactor.

- `openapi:export` (`ts-node`) skips the `@nestjs/swagger` CLI plugin, so request DTO schemas in `nestjs-project/openapi.json` are empty (`"properties": {}`) for all modules — export through a build that applies the plugin (or the `PluginMetadataGenerator`).

## SIs

### SI-03.1 — Infra: dependências, FFmpeg e serviços de storage e fila no Compose
- **Status:** completed
- **Tests:** no tests (Infra) — ACs verified manually: `ffprobe` 5.1.9 in `nestjs-api`; `minio-init` exit 0 and bucket `streamtube-videos` listed (idempotent on a second `up`); `rabbitmq-diagnostics -q ping` OK; management UI HTTP 200; pinned versions in `npm ls`
- **Observations:**
  - New dependencies saved with `--save-exact` to honor the `library-refs.md` pins (keeps `amqplib` off the 2.x line).
  - The Chainguard MinIO image ships `mc` but no `curl`/`wget`; the healthcheck is `mc ready local` via `MC_HOST_local`. The `minio-client` image has no shell, so `minio-init` runs `mc mb --ignore-existing` with `MC_HOST_local` instead of an alias-setup script.

### SI-03.2 — Namespaces de configuração de storage e mensageria
- **Status:** completed
- **Tests:** 12/12 passing (env.validation.integration-spec.ts); app.e2e-spec.ts 1/1 with the new config loaded; `tsc` 0
- **Observations:**
  - `RABBITMQ_URL` is validated as a URI restricted to the `amqp`/`amqps` schemes.
  - The local (git-ignored) `.env` received the same keys appended to `.env.example`.

### SI-03.3 — Serviço de object storage
- **Status:** completed
- **Tests:** 8/8 passing (storage.service.integration-spec.ts against the MinIO Compose service, storage.module.spec.ts)
- **Observations:**
  - `presignGetObject` also emits an RFC 5987 `filename*=UTF-8''…` parameter after the ASCII `filename="…"`, so non-ASCII original names survive the download.
  - `headObject` returns `null` on 404 (absence is a valid result for the idempotent completion check in SI-03.7); other S3 errors propagate.

### SI-03.4 — Entidade Video e migration CreateVideos
- **Status:** completed
- **Tests:** 6/6 passing (video.entity.integration-spec.ts, migrations.integration-spec.ts — apply 3 migrations / revert CreateVideos)
- **Observations:**
  - Migration generated by the TypeORM CLI (`1793632304936-CreateVideos.ts`); the diff contained only the `videos` table, enum, index and FK.
  - `migrations.integration-spec.ts` dropped tables with `Promise.all` on several pool connections; with the new `videos` → `channels` FK the concurrent CASCADE drops deadlocked and left the shared DB without tables. Drops are now sequential.
  - Relation kept unidirectional (`Video` → `Channel`) as planned, against the `nestjs-entities.md` "both sides" rule: a `Channel.videos` `@OneToMany` would break every existing test `DataSource` that lists `Channel` without `Video` (missing entity metadata).
  - `numericColumnTransformer` (`src/common/database/`) maps `bigint`/`numeric` strings from `pg` to numbers.
  - The entity test uses the migrated schema (`synchronize: false`) instead of synchronize, so it also checks the migration matches the entity.

### SI-03.5 — Identificador público do vídeo e busca de canal por usuário
- **Status:** completed
- **Tests:** 40/40 passing (public-id.util.spec.ts, pg-errors.spec.ts, channels.service.integration-spec.ts + the rest of `src/channels` as regression)
- **Observations:**
  - `isPgUniqueViolationOnColumn` matches the `(column)` token of the pg `detail` (`Key (public_id)=…`) instead of a bare substring, so `id` does not match `public_id`.

### SI-03.6 — Topologia da fila e publicação do job de processamento
- **Status:** completed
- **Tests:** 4/4 passing (video-processing.publisher.integration-spec.ts against RabbitMQ, videos.module.spec.ts)
- **Observations:**
  - Installed `@nestjs/microservices@11.1.16` defaults are `noAck: true` and `persistent: false` (`constants.js`), so both are set explicitly.
  - The planned single `buildVideoProcessingRmqOptions` was split into `buildVideoProcessingClientOptions` (producer: queue contract + `persistent: true`) and `buildVideoProcessingServerOptions` (consumer: + `noAck: false`, `prefetchCount: 1`), sharing one queue-contract function. With `noAck: false` on the client, Nest's reply consumer on `amq.rabbitmq.reply-to` is rejected by the broker (406 PRECONDITION_FAILED) and every publish fails.
  - Queue type/arguments are asserted through the RabbitMQ management API (`/api/queues/%2F/<queue>`).

### SI-03.7 — Orquestração do upload no VideosService
- **Status:** completed
- **Tests:** 35/35 passing (upload-plan.spec.ts, videos.service.spec.ts: 26 unit; videos.service.integration-spec.ts: 9 against PostgreSQL + MinIO + RabbitMQ)
- **Observations:**
  - `completeUpload` clears `upload_id`/stores `size_bytes` only after the publish succeeds: if the broker does not confirm, the draft keeps its `upload_id`, so both a retried completion (`NoSuchUpload` + `HeadObject` path) and a cancellation still work. The `draft → processing` update is conditional on `status = draft` because the worker may already have taken the job.
  - The video id is generated in the service (`randomUUID`) so `storage_key` is known at insert time; the `public_id` retry reuses the same id.
  - `isNoSuchUploadError` lives in `src/storage/storage.errors.ts` (S3 error classification belongs to the storage module).

### SI-03.8 — Endpoints de upload de vídeo
- **Status:** completed
- **Tests:** 12/12 passing (video-response.mapper.spec.ts 2; spec-derived `test/videos-upload.e2e-spec.ts` 10 — covers ACs #1–#10)
- **Observations:**
  - `@ApiBearerAuth('access-token')` is applied per method, not on the class, so the public stream/download routes of SI-03.12 are not advertised as authenticated (`nestjs-controllers.md`).
  - Shared e2e bootstrap in `test/support/e2e-app.ts` (AppModule + `main.ts` globals; user created through `/auth/register` + DB confirmation + `/auth/login`; throttle storage cleared per test).
  - The exported `openapi.json` shows empty request DTO schemas for every module (Phase 02 included): `openapi:export` runs through `ts-node`, which does not apply the `@nestjs/swagger` CLI plugin. Response DTOs here declare `@ApiProperty` explicitly, so they are complete. Follow-up recorded below.

### SI-03.9 — Extração de metadados e frame com FFmpeg
- **Status:** completed
- **Tests:** 15/15 passing (ffprobe-output.parser.spec.ts 9; media-probe.service.integration-spec.ts 6 with the real FFmpeg 5.1 and MinIO)
- **Observations:**
  - Test media is generated on the fly by `src/test/video-fixtures.ts` (`lavfi` `testsrc` + `sine`, libx264/AAC) — no binary fixtures in git; reused by the worker and playback tests.
  - The probe through a presigned internal MinIO URL returns exactly the same metadata as the local file (Range reads), confirming TD-05's no-download approach.
  - `execFile` runs with a 5-minute timeout and a 32 MiB stdout cap, so a stalled remote read cannot hang the worker forever.

### SI-03.10 — Processamento do vídeo no worker
- **Status:** completed
- **Tests:** 21/21 passing (processing-attempts.spec.ts, video-processing.service.spec.ts, video-processing.module.spec.ts, video-processing.service.integration-spec.ts with PostgreSQL + MinIO + FFmpeg)
- **Observations:**
  - Both the `ready` and the `failed` transitions are conditional on a non-terminal status (`draft`/`processing`), so a late `markFailed` never overwrites a `ready` video and a duplicate job never reprocesses one (covered by integration tests).
  - `duration_seconds` is rounded to 3 decimals before persisting (`numeric(10,3)`).

### SI-03.11 — Worker de vídeo: consumidor da fila, entrypoint e serviço no Compose
- **Status:** completed
- **Tests:** 4/4 passing (worker.module.spec.ts; video-processing.consumer.integration-spec.ts — worker booted in-process on the test queue: job → `ready`; failing job delivered 3 times → `failed` with the ffprobe reason and the queue drained; malformed payload → DLQ). Compose ACs verified: `video-worker` logs `Consuming "video-processing" (DLQ "video-processing.dlq")` and `rabbitmqctl list_consumers` shows the consumer with `ack_required=true`, `prefetch_count=1`.
- **Observations:**
  - RabbitMQ 4.1 increments `x-delivery-count` on `nack(requeue=true)` for quorum queues, so the attempt counter works as planned (verified by the 3-delivery test).
  - Two wiring bugs caught by the new tests/container run: the consumer controller must live in `VideoProcessingModule` (owner of `VideoProcessingService`), and the worker must import `UsersModule` so `autoLoadEntities` also registers `Channel`/`User` (`Video` → `Channel` → `User` relations).
  - TypeORM runtime options were extracted to `src/database/typeorm-options.ts` and reused by `AppModule` and `WorkerModule` instead of duplicating the factory.
  - Worker builds to `dist-worker/` (`tsconfig.worker.json`); `dist-worker` is excluded from `tsconfig.json`, `tsconfig.build.json` and git.
  - Malformed payloads (no `videoId`) are `nack`ed without requeue → dead-lettered, instead of being retried.
  - Environment: on Docker Desktop for Windows, host edits through the bind mount do not reach the container's file watcher, so `start:worker:dev` (like the API's `start:dev`) needs `docker compose restart video-worker` after code changes; a cold watch compile takes several minutes on this host.

### SI-03.12 — Endpoints de consulta, streaming e download
- **Status:** completed
- **Tests:** 28/28 passing (videos.service.spec.ts 21 incl. 6 new owner/playback cases; spec-derived `test/videos-playback.e2e-spec.ts` 7 — ACs #1–#7, full flow upload → in-process worker → `ready` → 302 → `206 Partial Content` / attachment download)
- **Observations:**
  - Stream/download use `@Redirect()` with a dynamic `{ url, statusCode: 302 }` and `@Header('Cache-Control', 'no-store')`; they are `@Public()` and carry no `@ApiBearerAuth`.
  - Malformed public ids are rejected before any query and answer exactly like unknown ones (same 404 body).

### SI-03.13 — Spec OpenAPI exportada e documentação de IA
- **Status:** completed
- **Tests:** 10/10 passing (openapi-export.integration-spec.ts, incl. the new video-routes assertion)
- **Observations:**
  - `nestjs-project/openapi.json` regenerated: 8 video operations across 7 paths. The public-id path parameter is named `{publicId}` (Nest route param) where the plan's API Contracts wrote `{public_id}` — same route, wire fields stay snake_case.
  - `nestjs-project/CLAUDE.md`: service list, readiness checks for RabbitMQ/MinIO, and a "Videos (Phase 03)" section (modules, endpoints, lifecycle, queue/worker/retry, storage, testing, operations). Root `CLAUDE.md`: Message Queue is RabbitMQ (no longer "TBD"), worker entrypoint, and the API's role in uploads corrected (it signs URLs; bytes go straight to storage). Every file, script and Compose service cited was checked to exist.
