// Loaded by Jest `setupFiles` right after `dotenv/config`.
// Tests run inside the Compose network, so presigned URLs handed to the test
// client must target the internal storage endpoint; and tests use their own
// queue so the running video-worker container never consumes test jobs.
process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://minio:9000';
process.env.VIDEO_PROCESSING_QUEUE = 'video-processing.test';
