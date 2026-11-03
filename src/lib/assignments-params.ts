/**
 * The Assignments page's URL (feature-plan-ux-kit-contracts.md §4.3), parsed the same way on the server (the initial
 * tab) and in the client (useSearchParams): `tab` allowlisted (default charge-codes); `laborCategoryId` and `userId`
 * UUIDs (anything else ignored); `assignments` a comma list of UUIDs (invalid ones dropped). Client-safe.
 */

export const ASSIGNMENT_TABS = ['charge-codes', 'approval-scope', 'labor-categories'] as const;
export type AssignmentsTab = (typeof ASSIGNMENT_TABS)[number];

export interface AssignmentsParams {
  tab: AssignmentsTab;
  laborCategoryId: string | null;
  userId: string | null;
  assignments: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null | undefined) => (v && UUID.test(v) ? v : null);

/** The first value of a Next searchParams entry (`?a=1&a=2` arrives as an array). */
export function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function parseAssignmentsParams(get: (key: string) => string | null | undefined): AssignmentsParams {
  const tab = get('tab');
  return {
    tab: (ASSIGNMENT_TABS as readonly string[]).includes(tab ?? '') ? (tab as AssignmentsTab) : 'charge-codes',
    laborCategoryId: uuidOrNull(get('laborCategoryId')),
    userId: uuidOrNull(get('userId')),
    assignments: (get('assignments') ?? '').split(',').map((s) => s.trim()).filter((s) => UUID.test(s)),
  };
}
