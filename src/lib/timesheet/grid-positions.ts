/**
 * The grid's positions (feature-plan-ux-timesheet-ui.md §4.3). Pure. Rows are the body rows in order, then 'foot';
 * columns are 'rh', the visible day indexes (period day indexes), then 'total'. Group rows and the head aren't positions.
 * The grid keeps a REQUESTED position and derives the ACTIVE one during render with clampPos — exactly one tab stop.
 */

/** The row-header and total column ids (constants, so no JSX attribute carries a bare 'rh' / 'total' literal). */
export const RH = 'rh' as const;
export const TOTAL = 'total' as const;

export type Col = typeof RH | typeof TOTAL | number;
export type Row = number | 'foot';
export interface Pos { r: Row; c: Col }

export const columnsOf = (visibleDays: number[]): Col[] => ['rh', ...visibleDays, 'total'];
export const rowsOf = (bodyCount: number): Row[] => [...Array.from({ length: bodyCount }, (_, i) => i), 'foot'];

/** The nearest visible day to `day` (ties go to the earlier day); 'rh' when no day is visible. */
export function nearestDay(day: number, visibleDays: number[]): Col {
  if (visibleDays.length === 0) return 'rh';
  if (visibleDays.includes(day)) return day;
  return visibleDays.reduce((best, d) => (Math.abs(d - day) < Math.abs(best - day) ? d : best), visibleDays[0]);
}

/** Snap a requested position into the grid as rendered now (row into range, column to the nearest visible column). */
export function clampPos(p: Pos, bodyCount: number, visibleDays: number[]): Pos {
  let r: Row = p.r;
  if (r !== 'foot') r = bodyCount === 0 ? 'foot' : Math.min(Math.max(0, r), bodyCount - 1);
  const c: Col = typeof p.c === 'number' ? nearestDay(p.c, visibleDays) : p.c;
  return { r, c };
}

/** Today's column in the first body row if today is in the period, else the first visible day; no body rows → ('foot', 'rh'). */
export function initialPos(bodyCount: number, visibleDays: number[], todayIndex: number | null): Pos {
  if (bodyCount === 0) return { r: 'foot', c: 'rh' };
  const c: Col = todayIndex !== null && visibleDays.includes(todayIndex) ? todayIndex : (visibleDays[0] ?? 'rh');
  return { r: 0, c };
}

export const posKey = (p: Pos) => `${p.r}:${p.c}`;
export const samePos = (a: Pos, b: Pos) => a.r === b.r && a.c === b.c;
