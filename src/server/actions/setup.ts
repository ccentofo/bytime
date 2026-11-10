'use server';

import { requireAdmin } from '@/lib/session';
import { getSetupPageDataInternal, getSetupStatusInternal, type SetupPageData, type SetupStatus } from '@/server/internal/setup';

/** The Setup checklist status (feature-plan-ux-setup-import.md §3.1): counts and booleans only. Read-only. */
export async function getSetupStatus(): Promise<SetupStatus> {
  await requireAdmin();
  return getSetupStatusInternal();
}

/**
 * The Setup page's data (§3.1): the status, who has no direct charge code (names ≤ 20, the page only — Home never reads
 * names, C17), the current settings and the scope count. Read-only.
 */
export async function getSetupPageData(): Promise<SetupPageData> {
  await requireAdmin();
  return getSetupPageDataInternal();
}
