import { MAX_PROCESSING_ATTEMPTS } from './video-processing.queue';

/**
 * Current attempt from the quorum-queue `x-delivery-count` header (absent on
 * the first delivery, incremented on every requeue).
 */
export function attemptFromDeliveryCount(header: unknown): number {
  const count = Number(header);
  return Number.isInteger(count) && count > 0 ? count + 1 : 1;
}

export function shouldRetry(attempt: number): boolean {
  return attempt < MAX_PROCESSING_ATTEMPTS;
}
