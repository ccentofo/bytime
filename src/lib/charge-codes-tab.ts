/** The Charge codes page's tab (feature-plan-ux-people-codes.md R1): `direct` (default) or `indirect`; anything else → direct. */
export const CODES_TABS = ['direct', 'indirect'] as const;
export type CodesTab = (typeof CODES_TABS)[number];

export function parseCodesTab(raw: string | null | undefined): CodesTab {
  return raw === 'indirect' ? 'indirect' : 'direct';
}
