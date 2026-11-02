---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-02T11:05:08-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-02T11:05:08-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Testing guide prescribes local-FS storage in tests; TD-11 and brief require real MinIO"
    resolved_by: phase-03-videos/TD-11
  - id: ICC-1
    status: resolved
    summary: "Inherited global ThrottlerGuard (10 req/min) throttles upload parts and stream redirects"
    resolved_by: phase-03-videos/TD-08
  - id: AMB-1
    status: resolved
    summary: "Draft pre-registration input undefined: title source and accepted file types"
    resolved_by: phase-03-videos/TD-02
  - id: AMB-2
    status: resolved
    summary: "'duração e metadados': which technical metadata fields are persisted"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — RabbitMQ Client Integration"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Large File Upload Strategy (up to 10GB)"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Object Storage Layout and Access Model"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Video Worker Runtime Topology"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Media Probing and Thumbnail Extraction"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Unique Video URL Identifier"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Access Policy for Upload, Playback and Download"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Video Status Lifecycle and Processing Failure Handling"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Consistency Between Database State and Job Publication"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Testing Strategy for Storage, Queue and Worker"
    resolved_by: phase-03-videos/TD-11
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ (UI not in scope — `## UI Inventory` absent.)

## Resolved Issues

- **IC-1** _(resolved_by phase-03-videos/TD-11)_ — Testing guide's local-FS storage strategy superseded for Phase 03 — tests use the real MinIO Compose service (note on TD-11).
- **ICC-1** _(resolved_by phase-03-videos/TD-08)_ — Video controller opts out of the inherited global ThrottlerGuard with `@SkipThrottle()`; auth endpoints keep 10 req/min (note on TD-08).
- **AMB-1** _(resolved_by phase-03-videos/TD-02)_ — Initiation input = fileName, fileSize (≤ 10 737 418 240), contentType `video/*`, optional title (fallback: file name without extension); size re-checked at completion (note on TD-02).
- **AMB-2** _(resolved_by phase-03-videos/TD-05)_ — Persisted metadata = duration_seconds, width, height, video_codec, audio_codec, container_format, bitrate, size_bytes as typed nullable columns (note on TD-05).
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 decided — Option A.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 decided — Option A.
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 decided — Option A.
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 decided — Option A.
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 decided — Option A.
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 decided — Option A.
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 decided — Option A.
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 decided — Option A.
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 decided — Option A.
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 decided — Option A.
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 decided — Option A.
