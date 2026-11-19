import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * SWEEP-FINDINGS.md A3-G6: both migration journals (tenant and control plane) are well formed: `idx` is each entry's
 * position, `when` strictly increases (drizzle applies a migration only if its `when` is after the last applied one, so
 * an out-of-order `when` is silently skipped in every existing database), tags are unique, and the folder's SQL files
 * match the entries one to one.
 */

type Journal = { entries: Array<{ idx: number; when: number; tag: string }> };

describe.each([
  ['tenant', 'drizzle'],
  ['control plane', 'drizzle/control-plane'],
])('the %s migration journal (A3-G6)', (_label, folder) => {
  const dir = path.resolve(process.cwd(), folder);
  const journal = JSON.parse(readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8')) as Journal;

  it('has entries, each idx equal to its position', () => {
    expect(journal.entries.length).toBeGreaterThan(0);
    journal.entries.forEach((e, i) => expect(e.idx, e.tag).toBe(i));
  });

  it('`when` strictly increases', () => {
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i].when, `${journal.entries[i].tag} after ${journal.entries[i - 1].tag}`).toBeGreaterThan(journal.entries[i - 1].when);
    }
  });

  it('tags are unique and start with their zero-padded idx', () => {
    expect(new Set(journal.entries.map((e) => e.tag)).size).toBe(journal.entries.length);
    for (const e of journal.entries) expect(e.tag.startsWith(String(e.idx).padStart(4, '0') + '_'), e.tag).toBe(true);
  });

  it('the SQL files match the entries one to one', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    expect(files).toEqual(journal.entries.map((e) => `${e.tag}.sql`).sort());
  });
});
