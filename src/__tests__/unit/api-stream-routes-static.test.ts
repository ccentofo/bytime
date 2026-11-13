import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-large-report-responses.md §11 T15 (Q4): /api/v1/periods and /api/v1/timesheets/approved stream their
 * JSON through apiStreamResponse (behaviour: api-stream-response.test.ts T9; integration: approver-rules,
 * calendar-dates-fixes, migration-import). Audit fix round 1 (FR2): the cost CSV and /api/v1/costs pin maxDuration too.
 */

const ROOT = path.resolve(__dirname, '../../..');

describe('streamed routes (static, large-report-responses §6.2, §6.3, §6.5)', () => {
  for (const rel of ['src/app/api/v1/periods/route.ts', 'src/app/api/v1/timesheets/approved/route.ts']) {
    it(rel, () => {
      const src = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toContain('apiStreamResponse(');
      expect(src).not.toContain('apiResponse(');
      expect(src).toMatch(/^export const maxDuration = 300;$/m);
    });
  }

  // Audit fix round 1 (FR2): the two streamed routes of §6.2/§6.3 state the 300 s limit too (§6.2 item 4, §6.3 item 2).
  for (const rel of ['src/app/api/reports/cost-report-csv/route.ts', 'src/app/api/v1/costs/route.ts']) {
    it(`${rel} states maxDuration = 300`, () => {
      expect(readFileSync(path.join(ROOT, rel), 'utf8')).toMatch(/^export const maxDuration = 300;$/m);
    });
  }
});
