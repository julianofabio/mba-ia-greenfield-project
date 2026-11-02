/** S3 error raised when a multipart upload id is unknown (aborted or completed). */
export function isNoSuchUploadError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'NoSuchUpload';
}
