import { attemptFromDeliveryCount, shouldRetry } from './processing-attempts';

describe('processing-attempts', () => {
  describe('attemptFromDeliveryCount', () => {
    it.each([
      [undefined, 1],
      [0, 1],
      [1, 2],
      [2, 3],
      ['2', 3],
      ['garbage', 1],
    ])('should map x-delivery-count %p to attempt %p', (header, attempt) => {
      expect(attemptFromDeliveryCount(header)).toBe(attempt);
    });
  });

  describe('shouldRetry', () => {
    it('should retry on attempts 1 and 2', () => {
      expect(shouldRetry(1)).toBe(true);
      expect(shouldRetry(2)).toBe(true);
    });

    it('should stop on attempt 3', () => {
      expect(shouldRetry(3)).toBe(false);
    });
  });
});
