import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-large-report-responses.md §11 T15 (Q4): /api/v1/periods and /api/v1/timesheets/approved stream their
 * JSON through apiStreamResponse (behaviour: api-stream-response.test.ts T9; integration: approver-rules,
 * calendar-dates-fixes, migration-import).
 */

const ROOT = path.resolve(__dirname, '../../..');

describe('Q4 v1 routes stream (static, large-report-responses §6.5)', () => {
  for (const rel of ['src/app/api/v1/periods/route.ts', 'src/app/api/v1/timesheets/approved/route.ts']) {
    it(rel, () => {
      const src = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toContain('apiStreamResponse(');
      expect(src).not.toContain('apiResponse(');
      expect(src).toMatch(/^export const maxDuration = 300;$/m);
    });
  }
});
