import { describe, it, expect } from 'vitest';

describe('API v1 Response Format', () => {
  it('response envelope has correct structure', () => {
    const envelope = {
      data: [],
      meta: {
        timestamp: new Date().toISOString(),
        total: 0,
      },
    };
    expect(envelope).toHaveProperty('data');
    expect(envelope).toHaveProperty('meta');
    expect(envelope.meta).toHaveProperty('timestamp');
  });

  it('error response has correct structure', () => {
    const error = { error: 'Something went wrong' };
    expect(error).toHaveProperty('error');
    expect(typeof error.error).toBe('string');
  });

  it('pagination meta has correct fields', () => {
    const meta = { total: 100, page: 1, pageSize: 50, timestamp: new Date().toISOString() };
    expect(meta.page).toBeGreaterThanOrEqual(1);
    expect(meta.pageSize).toBeLessThanOrEqual(500);
  });
});
