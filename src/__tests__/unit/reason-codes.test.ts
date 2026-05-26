import { describe, it, expect } from 'vitest';
import { REASON_CODES } from '@/lib/reason-codes';

describe('REASON_CODES', () => {
  it('contains CORRECTION code', () => {
    expect(REASON_CODES.find((r) => r.value === 'CORRECTION')).toBeDefined();
  });
  it('contains LATE_ENTRY code', () => {
    expect(REASON_CODES.find((r) => r.value === 'LATE_ENTRY')).toBeDefined();
  });
  it('all entries have value and label', () => {
    for (const code of REASON_CODES) {
      expect(code.value).toBeTruthy();
      expect(code.label).toBeTruthy();
    }
  });
});
