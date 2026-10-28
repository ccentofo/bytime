import { describe, it, expect, vi } from 'vitest';

/** feature-plan-ux-timesheet.md A4.5 / A5 "Day total" (UX3-D4 + L1), the pure rule: refuse only new > 24 AND new > prev. */

vi.mock('server-only', () => ({}));
import { dayTotalRefusal } from '@/server/internal/day-totals';

const D = ['2026-10-05', '2026-10-06', '2026-10-07'] as never[];

describe('dayTotalRefusal', () => {
  it('new ≤ 24 → ok, whatever it was before', () => {
    expect(dayTotalRefusal([D[0]], {}, { '2026-10-05': 24 })).toBeNull();
    expect(dayTotalRefusal([D[0]], { '2026-10-05': 30 }, { '2026-10-05': 12 })).toBeNull();
  });

  it('new > 24 and higher than before → refused, naming the day and the total', () => {
    expect(dayTotalRefusal([D[0]], {}, { '2026-10-05': 25 })).toBe('Hours for Mon, Oct 5, 2026 would total 25. A day can\'t exceed 24 hours across all charge codes.');
    expect(dayTotalRefusal([D[0]], { '2026-10-05': 30 }, { '2026-10-05': 31 })).toMatch(/would total 31/);
  });

  it('L1: an imported day already over 24 may be lowered or kept, never raised', () => {
    expect(dayTotalRefusal([D[0]], { '2026-10-05': 30 }, { '2026-10-05': 28 })).toBeNull();
    expect(dayTotalRefusal([D[0]], { '2026-10-05': 30 }, { '2026-10-05': 30 })).toBeNull();
  });

  it('several days over → the first (by date) plus "and N more days"; a missing date is 0', () => {
    expect(dayTotalRefusal([D[2], D[0], D[1]], {}, { '2026-10-05': 25, '2026-10-06': 26, '2026-10-07': 27 }))
      .toBe('Hours for Mon, Oct 5, 2026 would total 25 (and 2 more days). A day can\'t exceed 24 hours across all charge codes.');
    expect(dayTotalRefusal([D[0], D[1]], {}, { '2026-10-05': 25, '2026-10-06': 26 })).toMatch(/\(and 1 more day\)/);
    expect(dayTotalRefusal([D[0]], {}, {})).toBeNull();
  });

  it('string totals (postgres-js SUMs) compare as numbers, not text', () => {
    expect(dayTotalRefusal([D[0]], { '2026-10-05': '9' as never }, { '2026-10-05': '25' as never })).toMatch(/would total 25/);
    expect(dayTotalRefusal([D[0]], { '2026-10-05': '30' as never }, { '2026-10-05': '28' as never })).toBeNull();
  });
});
