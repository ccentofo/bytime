import { describe, it, expect } from 'vitest';
import type { ReadDb, WriteDb, AuthDb } from '@/db';

// The write gate is enforced by the compiler (feature-plan-terms-compliance-fixes.md §5.1): a read client
// has no write methods. These `@ts-expect-error` lines FAIL `tsc --noEmit` if ReadDb ever regains them.
function typeChecks(read: ReadDb, write: WriteDb, auth: AuthDb) {
  // @ts-expect-error — ReadDb has no insert
  void read.insert;
  // @ts-expect-error — ReadDb has no update
  void read.update;
  // @ts-expect-error — ReadDb has no delete
  void read.delete;
  // @ts-expect-error — ReadDb has no transaction
  void read.transaction;
  // @ts-expect-error — ReadDb has no execute
  void read.execute;
  // @ts-expect-error — a read client can't be passed where a WriteDb is required
  const w: WriteDb = read;
  void w;
  void write.insert;
  void auth.update;
  void read.select;
}

describe('database client types', () => {
  it('compile-time checks are present (enforced by tsc)', () => {
    expect(typeof typeChecks).toBe('function');
  });
});
