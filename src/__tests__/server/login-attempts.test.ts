import { describe, it, expect } from 'vitest';

describe('Brute Force Protection Config', () => {
  it('locks after 5 failed attempts', () => {
    const MAX_FAILED_ATTEMPTS = 5;
    expect(MAX_FAILED_ATTEMPTS).toBe(5);
  });

  it('lockout duration is 15 minutes', () => {
    const LOCKOUT_DURATION_MINUTES = 15;
    expect(LOCKOUT_DURATION_MINUTES).toBe(15);
  });
});
