# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **RabbitMQ:** `docker compose exec rabbitmq rabbitmq-diagnostics -q ping` — expect `Ping succeeded`
- **MinIO:** `docker compose exec minio mc ready local` — expect ready; `minio-init` must show `Exited (0)` (bucket `streamtube-videos` created)

The `video-worker` service starts with the stack (it is infrastructure for video processing, not the API server); it waits for `node_modules` and then runs `npm run start:worker:dev`.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture, ports `1025` (SMTP) / `8025` (UI)
- `rabbitmq` — RabbitMQ 4.1, port `5672` (AMQP) / `15672` (management UI), user/password `streamtube`
- `minio` — S3-compatible object storage (`cgr.dev/chainguard/minio`, pinned by digest — `minio/minio` is no longer on Docker Hub), ports `9000` (S3 API) / `9001` (console), user/password `streamtube` / `streamtube-secret`
- `minio-init` — one-shot `mc mb --ignore-existing local/streamtube-videos`
- `video-worker` — video processing worker (same image/source as the API, entrypoint `src/worker.ts`)

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.
- `testTimeout: 60000` (both configs) — booting `AppModule` from the bind-mounted `node_modules` can exceed Jest's 5 s default on Docker Desktop for Windows/macOS.
- `test:e2e` passes `--runInBand` — e2e suites share the database with the integration suites.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings. In test files (`*.spec.ts`, `*.integration-spec.ts`, `*.e2e-spec.ts`) the `no-unsafe-assignment`/`-member-access`/`-call`/`-return` and `unbound-method` rules are off (untyped supertest bodies, `any` mocks, `expect(mock.fn)`); production code keeps them as errors

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos (Phase 03 — upload, processing, streaming)

Plan and decisions: `docs/phases/phase-03-videos/phase-03-videos.md`, `docs/decisions/technical-decisions-phase-03-videos.md`.

### Modules

| Path | Role |
|------|------|
| `src/videos/` | `VideosModule` (API side): `Video` entity, `VideosService` (draft pre-registration, upload orchestration, owner lookup, playback URLs), `VideosController`, `VideoProcessingPublisher` (RabbitMQ producer), `public-id.util.ts`, `upload-plan.ts`, `video-storage-keys.ts` |
| `src/storage/` | `StorageModule` / `StorageService` — the only S3 client (multipart, presigned URLs, head/put/delete) |
| `src/video-processing/` | Worker side: `VideoProcessingModule`, `VideoProcessingController` (`@EventPattern('video.uploaded')`, manual ack), `VideoProcessingService` (metadata + thumbnail → `ready`, or `failed`), `MediaProbeService` (ffprobe/ffmpeg via `execFile`), queue contract in `video-processing.queue.ts` |
| `src/worker.ts` + `src/worker.module.ts` | Worker process entrypoint (NestJS RMQ microservice); builds to `dist-worker/` via `tsconfig.worker.json` |
| `src/database/migrations/1793632304936-CreateVideos.ts` | `videos` table + `videos_status_enum` |

### Endpoints (`VideosController`, `@SkipThrottle()` — the 10 req/min auth throttle does not apply)

| Method & path | Auth | Purpose |
|---------------|------|---------|
| `POST /videos` | JWT | Pre-register a `draft` (`file_name`, `file_size` ≤ 10 GiB, `content_type` `video/*`, optional `title`) and open the multipart upload → `part_size` (64 MiB), `part_count` |
| `GET /videos/:id/upload` | JWT, owner | Parts already stored (resume after a connection failure) |
| `POST /videos/:id/upload/part-urls` | JWT, owner | Presigned `UploadPart` URLs (`part_numbers`, ≤ 100 per call); the client PUTs bytes straight to storage |
| `POST /videos/:id/upload/complete` | JWT, owner | Assemble parts, publish `video.uploaded`, move to `processing` (202, idempotent) |
| `DELETE /videos/:id/upload` | JWT, owner | Cancel a draft (abort multipart + delete row) |
| `GET /videos/:id` | JWT, owner | Status lifecycle + extracted metadata + presigned `thumbnail_url` |
| `GET /videos/:publicId/stream` | `@Public()` | 302 to a presigned GET URL; storage answers `Range` with `206` (only `ready`) |
| `GET /videos/:publicId/download` | `@Public()` | 302 to a presigned URL with `Content-Disposition: attachment` (only `ready`) |

Videos of other channels and non-`ready`/unknown/malformed public ids answer `404 VIDEO_NOT_FOUND`. Error codes: `CHANNEL_NOT_FOUND`, `VIDEO_NOT_FOUND`, `VIDEO_NOT_DRAFT`, `INVALID_PART_NUMBER`, `UPLOAD_INCOMPLETE`, `UPLOAD_SIZE_MISMATCH`, `PROCESSING_QUEUE_UNAVAILABLE` (503, retry completion).

### Status lifecycle

`draft` → `processing` → `ready` | `failed` (`ready`/`failed` are terminal). `completeUpload` publishes **before** flipping the status (a failed publish keeps the draft and its `upload_id`, so completion can be retried); the worker accepts `draft` too (job may arrive before the API commit) and only writes `ready`/`failed` over non-terminal rows.

### Queue and worker

- Queue contract lives only in `src/video-processing/video-processing.queue.ts`: producer uses `buildVideoProcessingClientOptions` (`persistent: true`), consumer `buildVideoProcessingServerOptions` (`noAck: false`, `prefetchCount: 1`). Both assert the same quorum-queue arguments (`x-delivery-limit: 5`, dead-letter to `<queue>.dlq`) — RabbitMQ rejects a redeclaration with different arguments. Never set `noAck: false` on the producer (Nest's reply consumer fails with 406).
- Retry: attempt = `x-delivery-count` + 1; attempts 1–2 → `nack(requeue)`; attempt 3 → `markFailed` + `ack`. Malformed payloads → `nack` without requeue (DLQ). `src/worker.ts` declares the DLQ before consuming.
- The worker reads the original through an **internal** presigned URL (FFmpeg uses HTTP Range — a 10 GB file is never downloaded) and writes `videos/{id}/thumbnail.jpg`.
- `WorkerModule` imports `UsersModule` so `autoLoadEntities` registers `Channel`/`User` (relations of `Video`).

### Object storage

Single private bucket `streamtube-videos`, keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. Two endpoints: `S3_ENDPOINT` (server-side calls, Compose host `minio`) and `S3_PUBLIC_ENDPOINT` (only to sign URLs handed to clients — SigV4 signs the host). Env keys: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `RABBITMQ_URL`, `VIDEO_PROCESSING_QUEUE`.

### Testing notes

- Storage, queue and worker are tested against the real Compose services — no storage/queue mocks in integration/e2e tests.
- `src/test/test-env.ts` (Jest `setupFiles`, both configs) points `S3_PUBLIC_ENDPOINT` at `S3_ENDPOINT` (the test client runs inside the Compose network) and sets `VIDEO_PROCESSING_QUEUE=video-processing.test`, so the running `video-worker` never consumes test jobs. Tests that need processing boot `WorkerModule` in-process (`NestFactory.createMicroservice`).
- Test videos are generated with FFmpeg `lavfi` by `src/test/video-fixtures.ts` — no binary fixtures in git. `test/support/e2e-app.ts` boots the app with the `main.ts` globals and creates confirmed users.

### Operations

```bash
docker compose logs video-worker                  # expect: Consuming "video-processing" (DLQ "video-processing.dlq")
docker compose exec rabbitmq rabbitmqctl list_consumers   # consumer on video-processing, ack_required=true
docker compose restart video-worker               # after code changes (see below)
npm run build:worker && npm run start:worker      # compiled worker (inside the container)
```

On Docker Desktop (Windows/macOS) host edits through the bind mount do not reach the container's file watcher, so `start:dev` / `start:worker:dev` do not reload automatically — restart the service after changes.
