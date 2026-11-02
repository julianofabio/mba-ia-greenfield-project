import { randomBytes } from 'node:crypto';

// 8 random bytes → 11 base64url chars (64 bits of entropy, YouTube-style).
const PUBLIC_ID_BYTES = 8;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function generatePublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString('base64url');
}

export function isValidPublicId(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value);
}
