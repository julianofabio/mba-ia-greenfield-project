---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12
target_file: test/videos-playback.e2e-spec.ts
---

# Video Details, Streaming and Download — Test Plan

## Application Overview

Endpoints that close the user-facing cycle after an upload: `GET /videos/{id}` lets the owner follow the status lifecycle and the extracted metadata; `GET /videos/{public_id}/stream` and `GET /videos/{public_id}/download` are the unique public URLs of a ready video — they redirect (302) to short-lived presigned storage URLs, and the storage answers `Range` requests with `206 Partial Content` (streaming without full download) or serves the file as an attachment (download).

## Test Scenarios

### 1. Owner details and processing outcome

**Setup:** `beforeEach` runs `cleanAllTables`; the HTTP app is bootstrapped from `AppModule` with the `main.ts` globals, and the video worker is booted in-process (`NestFactory.createMicroservice(WorkerModule, ...)`) against the test queue; a short MP4 (H.264 + AAC, 320x240, 3 s) is generated with FFmpeg `lavfi` into a temp file; a helper uploads it end-to-end (initiate → part URLs → PUT → complete) and polls `GET /videos/{id}` until `status` is `ready` or `failed` (timeout 60 s).

#### 1.1. owner-sees-ready-video-with-metadata

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. Owner uploads the generated MP4 and completes the upload
    - expect: GET /videos/{id} right after completion returns 200 with `status` `processing` or `ready`
  2. Owner polls GET /videos/{id} until processing ends
    - expect: status 200 with `status: "ready"`
    - expect: `duration_seconds` ≈ 3, `width: 320`, `height: 240`, `video_codec: "h264"`, `audio_codec: "aac"`
    - expect: `thumbnail_url` is a URL whose GET returns 200 with `Content-Type: image/jpeg`

#### 1.2. details-hidden-from-other-users-and-anonymous

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. A second confirmed user calls GET /videos/{id} on the owner's video
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`
  2. An anonymous caller calls GET /videos/{id}
    - expect: status 401

### 2. Streaming and download of a ready video

**Setup:** same as group 1, with one video already `ready`.

#### 2.1. stream-redirects-and-serves-partial-content

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. Anonymous GET /videos/{public_id}/stream without following redirects
    - expect: status 302 with a `Location` header and `Cache-Control: no-store`
  2. GET the `Location` URL with `Range: bytes=0-1023`
    - expect: status 206 with `Content-Range: bytes 0-1023/<size>` and a 1024-byte body equal to the first 1024 bytes of the uploaded file

#### 2.2. download-redirects-to-attachment

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. Anonymous GET /videos/{public_id}/download without following redirects
    - expect: status 302 with a `Location` header
  2. GET the `Location` URL
    - expect: status 200 with `Content-Disposition: attachment; filename="<original_file_name>"`
    - expect: the body is byte-identical to the uploaded file

#### 2.3. each-video-has-its-own-unique-url

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. The same owner uploads two different generated videos until both are `ready`
    - expect: the two `public_id` values differ
  2. GET each `/videos/{public_id}/stream` `Location` URL in full
    - expect: each response body equals the file uploaded for that video

### 3. Playback of unavailable videos

**Setup:** same as group 1, without the in-process worker (videos stay in the state the scenario puts them in).

#### 3.1. stream-not-available-before-ready

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. Create a draft video (initiate only) and GET /videos/{public_id}/stream
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`
  2. Set a video to `processing` and to `failed` (direct DB update) and GET its stream and download URLs
    - expect: every call returns 404 with `error: "VIDEO_NOT_FOUND"`

#### 3.2. unknown-and-malformed-ids-look-the-same

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-02T14:12:30Z

**Steps:**
  1. GET /videos/xyz/stream
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/AAAAAAAAAAA/stream (well-formed, nonexistent)
    - expect: status 404 with the same body as step 1
