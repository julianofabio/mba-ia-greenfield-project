/** Fixed multipart part size: 64 MiB → ~160 parts for 10 GiB (S3 max 10 000). */
export const PART_SIZE_BYTES = 64 * 1024 * 1024;

/** Upload size limit: 10 GiB. */
export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export const MAX_TITLE_LENGTH = 100;

/** Max part URLs signed per request. */
export const MAX_PART_URLS_PER_REQUEST = 100;

export function computePartCount(sizeBytes: number): number {
  return Math.ceil(sizeBytes / PART_SIZE_BYTES);
}

/** Draft title when none is given: the file name without its extension. */
export function defaultTitleFromFileName(fileName: string): string {
  const name = fileName.trim();
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot).trim() : name;
  return (base || name).slice(0, MAX_TITLE_LENGTH);
}
