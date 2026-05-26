import { describe, it, expect } from 'vitest';
import { checkRateLimit } from '@/lib/rate-limit';

describe('checkRateLimit', () => {
  it('allows first request', () => {
    const result = checkRateLimit('test-unique-1', 5, 60000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('allows requests up to the limit', () => {
    const key = 'test-unique-2';
    for (let i = 0; i < 5; i++) {
      const result = checkRateLimit(key, 5, 60000);
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks requests over the limit', () => {
    const key = 'test-unique-3';
    for (let i = 0; i < 5; i++) {
      checkRateLimit(key, 5, 60000);
    }
    const result = checkRateLimit(key, 5, 60000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets after window expires', () => {
    const key = 'test-unique-4';
    // Fill up the limit with a very short window
    for (let i = 0; i < 5; i++) {
      checkRateLimit(key, 5, 1); // 1ms window
    }
    // Wait for window to expire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = checkRateLimit(key, 5, 1);
        expect(result.allowed).toBe(true);
        resolve();
      }, 10);
    });
  });
});
