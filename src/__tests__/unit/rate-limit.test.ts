import { describe, it, expect } from 'vitest';
import { checkRateLimit } from '@/lib/rate-limit';
import { memoryConsume, memoryRefund } from '@/lib/rate-limit/memory';

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

// feature-plan-upstash-rate-limiting.md T16: the shared-limit fallback's refund.
describe('memoryRefund', () => {
  it('takes one count back in the current window', () => {
    const key = 'test-refund-1';
    for (let i = 0; i < 5; i++) memoryConsume(key, 5, 60000);
    expect(memoryConsume(key, 5, 60000).allowed).toBe(false);
    memoryRefund(key);
    expect(memoryConsume(key, 5, 60000).allowed).toBe(true);
    expect(memoryConsume(key, 5, 60000).allowed).toBe(false);
  });

  it('never goes below 0, and does nothing for an unknown key', () => {
    const key = 'test-refund-2';
    memoryConsume(key, 2, 60000);
    memoryRefund(key);
    memoryRefund(key);
    memoryRefund('test-refund-never-seen');
    expect(memoryConsume(key, 2, 60000).allowed).toBe(true);
    expect(memoryConsume(key, 2, 60000).allowed).toBe(true);
    expect(memoryConsume(key, 2, 60000).allowed).toBe(false);
  });

  it('a refused call is not counted, and resetAt is the window end', () => {
    const key = 'test-refund-3';
    const first = memoryConsume(key, 1, 60000);
    const refused = memoryConsume(key, 1, 60000);
    expect(refused).toMatchObject({ allowed: false, resetAt: first.resetAt });
    memoryRefund(key);
    expect(memoryConsume(key, 1, 60000).allowed).toBe(true);
  });
});
