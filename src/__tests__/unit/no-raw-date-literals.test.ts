import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// §4 Guardrail: no JS `Date` for calendar dates anywhere in `src/`.
//
// `new Date('YYYY-MM-DD')` and `new Date("YYYY-MM-DD")` parse as UTC midnight, which silently
// shifts to the previous day in any timezone behind UTC — exactly the class of bug this feature
// (CalendarDate) exists to eliminate. `.toISOString().split('T')[0]` has the same problem in
// reverse: it reads a Date back out as a calendar day via UTC, which is wrong whenever the
// workspace isn't UTC. Both must be expressed via `@/lib/calendar-date` instead.
//
// Scans every .ts/.tsx file under src/, skipping test files (test fixtures legitimately
// construct specific instants/edge cases) and this file itself. A finding can be allowlisted
// with a `// no-raw-date-literals: allow <reason>` comment on the line immediately above it.
// ---------------------------------------------------------------------------

const SRC_DIR = path.resolve(__dirname, '../..');

const DATE_LITERAL_PATTERN = /new Date\(\s*['"]\d{4}-\d{2}-\d{2}['"]\s*\)/;
const ISO_SPLIT_PATTERN = /\.toISOString\(\)\.split\(\s*['"]T['"]\s*\)/;
const ALLOW_COMMENT_PATTERN = /no-raw-date-literals:\s*allow\b/;

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      walk(fullPath, files);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('no raw Date literals for calendar dates (§4 guardrail)', () => {
  const files = walk(SRC_DIR);

  it('contains no `new Date(\'YYYY-MM-DD\')` date-only literal construction', () => {
    const violations: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!DATE_LITERAL_PATTERN.test(lines[i])) continue;
        const prevLine = lines[i - 1] ?? '';
        if (ALLOW_COMMENT_PATTERN.test(prevLine)) continue;
        violations.push(`${path.relative(SRC_DIR, file)}:${i + 1}: ${lines[i].trim()}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('contains no `.toISOString().split(\'T\')[0]` calendar-day extraction', () => {
    const violations: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!ISO_SPLIT_PATTERN.test(lines[i])) continue;
        const prevLine = lines[i - 1] ?? '';
        if (ALLOW_COMMENT_PATTERN.test(prevLine)) continue;
        violations.push(`${path.relative(SRC_DIR, file)}:${i + 1}: ${lines[i].trim()}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
