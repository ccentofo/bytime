/**
 * The grid editor's input rules (feature-plan-ux-timesheet-ui.md §4.3) — a client mirror of the server's (Part A); the
 * server stays authoritative. Pure.
 */

const DRAFT = /^\d{0,2}(\.\d{0,2})?$/;

/** Normalize a typed value (NFKC: full-width digits; ',' → '.'); null when it isn't an acceptable draft (ignore the keystroke). */
export function normalizeDraft(raw: string): string | null {
  const v = raw.normalize('NFKC').replace(/,/g, '.');
  return DRAFT.test(v) ? v : null;
}

/** A keystroke that seeds edit mode, as the draft's first character ('7', '.', ',' → '.'), else null. */
export function seedChar(key: string): string | null {
  if (key.length === 0) return null;
  const ch = key.normalize('NFKC');
  if (/^[0-9]$/.test(ch)) return ch;
  if (ch === '.' || ch === ',') return '.';
  return null;
}

export const QUARTER_ERROR = 'Use quarter hours (.00, .25, .50 or .75).';
export const RANGE_ERROR = 'Hours must be between 0 and 24.';
export const dayTotalError = (n: number) => `This day would total ${Number(n.toFixed(2))} hours. A day can't exceed 24.`;

/**
 * Validate a draft for commit: empty or '.' is 0; quarter hours; 0–24; and the day's new total across rows is ≤ 24 or no
 * higher than its SAVED total (L1: an imported day already over 24 may be lowered).
 */
export function validateDraft(draft: string, ctx: { current: number; dayTotal: number; savedDayTotal: number }): { ok: true; value: number } | { ok: false; error: string } {
  const value = draft === '' || draft === '.' ? 0 : Number(draft);
  if (!Number.isFinite(value) || !Number.isInteger(value * 4)) return { ok: false, error: QUARTER_ERROR };
  if (value < 0 || value > 24) return { ok: false, error: RANGE_ERROR };
  const newTotal = Math.round((ctx.dayTotal - ctx.current + value) * 100) / 100;
  if (newTotal > 24 && newTotal > ctx.savedDayTotal) return { ok: false, error: dayTotalError(newTotal) };
  return { ok: true, value };
}

/** The draft an existing value starts from ('' for 0). */
export const draftOf = (v: number) => (v === 0 ? '' : v.toFixed(2));
