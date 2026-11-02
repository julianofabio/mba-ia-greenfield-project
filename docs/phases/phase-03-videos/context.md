---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-01T21:25:27-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-02T11:05:08-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-02T10:36:59-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-02T10:36:59-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-02T10:36:59-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-02T10:36:59-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-01T21:25:26-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Interface de vídeo no `next-frontend/` (brief da fase: "a interface de vídeo **não faz parte** do escopo desta fase"); edição de informações do vídeo, categorias, thumbnail customizada, visibilidade público/unlisted, fluxo de rascunho → publicação e painel do canal (Fase 04); player, contagem de visualizações e página de visualização (Fase 05); interações sociais (Fase 06); ambiente de produção e deploy (Fase 07).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — no Phase 03 capability is a UI bullet and the phase brief excludes the video interface; the upload/streaming contract reaches the frontend through the committed OpenAPI spec in a later phase.

**Sequencing notes:** Depends on Fase 01 — Configuração Base do Projeto and Fase 02 — Cadastro, Login e Gerenciamento de Conta (videos belong to the channel created at registration; owner identity comes from the Phase 02 JWT).

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — users, channels (1:1), JWT guard, domain error envelope.
- **Phase 04:** Gerenciamento de Vídeos e Canal — categories, edit title/description/category/custom thumbnail, visibility public/unlisted, draft → publication flow, channel management panel.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | RabbitMQ Client Integration | decided | A (`@nestjs/microservices` RMQ transport) | @nestjs/microservices@11.1.16, amqplib@0.10.9, amqp-connection-manager@5.0.0, @types/amqplib@0.10.8 |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Large File Upload Strategy (up to 10GB) | decided | A (Presigned S3 multipart upload) | — |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Object Storage Layout and Access Model | decided | A (Single private bucket, video-id keys, presigned access, dual endpoint) | @aws-sdk/client-s3@3.1152.0, @aws-sdk/s3-request-presigner@3.1152.0 |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Worker Runtime Topology | decided | A (Second entrypoint of the NestJS project, separate Compose service) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Media Probing and Thumbnail Extraction | decided | A (ffprobe/ffmpeg CLI over a presigned URL) | ffmpeg (Debian bookworm `apt` package in `Dockerfile.dev`, provides `ffmpeg` + `ffprobe`) |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier | decided | A (11-char random base64url id + unique constraint + retry) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Streaming and Download Delivery | decided | A (302 redirect to a short-lived presigned GET URL) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Access Policy for Upload, Playback and Download | decided | A (Owner-only upload operations; public playback/download by unique id when ready) | — |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle and Processing Failure Handling | decided | A (draft/processing/ready/failed + bounded retries, then failed) | — |
| phase-03-videos/TD-10 | technical-decisions-phase-03-videos.md | Backend | Consistency Between Database State and Job Publication | decided | A (Confirmed publish + idempotent completion endpoint and consumer) | — |
| phase-03-videos/TD-11 | technical-decisions-phase-03-videos.md | Backend | Testing Strategy for Storage, Queue and Worker | decided | A (Real Compose services, test-scoped queue, worker booted in-process) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-11 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04, phase-03-videos/TD-11 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-08 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-09 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-09, phase-03-videos/TD-10, phase-03-videos/TD-11 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05, phase-03-videos/TD-09, phase-03-videos/TD-11 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06, phase-03-videos/TD-08 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07, phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07, phase-03-videos/TD-08 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** it is the official path for the installed NestJS 11 stack, supports everything one job type needs (durable queue, manual ack, queue arguments), and keeps the producer and the worker on the same configuration object; the hand-coded retry policy is small (see TD-09).

**Note:** Versions pinned to what the NestJS 11.1.x monorepo is built and tested with (`nestjs/nest` `package.json`: `amqplib` 0.10.9, `amqp-connection-manager` 5.0.0, `@types/amqplib` 0.10.8); `@nestjs/microservices` is kept in lockstep with the installed `@nestjs/core` 11.1.16. `amqplib` 2.x (new major line started 2026-05) is deliberately not adopted — Nest's RMQ transport is not tested against it. Broker image: `rabbitmq:4.1.8-management` (quorum queues, delivery limit, management UI on 15672).

**Libraries:** @nestjs/microservices@11.1.16, amqplib@0.10.9, amqp-connection-manager@5.0.0, @types/amqplib@0.10.8

### phase-03-videos/TD-02

**Recommendation:** it is the only option where the API is out of the data path, which is the literal requirement ("sem impacto na performance"), and S3 multipart gives per-part resume with no extra component. Parameters to carry into the plan: maximum size 10 GiB (10 737 418 240 bytes) declared at initiation and re-checked against the stored object size at completion; fixed part size of 64 MiB (≈160 parts for 10 GiB, well under the S3 limit of 10 000 parts and above the 5 MiB minimum); presigned part URLs expire after 1 hour and are re-requestable at any time.

**Note (resolves AMB-1):** Initiation input is `fileName` (1–255 chars), `fileSize` (integer bytes, 1 … 10 737 418 240) and `contentType` (must start with `video/`), plus an optional `title` (1–100 chars). When `title` is omitted the draft title is the file name without its extension, truncated to 100 chars — Phase 04 owns title editing. The 10 GiB limit is enforced twice: by DTO validation at initiation and, at completion, by comparing the stored object size (`HeadObject`) with the declared `fileSize`; a mismatch aborts completion. `contentType` is only a first filter — `ffprobe` (TD-05) is the authoritative check that the file is a video.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** one private bucket with video-id prefixes keeps the access policy in a single place (the API) and maps 1:1 to S3 in production. Canonical env keys: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`; path-style addressing (`forcePathStyle: true`) for MinIO. Client SDK: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (AWS SDK v3, the official S3 client; the same code targets MinIO and S3).

**Note:** MinIO image source verified on 2026-11-02: `minio/minio` and `minio/mc` are no longer pullable from Docker Hub ("pull access denied … repository does not exist") and `quay.io/minio/*` returns 401. The Compose service therefore uses `cgr.dev/chainguard/minio` (MinIO RELEASE.2026-10-23T20-06-51Z built from source) and the bucket init uses `cgr.dev/chainguard/minio-client`; both are pinned by digest because the free Chainguard tier publishes only `latest`. The S3 API is unchanged, so the decision and its production mapping to AWS S3 stand. AWS SDK pinned to 3.1152.0 (released 2026-10-14) — the latest release older than two weeks.

**Libraries:** @aws-sdk/client-s3@3.1152.0, @aws-sdk/s3-request-presigner@3.1152.0

### phase-03-videos/TD-04

**Recommendation:** container isolation gives the performance guarantee, while one codebase keeps entity and message contracts compile-time checked on both sides; the build-output collision is solved with a dedicated tsconfig/out dir for the worker.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** ranged reads make metadata and thumbnail cost proportional to what is read, not to file size, and calling the binaries directly avoids a deprecated wrapper. Thumbnail frame: the frame at 10% of the duration (clamped to the first frame for very short or duration-less inputs), JPEG, scaled to 1280 px wide preserving aspect ratio. Any `ffprobe` failure or a file without a video stream is a processing failure (see TD-09).

**Note (resolves AMB-2):** Persisted technical metadata, as typed nullable columns on the video row (queryable by later phases, e.g. duration on listings): `duration_seconds` (numeric, 3 decimals), `width`, `height` (integers), `video_codec`, `audio_codec` (nullable — silent videos), `container_format` (strings), `bitrate` (bigint, bits/s) and `size_bytes` (bigint, from the stored object). Values come from `ffprobe -show_format -show_streams` (first video stream, first audio stream).

**Libraries:** ffmpeg (Debian bookworm `apt` package in `Dockerfile.dev`, provides `ffmpeg` + `ffprobe`)

**Revisions:**
- 2026-11-02 — Thumbnail scaled to `min(1280, source width)` instead of always 1280 px wide (no upscaling of smaller sources). Rationale: upscaling adds bytes without adding detail; aspect ratio and the JPEG/frame-at-10% choice are unchanged.

### phase-03-videos/TD-06

**Recommendation:** it meets "curta e única" with database-enforced uniqueness and no new dependency, and keeps the UUID as the internal key.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** storage serves `206 Partial Content` natively and the API stays out of the data path; presigned stream/download URLs expire after 1 hour (enough to start playback; the client re-requests the API endpoint for a fresh redirect).

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** it is the coherent reading of the project's anonymous-viewing rule with the capabilities available in Phase 03; the residual exposure is limited to holders of a 64-bit random link, and Phase 04 owns the publication gate. Ownership failures on upload endpoints return 404 (not 403) so that video ids of other channels are not disclosed.

**Note (resolves ICC-1):** The video controller opts out of the inherited global `ThrottlerGuard` with `@SkipThrottle()` at class level — the same mechanism `AppController` already uses. Rationale: phase-02-auth/TD-08's 10 req/min limit protects credential endpoints against brute force; upload orchestration is authenticated and ownership-checked, a single 10GB upload legitimately needs dozens of calls, and playback re-requests redirects. phase-02-auth/TD-08 itself is unchanged for auth endpoints.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** it satisfies the required cycle with an explicit terminal error state and bounded self-healing using only quorum-queue features. An upload that is never completed stays `draft` and can be cancelled by its owner (abort the multipart upload and delete the record); `ready` and `failed` are terminal in Phase 03.

**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** an idempotent completion endpoint plus an idempotent consumer covers every crash window with no extra infrastructure; the outbox would be justified only if jobs were produced where no client can retry.

**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** it is the only option that honours the brief and the Phase 02 pattern while keeping results deterministic. Unit tests still mock collaborators where the logic is pure (state transitions, retry decisions, id generation), per the testing guide.

**Note (resolves IC-1):** For object storage this supersedes, for Phase 03 onward, the testing guide's "Local filesystem storage in development and tests" strategy (`references/external-systems.md`), which predates any storage decision. No filesystem storage adapter is built: development and tests both use the MinIO Compose service, as the phase brief requires. The guide's queue strategy (real broker, dedicated test queues) is followed as written.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)


### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —


### openapi-docs-nestjs/TD-01

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** **Option B (Apenas em dev/staging)** — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — reset-password destination screen absent from Figma; link destination remains a 404 until a later phase. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | umbrella bullet deferred to the phase that lands the missing confirmação and reset-password screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` § 3 Feature Implementation Checklist)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |

External-system strategies (`references/external-systems.md`): PostgreSQL — real (Compose `db`); Message Queue — real broker in Docker with dedicated test queues (publisher tests assert the job is enqueued with correct data; consumer tests submit a job and assert the processing outcome); Object Storage — "Local filesystem storage in development and tests. S3 in production."; Email — Mailpit.
