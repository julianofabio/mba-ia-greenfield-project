---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-02T11:05:08-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-02T11:05:09-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-02T11:05:08-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-02T10:36:59-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o pipeline de vídeo do backend — armazenamento de arquivos (vídeos e thumbnails) em object storage S3-compatível, fila de processamento em segundo plano com um worker FFmpeg, upload de vídeos de até 10GB direto ao storage sem impacto na performance da API com pré-cadastro do vídeo como rascunho, processamento automático (duração, metadados e thumbnail a partir de um frame), URL única por vídeo, reprodução via streaming e download.

---

## Step Implementations

### SI-03.1 — Infra: dependências, FFmpeg e serviços de storage e fila no Compose

**Description:** Instala as bibliotecas fixadas da fase, coloca o FFmpeg na imagem de desenvolvimento e sobe MinIO (com o bucket criado) e RabbitMQ junto com a stack do backend — a base de infraestrutura que todos os SIs seguintes exercitam de verdade.

**Technical actions:**

1. Instalar em `nestjs-project` as versões exatas de `library-refs.md`: `@nestjs/microservices@11.1.16`, `amqplib@0.10.9`, `amqp-connection-manager@5.0.0`, `@aws-sdk/client-s3@3.1152.0`, `@aws-sdk/s3-request-presigner@3.1152.0` e, como devDependency, `@types/amqplib@0.10.8` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
2. Atualizar `Dockerfile.dev` — acrescentar `ffmpeg` ao `apt install` existente, disponibilizando `ffmpeg`/`ffprobe` para API, worker e testes (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-11`)
3. Adicionar ao `compose.yaml` o serviço `rabbitmq` — `rabbitmq:4.1.8-management`, usuário/senha `streamtube`, portas `5672` e `15672`, healthcheck `rabbitmq-diagnostics -q ping` (per `phase-03-videos/TD-01`)
4. Adicionar ao `compose.yaml` os serviços `minio` (`cgr.dev/chainguard/minio` fixado por digest, `server /data --console-address :9001`, portas `9000`/`9001`, volume nomeado, healthcheck em `/minio/health/live`) e `minio-init` (`cgr.dev/chainguard/minio-client` fixado por digest, one-shot que cria o bucket `streamtube-videos` com `mc mb --ignore-existing`) (per `phase-03-videos/TD-03`)
5. Fazer `nestjs-api` depender de `rabbitmq` (`service_healthy`) e de `minio-init` (`service_completed_successfully`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` (a partir de `nestjs-project/`) sobe `db`, `mailpit`, `rabbitmq`, `minio` e `nestjs-api`; `minio-init` termina com código 0
- `docker compose exec nestjs-api ffprobe -version` imprime a versão do FFmpeg
- `mc ls` no `minio-init` (ou `HeadBucket` via SDK) mostra o bucket `streamtube-videos` existente; um segundo `docker compose up -d` não falha por bucket já existente
- `docker compose exec rabbitmq rabbitmq-diagnostics -q ping` sai com código 0 e a UI de gestão responde em `http://localhost:15672`
- `npm ls @nestjs/microservices amqplib @aws-sdk/client-s3` no container lista as versões fixadas

---

### SI-03.2 — Namespaces de configuração de storage e mensageria

**Description:** Cria os namespaces `storage` e `messaging` no padrão `registerAs` herdado, valida as chaves canônicas no Joi e prepara os overrides de ambiente dos testes — o contrato de configuração compartilhado por API, worker, Compose e testes.

**Technical actions:**

1. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` (per `phase-03-videos/TD-03`; padrão `phase-01-configuracao-base/TD-03`)
2. Criar `src/config/messaging.config.ts` — `registerAs('messaging', ...)` lendo `RABBITMQ_URL` e `VIDEO_PROCESSING_QUEUE` (per `phase-03-videos/TD-01`)
3. Estender `src/config/env.validation.ts` com as regras de `### Data Model → Environment keys` e registrar os dois namespaces no `load` de `ConfigModule.forRoot` em `AppModule` (per `phase-01-configuracao-base/TD-02`)
4. Acrescentar a `.env.example` as chaves de `### Data Model → Environment keys` com os valores do Compose, sem alterar as chaves existentes
5. Criar `src/test/test-env.ts` (override de `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` e `VIDEO_PROCESSING_QUEUE = video-processing.test`) e incluí-lo em `setupFiles` do Jest unitário (`package.json`) e e2e (`test/jest-e2e.json`) depois de `dotenv/config` (per `phase-03-videos/TD-11`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (chaves de storage e mensageria) | Integration: required/default/uri | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.1 — os valores padrão apontam para os serviços do Compose criados ali

**Acceptance criteria:**

- Validar o ambiente sem `S3_ACCESS_KEY`, `S3_SECRET_KEY` ou `RABBITMQ_URL` produz erro de validação citando a chave ausente
- Validar o ambiente sem `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET` e `VIDEO_PROCESSING_QUEUE` aplica os padrões `http://minio:9000`, `http://localhost:9000`, `us-east-1`, `streamtube-videos` e `video-processing`
- `S3_ENDPOINT` com valor que não é URI é rejeitado
- A API sobe com o `.env` derivado de `.env.example` e `GET /` continua respondendo 200
- Dentro do Jest, `process.env.VIDEO_PROCESSING_QUEUE` vale `video-processing.test` — os testes nunca consomem a fila do worker em execução

---

### SI-03.3 — Serviço de object storage

**Description:** Cria o `StorageModule` com o `StorageService`, único ponto que fala com o S3/MinIO — operações de multipart, URLs pré-assinadas contra o endpoint público e leitura/escrita server-side contra o endpoint interno.

**Technical actions:**

1. Criar `src/storage/storage.service.ts` com dois `S3Client` (`S3_ENDPOINT` para chamadas server-side e `S3_PUBLIC_ENDPOINT` só para assinar URLs de clientes), ambos com `forcePathStyle: true` e `requestChecksumCalculation`/`responseChecksumValidation` = `WHEN_REQUIRED` (per `phase-03-videos/TD-03`; `library-refs.md` → `@aws-sdk/client-s3`)
2. Implementar em `StorageService` as operações de multipart: `createMultipartUpload`, `presignUploadPart`, `listParts` (paginado até o fim), `completeMultipartUpload`, `abortMultipartUpload` (per `phase-03-videos/TD-02`)
3. Implementar em `StorageService` as operações de objeto: `headObject`, `putObject`, `deleteObject`, `presignGetObject(key, { audience: 'public' | 'internal', downloadFileName? })` — `downloadFileName` gera `ResponseContentDisposition: attachment` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-05`)
4. Criar `src/storage/storage.module.ts` exportando `StorageService`, injetando `storageConfig.KEY`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: MinIO real — multipart create/presigned PUT/list/complete/abort, presigned GET com `Range` → 206, `Content-Disposition` no download, head/put/delete | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação do módulo com `ConfigModule` | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.2 — consome `storageConfig`

**Acceptance criteria:**

- Um objeto enviado em 2 partes por `PUT` nas URLs de `presignUploadPart` e concluído por `completeMultipartUpload` fica disponível com o tamanho igual à soma das partes
- `listParts` de um upload aberto devolve exatamente as partes já enviadas, com número e tamanho
- `GET` na URL de `presignGetObject` com `Range: bytes=0-99` recebe `206 Partial Content` com 100 bytes e `Content-Range`
- A URL de download assinada com `downloadFileName` recebe `Content-Disposition: attachment; filename="..."`
- `abortMultipartUpload` faz `listParts` posterior falhar com `NoSuchUpload`
- URLs públicas apontam para o host de `S3_PUBLIC_ENDPOINT`; URLs internas para o host de `S3_ENDPOINT`

---

### SI-03.4 — Entidade Video e migration CreateVideos

**Description:** Cria a entidade `Video` ligada ao canal e a migration versionada da tabela `videos`, com o enum de status do ciclo `draft → processing → ready/failed`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com todos os campos de `### Data Model → Video`, enum `VideoStatus` (`draft`, `processing`, `ready`, `failed`), `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })`, `@Index` em `channel_id`, transformer numérico para colunas `bigint`/`numeric` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-05`)
2. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` com `npm run migration:generate` (tabela, enum `videos_status_enum`, unique de `public_id`, índice de `channel_id`, FK para `channels`) e revisar o `down` (per `phase-01-configuracao-base/TD-04`)
3. Incluir `"videos"` em `cleanAllTables` (`src/test/create-test-data-source.ts`), apagando-a antes de `channels`
4. Incluir `Video`, a nova migration e `'videos'` em `MANAGED_TABLES` no `src/database/migrations.integration-spec.ts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: default `status = draft`, unique `public_id`, FK `channel_id` obrigatória, nulos dos metadados, `bigint` lido como `number` | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: aplicar e reverter todas as migrations (incluindo `CreateVideos`) | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1 — banco já existente; independente dos demais SIs

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` e o tipo `videos_status_enum`; `npm run migration:revert` remove ambos
- Inserir um vídeo sem `status` grava `draft`
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unicidade
- Inserir um vídeo com `channel_id` inexistente falha com violação de chave estrangeira
- `declared_size_bytes = 10737418240` é lido de volta como o número `10737418240`

---

### SI-03.5 — Identificador público do vídeo e busca de canal por usuário

**Description:** Entrega as duas peças de domínio que o pré-cadastro precisa fora do serviço de vídeos: o gerador do `public_id` da URL única e a consulta do canal do usuário autenticado, no módulo dono (`ChannelsModule`).

**Technical actions:**

1. Criar `src/videos/public-id.util.ts` — `generatePublicId()` com `randomBytes(8).toString('base64url')` (11 chars, 64 bits) e `isValidPublicId(value)` (`^[A-Za-z0-9_-]{11}$`) (per `phase-03-videos/TD-06`)
2. Criar `src/common/database/pg-errors.ts` — `isPgUniqueViolationOnColumn(err, column)` para detectar `23505` na coluna (mesmo contrato do helper local de `ChannelsService`, usado pelo retry de `public_id`)
3. Adicionar `ChannelsService.findByUserId(userId): Promise<Channel | null>` (canal pertence ao domínio de canais — `phase-02-auth`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generatePublicId` / `isValidPublicId` | Unit: formato, unicidade em lote, rejeição de valores mal formados | `src/videos/public-id.util.spec.ts` |
| `isPgUniqueViolationOnColumn` | Unit: classifica `QueryFailedError` 23505 por coluna e rejeita outros erros | `src/common/database/pg-errors.spec.ts` |
| `ChannelsService.findByUserId` | Integration: canal do usuário e `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** none — utilitários e consulta sobre tabelas existentes

**Acceptance criteria:**

- `generatePublicId()` sempre devolve 11 caracteres de `[A-Za-z0-9_-]`; 10 000 chamadas não repetem valor
- `isValidPublicId` rejeita strings de outro tamanho ou com caracteres fora do alfabeto base64url
- `ChannelsService.findByUserId` devolve o canal criado no cadastro do usuário e `null` para um id sem canal

---

### SI-03.6 — Topologia da fila e publicação do job de processamento

**Description:** Define o contrato da fila `video-processing` (padrão, payload e argumentos de quorum/DLQ) num único arquivo usado por producer e consumer, e cria o publisher da API que só retorna após a confirmação do broker.

**Technical actions:**

1. Criar `src/video-processing/video-processing.queue.ts` — `VIDEO_UPLOADED_PATTERN = 'video.uploaded'`, tipo `VideoUploadedEvent { videoId }`, `MAX_PROCESSING_ATTEMPTS = 3` e `buildVideoProcessingRmqOptions(messagingConfig)` com `queueOptions` de `### Events/Messages → Queue topology` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-09`)
2. Criar `src/videos/video-processing.publisher.ts` — `publishVideoUploaded(videoId)` com `lastValueFrom(client.emit(...).pipe(timeout(5000)))`; erro ou timeout → `ProcessingQueueUnavailableException` (per `phase-03-videos/TD-10`; `library-refs.md` → `@nestjs/microservices`, `amqp-connection-manager`)
3. Acrescentar `ProcessingQueueUnavailableException` (`PROCESSING_QUEUE_UNAVAILABLE`, 503) a `src/common/exceptions/domain.exception.ts` (per `### Error Catalog`)
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])`, `ClientsModule.registerAsync` (token `VIDEO_PROCESSING_CLIENT`, opções de `buildVideoProcessingRmqOptions`), `StorageModule`, `ChannelsModule` e o provider `VideoProcessingPublisher`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingPublisher` | Integration: RabbitMQ real — mensagem `{ pattern: 'video.uploaded', data: { videoId } }` persistente chega à fila de teste com os argumentos de quorum | `src/videos/video-processing.publisher.integration-spec.ts` |
| `VideosModule` | Unit: compilação do módulo (ClientsModule + TypeORM + Storage + Channels) | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.2 (messaging config), SI-03.3 (`StorageModule`), SI-03.4 (`Video`), SI-03.5 (`ChannelsService.findByUserId`)

**Acceptance criteria:**

- `publishVideoUploaded(id)` resolve só depois que a mensagem está na fila `VIDEO_PROCESSING_QUEUE`, com corpo `{"pattern":"video.uploaded","data":{"videoId":"<id>"}}` e `deliveryMode` persistente
- A fila declarada é `quorum` com `x-delivery-limit: 5` e dead-letter para `<fila>.dlq`
- Com o broker inacessível, `publishVideoUploaded` rejeita com `PROCESSING_QUEUE_UNAVAILABLE` em até ~5 s em vez de ficar pendente

---

### SI-03.7 — Orquestração do upload no VideosService

**Description:** Implementa as regras do upload direto ao storage — pré-cadastro como rascunho, estado para retomada, URLs de partes, conclusão idempotente com publicação do job e cancelamento — sem que nenhum byte do vídeo passe pela API.

**Technical actions:**

1. Criar `src/videos/upload-plan.ts` — `PART_SIZE_BYTES = 67108864`, `MAX_VIDEO_SIZE_BYTES = 10737418240`, `computePartCount(size)` e `defaultTitleFromFileName(name)` (per `phase-03-videos/TD-02`, nota AMB-1)
2. Criar `src/videos/videos.service.ts` — `initiateUpload(userId, dto)`: canal via `ChannelsService.findByUserId` (senão `CHANNEL_NOT_FOUND`), insere o rascunho com `public_id` gerado (retry de até 5 tentativas em violação de unicidade, per `phase-03-videos/TD-06`), abre o multipart em `videos/{id}/original` e grava `upload_id`; falha no storage remove o registro
3. Implementar `getUploadState` e `presignUploadParts` — dono + `draft` obrigatórios (`VIDEO_NOT_FOUND` / `VIDEO_NOT_DRAFT`), `INVALID_PART_NUMBER` para parte > `part_count` (per `phase-03-videos/TD-08`)
4. Implementar `completeUpload` — idempotente para `processing`/`ready`/`failed`; em `draft`: `listParts` → `UPLOAD_INCOMPLETE` se faltar parte, `UPLOAD_SIZE_MISMATCH` se a soma ≠ `declared_size_bytes`; `completeMultipartUpload`; `publishVideoUploaded`; grava `processing`, `upload_id = null`, `size_bytes` (per `phase-03-videos/TD-10`). Se o multipart já foi concluído numa tentativa anterior (`NoSuchUpload` + objeto presente em `headObject`), segue para a publicação. Implementar `cancelUpload` (abort + delete, só em `draft`)
5. Acrescentar a `domain.exception.ts` as exceções `CHANNEL_NOT_FOUND`, `VIDEO_NOT_FOUND`, `VIDEO_NOT_DRAFT`, `INVALID_PART_NUMBER`, `UPLOAD_INCOMPLETE`, `UPLOAD_SIZE_MISMATCH` com os status de `### Error Catalog`, e registrar `VideosService` em `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `upload-plan` | Unit: `computePartCount` nos limites (1 byte, 64 MiB, 64 MiB + 1, 10 GiB) e título padrão | `src/videos/upload-plan.spec.ts` |
| `VideosService` | Unit: ramos de dono/status/parte inválida, idempotência de `completeUpload`, retry de `public_id`, rollback quando o storage falha (repositório e colaboradores mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: PostgreSQL + MinIO + RabbitMQ reais — rascunho persistido com `upload_id`, partes enviadas por URL pré-assinada, conclusão grava `processing` e publica na fila de teste, cancelamento aborta e apaga | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 — publisher, `VideosModule` e exceções base

**Acceptance criteria:**

- `initiateUpload` de 150 MiB cria um vídeo `draft` com `part_count = 3`, `storage_key = videos/{id}/original` e um multipart aberto no storage
- Sem `title`, o rascunho de `meu-video.final.mp4` recebe o título `meu-video.final`
- `completeUpload` com as 3 partes enviadas deixa o vídeo em `processing`, com `upload_id` nulo e `size_bytes` igual ao tamanho declarado, e uma mensagem `video.uploaded` na fila
- `completeUpload` com 2 de 3 partes falha com `UPLOAD_INCOMPLETE` e o vídeo continua `draft`
- `completeUpload` com partes cuja soma difere do tamanho declarado falha com `UPLOAD_SIZE_MISMATCH`
- Repetir `completeUpload` num vídeo `processing` devolve o vídeo sem publicar uma segunda mensagem
- Qualquer operação sobre vídeo de outro canal falha com `VIDEO_NOT_FOUND`
- `cancelUpload` de um rascunho remove o registro e o multipart; em vídeo `processing` falha com `VIDEO_NOT_DRAFT`

---

### SI-03.8 — Endpoints de upload de vídeo

**Route:** POST /videos, GET /videos/{id}/upload, POST /videos/{id}/upload/part-urls, POST /videos/{id}/upload/complete, DELETE /videos/{id}/upload
**Test Specs:** see `nestjs-project/specs/videos-upload.plan.md`
**Authorization:** Authenticated (POST /videos); Owner (demais) — per `### Authorization Matrix`

**Description:** Expõe a orquestração do upload por HTTP no `VideosController`, com DTOs validados, documentação OpenAPI e isenção do throttle global, e registra o `VideosModule` na aplicação.

**Technical actions:**

1. Criar DTOs em `src/videos/dto/`: `initiate-upload.dto.ts` (`file_name`, `file_size`, `content_type`, `title`), `upload-part-urls.dto.ts` (`part_numbers`) e os DTOs de resposta (`initiate-upload-response.dto.ts`, `upload-state-response.dto.ts`, `upload-part-urls-response.dto.ts`, `video-response.dto.ts`) com as regras de `### API Contracts → Validation Rules`
2. Criar `src/videos/videos.controller.ts` — `@Controller('videos')`, `@SkipThrottle()` na classe (per `phase-03-videos/TD-08`, nota ICC-1), `@ApiTags('videos')` + `@ApiBearerAuth('access-token')`; rotas de upload com `ParseUUIDPipe` em `id`, `@CurrentUser()` como dono, status `201`/`200`/`202`/`204` de `### API Contracts` (per `openapi-docs-nestjs/TD-01`)
3. Criar o mapeamento entidade → `VideoResponse` em `src/videos/video-response.mapper.ts`, com `thumbnail_url` pré-assinada (público) quando `thumbnail_key` existir
4. Registrar `VideosController` em `VideosModule` e importar `VideosModule` em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoResponse` mapper | Unit: campos snake_case, `thumbnail_url` nulo sem thumbnail e pré-assinado com thumbnail | `src/videos/video-response.mapper.spec.ts` |

**Dependencies:** SI-03.7 — `VideosService`

**Acceptance criteria:**

- `POST /videos` autenticado com `{ file_name: "aula.mp4", file_size: 157286400, content_type: "video/mp4" }` retorna `201` com `status: "draft"`, `part_size: 67108864` e `part_count: 3`
- `POST /videos` com `file_size: 10737418241` ou `content_type: "image/png"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem token retorna `401`
- `POST /videos/{id}/upload/part-urls` com `{ part_numbers: [1, 2] }` retorna `200` com duas URLs; um `PUT` de bytes em cada URL é aceito pelo storage
- `GET /videos/{id}/upload` após enviar a parte 1 retorna `uploaded_parts` contendo só a parte 1
- `POST /videos/{id}/upload/complete` com todas as partes enviadas retorna `202` com `status: "processing"`
- `POST /videos/{id}/upload/part-urls` com `{ part_numbers: [4] }` num vídeo de 3 partes retorna `400` com `error: "INVALID_PART_NUMBER"`
- Qualquer rota de upload chamada por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `DELETE /videos/{id}/upload` de um rascunho retorna `204`; repetir retorna `404`
- 12 chamadas seguidas às rotas de upload em menos de 1 minuto não recebem `429`

---

### SI-03.9 — Extração de metadados e frame com FFmpeg

**Description:** Encapsula o uso do `ffprobe`/`ffmpeg` em um serviço do worker que lê o vídeo por URL (leituras com `Range`, sem baixar o arquivo inteiro) e devolve metadados tipados e o JPEG de um frame.

**Technical actions:**

1. Criar `src/video-processing/ffprobe-output.parser.ts` — `parseFfprobeOutput(json): MediaMetadata` (primeiro stream de vídeo, primeiro de áudio, `format.duration`/`format_name`/`bit_rate`; sem stream de vídeo → `MediaProcessingError`) e `thumbnailTimestamp(duration)` = 10% da duração, `0` quando a duração é ausente ou < 1 s (per `phase-03-videos/TD-05`, nota AMB-2)
2. Criar `src/video-processing/media-probe.service.ts` — `probe(input)` executa `ffprobe -v error -print_format json -show_format -show_streams <input>` via `execFile` (argumentos em array, sem shell) e delega ao parser; `extractFrame(input, atSeconds)` executa `ffmpeg -v error -ss <t> -i <input> -frames:v 1 -vf scale='min(1280,iw)':-2 -q:v 3 -f image2 -c:v mjpeg pipe:1` e devolve o `Buffer` (per `phase-03-videos/TD-05`; `library-refs.md` → `ffmpeg / ffprobe`)
3. Mapear código de saída ≠ 0 para `MediaProcessingError` com o `stderr` truncado (vira `failure_reason` no SI-03.10)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseFfprobeOutput` / `thumbnailTimestamp` | Unit: vídeo com áudio, sem áudio, sem stream de vídeo, duração ausente | `src/video-processing/ffprobe-output.parser.spec.ts` |
| `MediaProbeService` | Integration: FFmpeg real sobre vídeo gerado com `lavfi` (arquivo local e URL pré-assinada do MinIO), arquivo que não é vídeo | `src/video-processing/media-probe.service.integration-spec.ts` |

**Dependencies:** SI-03.1 (FFmpeg na imagem), SI-03.3 (URL pré-assinada nos testes)

**Acceptance criteria:**

- `probe` de um MP4 H.264/AAC 320x240 de 3 s retorna `duration_seconds ≈ 3`, `width = 320`, `height = 240`, `video_codec = "h264"`, `audio_codec = "aac"`
- `probe` de um vídeo sem áudio retorna `audio_codec = null`
- `probe` de um arquivo de texto falha com `MediaProcessingError`
- `extractFrame` devolve um JPEG válido (assinatura `FF D8`) com largura `min(1280, largura original)` e altura proporcional par — vídeos menores não são ampliados
- `probe` lendo pela URL pré-assinada do MinIO produz o mesmo resultado que lendo o arquivo local

---

### SI-03.10 — Processamento do vídeo no worker

**Description:** Implementa o caso de uso do worker — dado um `videoId`, extrai duração e metadados, gera e armazena o thumbnail e conclui o ciclo de status (`ready`), ou registra a falha (`failed`) após as tentativas permitidas.

**Technical actions:**

1. Criar `src/video-processing/processing-attempts.ts` — `attemptFromDeliveryCount(header)` (ausente → 1) e `shouldRetry(attempt)` (`attempt < MAX_PROCESSING_ATTEMPTS`) (per `phase-03-videos/TD-09`)
2. Criar `src/video-processing/video-processing.service.ts` — `process(videoId)`: ignora vídeo inexistente, `ready` ou `failed` (idempotência, per `phase-03-videos/TD-10`); `draft` → grava `processing`; URL interna pré-assinada do original → `MediaProbeService.probe` → `extractFrame(thumbnailTimestamp(duration))` → `putObject` em `videos/{id}/thumbnail.jpg` → grava metadados de `### Data Model → Video`, `thumbnail_key`, `size_bytes` (`headObject`), `status = ready`, `failure_reason = null` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-03`)
3. Implementar `markFailed(videoId, reason)` — `status = failed`, `failure_reason` truncado em 500 chars, só a partir de `draft`/`processing` (per `phase-03-videos/TD-09`)
4. Criar `src/video-processing/video-processing.module.ts` — `TypeOrmModule.forFeature([Video])`, `StorageModule`, providers `VideoProcessingService` e `MediaProbeService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `processing-attempts` | Unit: tentativa a partir do header e decisão de retry nos limites (1, 2, 3) | `src/video-processing/processing-attempts.spec.ts` |
| `VideoProcessingService` | Unit: ramos de idempotência (inexistente/`ready`/`failed`), `draft` → `processing`, `markFailed` só a partir de estados não terminais (repositório e colaboradores mockados) | `src/video-processing/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration: PostgreSQL + MinIO + FFmpeg reais — vídeo gerado vira `ready` com metadados e thumbnail no bucket; arquivo que não é vídeo lança erro e `markFailed` grava `failed` com motivo | `src/video-processing/video-processing.service.integration-spec.ts` |
| `VideoProcessingModule` | Unit: compilação do módulo | `src/video-processing/video-processing.module.spec.ts` |

**Dependencies:** SI-03.4 (`Video`), SI-03.6 (`MAX_PROCESSING_ATTEMPTS`), SI-03.9 (`MediaProbeService`)

**Acceptance criteria:**

- Processar um vídeo `processing` cujo original é um MP4 válido deixa o registro `ready` com `duration_seconds`, `width`, `height`, `video_codec`, `container_format`, `size_bytes` e `thumbnail_key` preenchidos
- Após o processamento, `videos/{id}/thumbnail.jpg` existe no bucket com `Content-Type: image/jpeg`
- Processar um vídeo já `ready` não altera o registro nem o bucket
- Processar um vídeo `draft` (job chegou antes do commit da API) também conclui em `ready`
- `markFailed` grava `status = failed` e um `failure_reason` não vazio de até 500 caracteres
- `shouldRetry` permite repetir nas tentativas 1 e 2 e encerra na 3

---

### SI-03.11 — Worker de vídeo: consumidor da fila, entrypoint e serviço no Compose

**Description:** Liga o caso de uso à fila — consumidor com ack manual e política de retry, aplicação NestJS separada para o worker, build isolado da API e o serviço `video-worker` subindo no Compose junto com o backend.

**Technical actions:**

1. Criar `src/video-processing/video-processing.controller.ts` — `@EventPattern(VIDEO_UPLOADED_PATTERN)` lendo `RmqContext`: chama `VideoProcessingService.process`; sucesso → `ack`; erro com `shouldRetry` → `nack(requeue=true)`; erro na última tentativa → `markFailed` + `ack` (per `phase-03-videos/TD-09`; `library-refs.md` → `@nestjs/microservices`)
2. Criar `src/worker.module.ts` (`ConfigModule` + `TypeOrmModule.forRootAsync` iguais aos de `AppModule`, `VideoProcessingModule`) e `src/worker.ts` — declara `{fila}.dlq` (quorum, durável) via `amqplib` e chama `NestFactory.createMicroservice(WorkerModule, buildVideoProcessingRmqOptions(...))` com `noAck: false` e `prefetchCount: 1` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-01`)
3. Criar `tsconfig.worker.json` (saída em `dist-worker/`, sem colidir com o `dist/` da API) e os scripts `start:worker` e `start:worker:dev` em `package.json` (`nest start --watch -p tsconfig.worker.json --entryFile worker`)
4. Adicionar ao `compose.yaml` o serviço `video-worker` — mesmo `Dockerfile.dev` e bind mount da API, comando que aguarda `node_modules` e executa `npm run start:worker:dev`, dependente de `db` e `rabbitmq` (`service_healthy`) e de `minio-init` (`service_completed_successfully`), `restart: unless-stopped` (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingController` + `WorkerModule` | Integration: worker iniciado em processo contra a fila de teste — mensagem publicada pelo `VideoProcessingPublisher` leva o vídeo a `ready`; mensagem para vídeo inválido termina em `failed` após 3 tentativas | `src/video-processing/video-processing.consumer.integration-spec.ts` |
| `WorkerModule` | Unit: compilação do módulo | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.10 — caso de uso do worker

**Acceptance criteria:**

- `docker compose up -d` sobe `video-worker` junto com o backend e o log mostra o microservice conectado à fila `video-processing`
- Um job para um vídeo válido leva o registro a `ready` sem intervenção na API
- Um job para um arquivo que não é vídeo é entregue 3 vezes e termina com `status = failed` e `failure_reason` preenchido; a mensagem não fica presa na fila
- A fila `video-processing.dlq` existe após o bootstrap do worker
- `nest start` da API e do worker rodando ao mesmo tempo não apagam a saída de build um do outro

---

### SI-03.12 — Endpoints de consulta, streaming e download

**Route:** GET /videos/{id}, GET /videos/{public_id}/stream, GET /videos/{public_id}/download
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`
**Authorization:** Owner (GET /videos/{id}); Anonymous (stream e download, somente `ready`) — per `### Authorization Matrix`

**Description:** Fecha o ciclo do usuário: o dono acompanha status e metadados do vídeo, e a URL única do vídeo pronto entrega streaming com `206 Partial Content` e download como anexo direto do storage.

**Technical actions:**

1. Implementar `VideosService.getOwnedVideo(userId, id)` (dono, senão `VIDEO_NOT_FOUND`) e `resolvePlaybackUrl(publicId, mode: 'stream' | 'download')` — `public_id` mal formado, inexistente ou vídeo fora de `ready` → `VIDEO_NOT_FOUND`; URL pública pré-assinada de 3600 s, com `attachment; filename="{original_file_name}"` no modo `download` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`)
2. Adicionar a `VideosController` `GET /videos/:id` (`ParseUUIDPipe`, retorna `VideoResponse`) e `GET /videos/:publicId/stream` + `GET /videos/:publicId/download` com `@Public()`, respondendo `302` com `Location` e `Cache-Control: no-store` (per `### API Contracts`)
3. Documentar as três rotas no OpenAPI (`@ApiResponse` 200/302/404) seguindo o padrão do `AuthController` (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (consulta e playback) | Unit: dono vs outro canal, `public_id` mal formado, vídeo fora de `ready`, modo `download` com nome do arquivo | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.8 (`VideosController`, mapper), SI-03.11 (worker que leva o vídeo a `ready` nos testes de fluxo)

**Acceptance criteria:**

- `GET /videos/{id}` pelo dono retorna `200` com o `status` atual e, após o processamento, `duration_seconds`, `width`, `height` e `thumbnail_url` preenchidos
- `GET /videos/{id}` por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`; sem token retorna `401`
- `GET /videos/{public_id}/stream` anônimo de um vídeo `ready` retorna `302`; um `GET` na `Location` com `Range: bytes=0-1023` recebe `206 Partial Content` com 1024 bytes
- `GET /videos/{public_id}/download` anônimo retorna `302`; a `Location` responde com `Content-Disposition: attachment; filename="{original_file_name}"` e o arquivo completo
- `GET /videos/{public_id}/stream` de um vídeo `draft`, `processing` ou `failed` retorna `404`
- `GET /videos/xyz/stream` (mal formado) e um `public_id` bem formado inexistente retornam o mesmo `404 VIDEO_NOT_FOUND`
- Dois vídeos enviados pelo mesmo usuário recebem `public_id` distintos e cada URL de stream entrega o próprio arquivo

---

### SI-03.13 — Spec OpenAPI exportada e documentação de IA

**Description:** Mantém os contratos publicados coerentes com o código — regenera o `openapi.json` versionado com as rotas de vídeo e atualiza os `CLAUDE.md` com o módulo de vídeos, o worker, a fila e o storage reais.

**Technical actions:**

1. Regenerar `nestjs-project/openapi.json` com `npm run openapi:export` e acrescentar ao teste de exportação a verificação das rotas `/videos` (per `openapi-docs-nestjs/TD-02`)
2. Atualizar `nestjs-project/CLAUDE.md` com a seção de vídeos: serviços do Compose (`minio`, `minio-init`, `rabbitmq`, `video-worker`), chaves de ambiente, endpoints, fluxo de upload, fila/worker/retry, comandos de verificação e a regra de fila de teste
3. Atualizar o `CLAUDE.md` da raiz — Message Queue passa de "TBD" para RabbitMQ e o Video Worker aponta para o entrypoint real

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `exportSpec` | Integration: documento exportado contém `/videos`, `/videos/{id}/upload/complete` e `/videos/{public_id}/stream` | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.12 — todas as rotas existem

**Acceptance criteria:**

- `nestjs-project/openapi.json` contém as 8 rotas de `### API Contracts` com seus códigos de resposta
- Todo arquivo, serviço, variável e endpoint citado nas seções novas dos `CLAUDE.md` existe no código ou no `compose.yaml`
- O `CLAUDE.md` da raiz não descreve mais a fila de mensagens como "TBD"

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos` (migration `CreateVideos`). Pertence a um `Channel` (per `phase-03-videos/TD-08`). Colunas de metadados técnicos são tipadas e anuláveis — preenchidas pelo worker (per `phase-03-videos/TD-05`, nota AMB-2).

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`uuid_generate_v4()`) |
| public_id | varchar(11) | unique, not null — 11 chars base64url aleatórios (per `phase-03-videos/TD-06`) |
| channel_id | uuid | not null, FK → `channels.id` |
| title | varchar(100) | not null — `title` informado ou nome do arquivo sem extensão, truncado em 100 (per `phase-03-videos/TD-02`, nota AMB-1) |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` (per `phase-03-videos/TD-09`) |
| original_file_name | varchar(255) | not null |
| content_type | varchar(255) | not null — começa com `video/` |
| declared_size_bytes | bigint | not null — 1 … 10 737 418 240 (per `phase-03-videos/TD-02`) |
| storage_key | varchar(255) | not null — `videos/{id}/original` (per `phase-03-videos/TD-03`) |
| upload_id | varchar(1024) | nullable — `UploadId` do multipart S3 enquanto `draft`; `null` após completar |
| thumbnail_key | varchar(255) | nullable — `videos/{id}/thumbnail.jpg` após processamento (per `phase-03-videos/TD-03`) |
| size_bytes | bigint | nullable — tamanho do objeto armazenado (`HeadObject`) |
| duration_seconds | numeric(10,3) | nullable |
| width | integer | nullable |
| height | integer | nullable |
| video_codec | varchar(50) | nullable |
| audio_codec | varchar(50) | nullable — vídeo sem áudio |
| container_format | varchar(100) | nullable |
| bitrate | bigint | nullable — bits/s |
| failure_reason | varchar(500) | nullable — motivo quando `status = failed` (per `phase-03-videos/TD-09`) |
| created_at | timestamp | default now() |
| updated_at | timestamp | default now(), on update |

**Relations:** `Video` many-to-one `Channel` (`channel_id`), unidirecional — `Channel` não ganha coleção nesta fase.
**Indexes:** unique on `public_id`; index on `channel_id`.
**Mapping notes:** colunas `bigint` são expostas como `number` via transformer (o máximo, 10 GiB, cabe em `Number.MAX_SAFE_INTEGER`); `numeric` de `duration_seconds` idem.

**Status lifecycle** (per `phase-03-videos/TD-09`, `phase-03-videos/TD-10`):

| From | To | Who | When |
|------|----|-----|------|
| — | `draft` | API (`VideosService`) | `POST /videos` pré-cadastra o vídeo e abre o multipart upload |
| `draft` | `processing` | API (`VideosService`) | `POST /videos/{id}/upload/complete` após publicar o job com confirmação do broker |
| `draft` | `processing` | Worker (`VideoProcessingService`) | job chegou antes do commit da API (janela de TD-10) |
| `processing` | `ready` | Worker | metadados + thumbnail persistidos |
| `processing` | `failed` | Worker | 3ª tentativa falhou — grava `failure_reason` |
| `draft` | (removido) | API | `DELETE /videos/{id}/upload` — aborta o multipart e apaga o registro |

`ready` e `failed` são terminais nesta fase.

#### Object storage layout

Não é tabela; contrato de chaves compartilhado entre API e worker (per `phase-03-videos/TD-03`).

| Item | Value |
|------|-------|
| Bucket | `streamtube-videos` (`S3_BUCKET`), privado — sem policy pública |
| Original | `videos/{videoId}/original` |
| Thumbnail | `videos/{videoId}/thumbnail.jpg` (`image/jpeg`) |
| Acesso de clientes | apenas URLs pré-assinadas, expiração 3600 s, assinadas contra `S3_PUBLIC_ENDPOINT` |
| Acesso servidor | `S3_ENDPOINT` (rede do Compose), `forcePathStyle: true` |

#### Environment keys

Chaves canônicas compartilhadas por Joi (`src/config/env.validation.ts`), `compose.yaml`, `.env.example`, API e worker (per `phase-03-videos/TD-03`, `phase-03-videos/TD-01`).

| Key | Joi rule | Compose / `.env.example` value |
|-----|----------|-------------------------------|
| S3_ENDPOINT | string uri, default `http://minio:9000` | `http://minio:9000` |
| S3_PUBLIC_ENDPOINT | string uri, default `http://localhost:9000` | `http://localhost:9000` |
| S3_REGION | string, default `us-east-1` | `us-east-1` |
| S3_ACCESS_KEY | string, required | `streamtube` |
| S3_SECRET_KEY | string, required | `streamtube-secret` |
| S3_BUCKET | string, default `streamtube-videos` | `streamtube-videos` |
| RABBITMQ_URL | string uri, required | `amqp://streamtube:streamtube@rabbitmq:5672` |
| VIDEO_PROCESSING_QUEUE | string, default `video-processing` | `video-processing` |

Nos testes, `src/test/test-env.ts` sobrescreve `S3_PUBLIC_ENDPOINT` com `S3_ENDPOINT` e `VIDEO_PROCESSING_QUEUE` com `video-processing.test` (per `phase-03-videos/TD-11`).

### API Contracts

Todas as rotas de vídeo ficam em `VideosController` (`/videos`), com `@SkipThrottle()` na classe (per `phase-03-videos/TD-08`, nota ICC-1). Erros seguem o envelope herdado `{ statusCode, error, message }` (per `phase-02-auth/TD-07`). Campos de wire em snake_case, como nos DTOs existentes (`refresh_token`, `new_password`).

**`VideoResponse`** (representação do dono — usada por `GET /videos/{id}` e `POST /videos/{id}/upload/complete`):

- id: string (uuid)
- public_id: string (11 chars)
- title: string
- status: `"draft" | "processing" | "ready" | "failed"`
- original_file_name: string
- content_type: string
- size_bytes: number | null
- duration_seconds: number | null
- width: number | null
- height: number | null
- video_codec: string | null
- audio_codec: string | null
- container_format: string | null
- bitrate: number | null
- thumbnail_url: string | null — URL pré-assinada (3600 s) do thumbnail quando `thumbnail_key` existe
- failure_reason: string | null
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

#### POST /videos (SI-03.8)

Pré-cadastra o vídeo como rascunho e abre o multipart upload (per `phase-03-videos/TD-02`).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- file_name: string, required — 1–255 chars
- file_size: integer, required — 1 … 10737418240 (10 GiB)
- content_type: string, required — deve começar com `video/`
- title: string, optional — 1–100 chars; ausente → `file_name` sem extensão, truncado em 100

**Response 201:**
- id: string (uuid)
- public_id: string
- title: string
- status: `"draft"`
- part_size: number — 67108864 (64 MiB)
- part_count: number — `ceil(file_size / part_size)`

**Error responses:**
- 400 VALIDATION_ERROR: body inválido (campos ausentes, `file_size` > 10 GiB, `content_type` fora de `video/*`, propriedades desconhecidas)
- 401 Unauthorized: sem token válido
- 404 CHANNEL_NOT_FOUND: o usuário autenticado não possui canal

---

#### GET /videos/{id}/upload (SI-03.8)

Estado do upload para retomada após falha de conexão — partes já armazenadas (per `phase-03-videos/TD-02`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- part_size: number
- part_count: number
- uploaded_parts: array of `{ part_number: number, size_bytes: number }` — ordenado por `part_number`

**Error responses:**
- 400 VALIDATION_ERROR: `id` não é UUID
- 401 Unauthorized
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_NOT_DRAFT: o upload do vídeo já foi concluído

---

#### POST /videos/{id}/upload/part-urls (SI-03.8)

Emite URLs pré-assinadas de `UploadPart` para o cliente enviar as partes direto ao storage (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1–100 itens, únicos, cada um ≥ 1

**Response 200:**
- expires_in: number — 3600
- parts: array of `{ part_number: number, url: string }` — o cliente faz `PUT {url}` com os bytes da parte

**Error responses:**
- 400 VALIDATION_ERROR: body inválido
- 400 INVALID_PART_NUMBER: algum `part_number` > `part_count` do vídeo
- 401 Unauthorized
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_DRAFT

---

#### POST /videos/{id}/upload/complete (SI-03.8)

Conclui o multipart upload a partir das partes armazenadas (`ListParts` — o cliente não envia ETags), publica o job e move o vídeo para `processing`. Idempotente: para vídeos já em `processing`/`ready`/`failed` devolve o estado atual sem republicar (per `phase-03-videos/TD-10`).

**Request headers:**
- Authorization: Bearer {access_token}

**Request body:** vazio.

**Response 202:** `VideoResponse`

**Error responses:**
- 400 VALIDATION_ERROR: `id` não é UUID
- 401 Unauthorized
- 404 VIDEO_NOT_FOUND
- 409 UPLOAD_INCOMPLETE: nem todas as `part_count` partes estão armazenadas
- 422 UPLOAD_SIZE_MISMATCH: soma dos tamanhos das partes ≠ `declared_size_bytes`
- 503 PROCESSING_QUEUE_UNAVAILABLE: o broker não confirmou a publicação em 5 s — o vídeo permanece `draft` e a chamada pode ser repetida

---

#### DELETE /videos/{id}/upload (SI-03.8)

Cancela um rascunho: aborta o multipart upload e remove o registro (per `phase-03-videos/TD-09`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 204:** No content.

**Error responses:**
- 400 VALIDATION_ERROR: `id` não é UUID
- 401 Unauthorized
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_DRAFT

---

#### GET /videos/{id} (SI-03.12)

Representação do vídeo para o dono — reflete o ciclo de status e os metadados extraídos.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:** `VideoResponse`

**Error responses:**
- 400 VALIDATION_ERROR: `id` não é UUID
- 401 Unauthorized
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/{public_id}/stream (SI-03.12)

URL única de reprodução. Pública; redireciona para uma URL pré-assinada de `GetObject`, e o storage responde requisições `Range` com `206 Partial Content` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`).

**Request path parameters:**
- public_id: string — 11 chars `[A-Za-z0-9_-]`

**Response 302:**
- Location: URL pré-assinada do original (expira em 3600 s)
- Cache-Control: no-store

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` inexistente, mal formado ou vídeo fora de `ready`

---

#### GET /videos/{public_id}/download (SI-03.12)

Download pelo usuário. Igual a `/stream`, mas a URL é assinada com `response-content-disposition=attachment; filename="{original_file_name}"` (per `phase-03-videos/TD-07`).

**Request path parameters:**
- public_id: string — 11 chars `[A-Za-z0-9_-]`

**Response 302:**
- Location: URL pré-assinada com `Content-Disposition: attachment`
- Cache-Control: no-store

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` inexistente, mal formado ou vídeo fora de `ready`

---

#### Validation Rules — videos

- `file_name`: required, string, 1–255 chars
- `file_size`: required, integer, min 1, max 10737418240
- `content_type`: required, string, regex `^video\/[\w.+-]+$`
- `title`: optional, string, 1–100 chars
- `part_numbers`: required, array, 1–100 itens, `ArrayUnique`, cada item integer ≥ 1
- `id` (path): `ParseUUIDPipe`
- `public_id` (path): 11 chars `[A-Za-z0-9_-]`; valor mal formado responde 404 (não revela o formato)

### Authorization Matrix

Per `phase-03-videos/TD-08`. "Owner" = o vídeo pertence ao canal do usuário autenticado; vídeos de outros canais respondem 404 `VIDEO_NOT_FOUND` (não revelam existência).

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ (cria no próprio canal) | — |
| GET /videos/{id}/upload | ✗ | ✗ | ✓ |
| POST /videos/{id}/upload/part-urls | ✗ | ✗ | ✓ |
| POST /videos/{id}/upload/complete | ✗ | ✗ | ✓ |
| DELETE /videos/{id}/upload | ✗ | ✗ | ✓ |
| GET /videos/{id} | ✗ | ✗ | ✓ |
| GET /videos/{public_id}/stream | ✓ (somente `ready`) | ✓ (somente `ready`) | ✓ (somente `ready`) |
| GET /videos/{public_id}/download | ✓ (somente `ready`) | ✓ (somente `ready`) | ✓ (somente `ready`) |

Rate limiting: o `ThrottlerGuard` global herdado (10 req/min) não se aplica a `VideosController` (`@SkipThrottle()`, nota ICC-1 em `phase-03-videos/TD-08`).

### Error Catalog

Formato herdado de `phase-02-auth/TD-07`: `{ statusCode, error, message }`, emitido por `DomainExceptionFilter` a partir de subclasses de `DomainException` em `src/common/exceptions/domain.exception.ts`.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| CHANNEL_NOT_FOUND | 404 | Usuário autenticado sem canal ao iniciar upload |
| VIDEO_NOT_FOUND | 404 | Vídeo inexistente, de outro canal, ou `public_id` sem vídeo `ready` |
| VIDEO_NOT_DRAFT | 409 | Operação de upload (estado, part-urls, cancelar) em vídeo fora de `draft` |
| INVALID_PART_NUMBER | 400 | `part_number` maior que `part_count` do vídeo |
| UPLOAD_INCOMPLETE | 409 | Concluir upload com partes faltando |
| UPLOAD_SIZE_MISMATCH | 422 | Soma das partes ≠ tamanho declarado |
| PROCESSING_QUEUE_UNAVAILABLE | 503 | Broker não confirmou a publicação do job em 5 s |
| VALIDATION_ERROR | 400 | Herdado (`ValidationExceptionFilter`) — DTO ou parâmetro inválido |

Falhas de processamento no worker não geram resposta HTTP: ficam em `videos.status = failed` + `failure_reason` (per `phase-03-videos/TD-09`).

### Events/Messages

#### video.uploaded

**Payload** (envelope do transport RMQ do NestJS: `{ "pattern": "video.uploaded", "data": { ... } }`):

```json
{ "videoId": "uuid" }
```

O payload carrega só o id; o worker relê o registro do banco, então mensagens duplicadas ou atrasadas nunca trazem estado velho (per `phase-03-videos/TD-10`).

**Producer:** `VideoProcessingPublisher` (API, `src/videos/`), via `ClientProxy.emit` + `lastValueFrom` com timeout de 5 s — resolve só após o publisher confirm do broker (per `phase-03-videos/TD-01`, `phase-03-videos/TD-10`)
**Consumer:** `VideoProcessingController` (`@EventPattern('video.uploaded')`) no worker, delegando a `VideoProcessingService` (per `phase-03-videos/TD-04`)
**Trigger:** `POST /videos/{id}/upload/complete` concluiu o multipart upload de um vídeo em `draft`
**Delivery semantics:** at-least-once — mensagens persistentes, ack manual (`noAck: false`, `prefetchCount: 1`); consumidor idempotente ignora vídeos `ready`/`failed` (per `phase-03-videos/TD-10`)

**Queue topology** (declarada com argumentos idênticos por producer e consumer — per `phase-03-videos/TD-01`, `phase-03-videos/TD-09`):

| Queue | Arguments | Role |
|-------|-----------|------|
| `video-processing` (`VIDEO_PROCESSING_QUEUE`) | `durable: true`, `x-queue-type: quorum`, `x-delivery-limit: 5`, `x-dead-letter-exchange: ""`, `x-dead-letter-routing-key: video-processing.dlq` | fila de jobs |
| `video-processing.dlq` (`{VIDEO_PROCESSING_QUEUE}.dlq`) | `durable: true`, `x-queue-type: quorum` | mensagens envenenadas (excederam o delivery limit) — declarada pelo worker no bootstrap |

**Retry policy** (per `phase-03-videos/TD-09`): tentativa = `x-delivery-count` + 1 (header ausente na 1ª entrega). Erro com tentativa < 3 → `nack(requeue=true)`. Erro na 3ª tentativa → grava `failed` + `failure_reason` e `ack`. O `x-delivery-limit: 5` só age se o próprio consumidor falhar antes de decidir (ex.: crash), mandando a mensagem para a DLQ.

---

## Dependency Map

```
SI-03.1 (root — infra: deps, FFmpeg, MinIO, RabbitMQ)
├── SI-03.2 — depends on SI-03.1 (config aponta para os serviços do Compose)
│   └── SI-03.3 — depends on SI-03.2 (StorageService consome storageConfig)
│       └── SI-03.9 — depends on SI-03.1 + SI-03.3 (FFmpeg na imagem; URL pré-assinada nos testes)
└── SI-03.4 — depends on SI-03.1 (entidade + migration)

SI-03.5 (root, independent — public id + ChannelsService.findByUserId)

SI-03.2 + SI-03.3 + SI-03.4 + SI-03.5
└── SI-03.6 — topologia da fila + publisher + VideosModule
    └── SI-03.7 — VideosService (orquestração do upload)
        └── SI-03.8 — endpoints de upload

SI-03.4 + SI-03.6 + SI-03.9
└── SI-03.10 — VideoProcessingService
    └── SI-03.11 — consumidor, entrypoint e serviço video-worker

SI-03.8 + SI-03.11
└── SI-03.12 — consulta, streaming e download
    └── SI-03.13 — openapi.json + CLAUDE.md
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, FFmpeg e serviços de storage e fila no Compose
- [ ] SI-03.2 — Namespaces de configuração de storage e mensageria
- [ ] SI-03.3 — Serviço de object storage
- [ ] SI-03.4 — Entidade Video e migration CreateVideos
- [ ] SI-03.5 — Identificador público do vídeo e busca de canal por usuário
- [ ] SI-03.6 — Topologia da fila e publicação do job de processamento
- [ ] SI-03.7 — Orquestração do upload no VideosService
- [ ] SI-03.8 — Endpoints de upload de vídeo
- [ ] SI-03.9 — Extração de metadados e frame com FFmpeg
- [ ] SI-03.10 — Processamento do vídeo no worker
- [ ] SI-03.11 — Worker de vídeo: consumidor da fila, entrypoint e serviço no Compose
- [ ] SI-03.12 — Endpoints de consulta, streaming e download
- [ ] SI-03.13 — Spec OpenAPI exportada e documentação de IA

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
