/**
 * The one status vocabulary (feature-plan-ux-kit-contracts.md §3.1, K2): each status's word and tone. "Returned" is the
 * word for the stored `rejected`, in the warning tone everywhere. Pure.
 */

export type StatusKey = 'draft' | 'notSubmitted' | 'submitted' | 'approved' | 'rejected' | 'active' | 'inactive' | 'closed';
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'dim';

export const STATUS: Record<StatusKey, { word: string; tone: Tone }> = {
  draft: { word: 'Draft', tone: 'dim' },
  notSubmitted: { word: 'Not submitted', tone: 'dim' },
  submitted: { word: 'Submitted', tone: 'info' },
  approved: { word: 'Approved', tone: 'ok' },
  rejected: { word: 'Returned', tone: 'warn' },
  active: { word: 'Active', tone: 'ok' },
  inactive: { word: 'Inactive', tone: 'dim' },
  closed: { word: 'Closed', tone: 'dim' },
};

const isKey = (s: string): s is StatusKey => Object.prototype.hasOwnProperty.call(STATUS, s);

/** A known status → its word; anything else in sentence case with `_` as a space ("on_hold" → "On hold"). */
export function statusWord(s: string): string {
  if (isKey(s)) return STATUS[s].word;
  const spaced = s.replace(/_/g, ' ').trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A known status → its tone; anything else is dim. */
export function statusTone(s: string): Tone {
  return isKey(s) ? STATUS[s].tone : 'dim';
}
