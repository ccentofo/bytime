import { describe, it, expect } from 'vitest';
import { isValidSlug } from '@/lib/tenant/slug-rules';

/**
 * SWEEP-FINDINGS.md A1-G12: a workspace name is one DNS label — 1 to 63 lowercase ASCII letters, digits and hyphens, no
 * leading or trailing hyphen. A dot (a second label), 64 characters and non-ASCII letters are refused.
 */
describe('A1-G12: isValidSlug', () => {
  it.each([['a'], ['acme'], ['acme-corp-2'], ['a'.repeat(63)], ['0abc']])('accepts %s', (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });

  it.each([
    ['a.b', 'a dot (a second DNS label)'],
    ['acme.corp', 'a dot'],
    ['a'.repeat(64), '64 characters'],
    ['café', 'a non-ASCII letter'],
    ['ünï', 'non-ASCII letters'],
    ['аcme', 'a Cyrillic "а" that looks like "a"'],
    ['Acme', 'upper case'],
    ['-acme', 'a leading hyphen'],
    ['acme-', 'a trailing hyphen'],
    ['ac me', 'a space'],
    ['acme_corp', 'an underscore'],
    ['', 'empty'],
  ])('refuses %j (%s)', (slug) => {
    expect(isValidSlug(slug)).toBe(false);
  });
});
