---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-upload.e2e-spec.ts
---

# Video Upload Endpoints — Test Plan

## Application Overview

Endpoints that let an authenticated user upload a video of up to 10GB straight to object storage: `POST /videos` pre-registers the video as a draft and opens an S3 multipart upload, `POST /videos/{id}/upload/part-urls` hands out presigned part URLs, `GET /videos/{id}/upload` reports the parts already stored (resume), `POST /videos/{id}/upload/complete` assembles the object and queues processing, and `DELETE /videos/{id}/upload` cancels a draft. No video byte crosses the API — the test client PUTs part bytes to the presigned MinIO URLs.

## Test Scenarios

### 1. Draft pre-registration — POST /videos

**Setup:** `beforeEach` cleans `videos`, `refresh_tokens`, `verification_tokens`, `channels`, `users` (`cleanAllTables`); the app is bootstrapped from `AppModule` with the global `ValidationPipe` and the two exception filters from `main.ts`; a confirmed user is registered and logged in to obtain an `access_token` (two users when ownership is exercised).

#### 1.1. initiate-upload-creates-draft

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. POST /videos with `Authorization: Bearer <token>` and `{ file_name: "aula.mp4", file_size: 157286400, content_type: "video/mp4" }`
    - expect: status 201
    - expect: body has `status: "draft"`, `part_size: 67108864`, `part_count: 3`, `title: "aula"`, an 11-char `public_id` and a uuid `id`
    - expect: the `videos` row exists with `status = draft` and a non-null `upload_id`

#### 1.2. initiate-upload-rejects-invalid-body

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. POST /videos with `file_size: 10737418241`
    - expect: status 400 with `error: "VALIDATION_ERROR"`
  2. POST /videos with `content_type: "image/png"`
    - expect: status 400 with `error: "VALIDATION_ERROR"`
  3. POST /videos with an unknown property `foo: "bar"`
    - expect: status 400 with `error: "VALIDATION_ERROR"`
    - expect: no `videos` row was created

#### 1.3. initiate-upload-requires-authentication

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. POST /videos without `Authorization` header and a valid body
    - expect: status 401

### 2. Direct-to-storage part upload and resume

**Setup:** same as group 1, plus a draft created with `file_size` = 3 parts (two full 64 MiB parts are generated in memory only when a scenario needs a full upload; resume scenarios use a 2-part draft of `67108864 + 1024` bytes).

#### 2.1. part-urls-accept-direct-put

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. POST /videos/{id}/upload/part-urls with `{ part_numbers: [1, 2] }`
    - expect: status 200 with `expires_in: 3600` and two `parts` entries for part numbers 1 and 2
  2. PUT the bytes of part 1 to `parts[0].url`
    - expect: storage answers 200 with an `ETag` header

#### 2.2. upload-state-lists-stored-parts

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. Upload only part 1 through its presigned URL
  2. GET /videos/{id}/upload
    - expect: status 200 with `part_size`, `part_count` and `uploaded_parts` equal to `[{ part_number: 1, size_bytes: 67108864 }]`

#### 2.3. part-urls-reject-out-of-range-part

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. POST /videos/{id}/upload/part-urls with `{ part_numbers: [4] }` for a 3-part draft
    - expect: status 400 with `error: "INVALID_PART_NUMBER"`

### 3. Completion and cancellation

**Setup:** same as group 1; drafts sized to 2 parts (`67108864 + 1024` bytes) so the full upload stays small.

#### 3.1. complete-upload-moves-to-processing

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. Upload both parts through their presigned URLs
  2. POST /videos/{id}/upload/complete
    - expect: status 202 with `status: "processing"` and `size_bytes` equal to the declared size
    - expect: the stored object `videos/{id}/original` exists in the bucket
    - expect: one `video.uploaded` message with `{ videoId: id }` is in the test queue

#### 3.2. cancel-draft-removes-video

**Covers AC:** #9
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. DELETE /videos/{id}/upload for a draft
    - expect: status 204
    - expect: the `videos` row no longer exists
  2. DELETE /videos/{id}/upload again
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`

### 4. Ownership and rate limiting

**Setup:** same as group 1 with two confirmed users, A (owner) and B.

#### 4.1. upload-routes-hide-other-channels-videos

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. User A creates a draft
  2. User B calls GET /videos/{id}/upload, POST /videos/{id}/upload/part-urls, POST /videos/{id}/upload/complete and DELETE /videos/{id}/upload on A's draft
    - expect: every call returns 404 with `error: "VIDEO_NOT_FOUND"`
    - expect: A's draft is unchanged (`status = draft`)

#### 4.2. upload-routes-skip-global-throttle

**Covers AC:** #10
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. User A calls GET /videos/{id}/upload 12 times in a row within the same minute
    - expect: every call returns 200; none returns 429
