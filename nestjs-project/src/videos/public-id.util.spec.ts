import { generatePublicId, isValidPublicId } from './public-id.util';

describe('public-id.util', () => {
  describe('generatePublicId', () => {
    it('should return 11 URL-safe base64 characters', () => {
      for (let i = 0; i < 100; i++) {
        expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
      }
    });

    it('should not repeat across 10 000 calls', () => {
      const ids = new Set(Array.from({ length: 10_000 }, generatePublicId));
      expect(ids.size).toBe(10_000);
    });
  });

  describe('isValidPublicId', () => {
    it('should accept a generated id', () => {
      expect(isValidPublicId(generatePublicId())).toBe(true);
    });

    it.each([
      '',
      'xyz',
      'AAAAAAAAAAAA',
      'AAAAAAAAAA',
      'AAAAA/AAAAA',
      'AAAAA+AAAAA',
    ])('should reject %p', (value) => {
      expect(isValidPublicId(value)).toBe(false);
    });
  });
});
