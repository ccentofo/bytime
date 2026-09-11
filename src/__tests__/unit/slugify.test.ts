import { describe, it, expect } from 'vitest';
import { slugify } from '@/lib/tenant/slugify';

describe('slugify — company name → DNS-safe workspace slug', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Acme Corp')).toBe('acme-corp');
  });

  it('strips punctuation and collapses separator runs', () => {
    expect(slugify('A.C.M.E, Inc!')).toBe('a-c-m-e-inc');
    expect(slugify('a   b___c')).toBe('a-b-c');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('  --Acme--  ')).toBe('acme');
  });

  it('caps length at 63 chars (DNS label limit)', () => {
    expect(slugify('x'.repeat(100)).length).toBeLessThanOrEqual(63);
  });

  it('handles already-clean input', () => {
    expect(slugify('acme')).toBe('acme');
    expect(slugify('my-company')).toBe('my-company');
  });
});
