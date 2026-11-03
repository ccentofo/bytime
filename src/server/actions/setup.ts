'use server';

import { requireAdmin } from '@/lib/session';
import { getSetupAccessGapsInternal, getSetupStatusInternal, type SetupAccessGaps, type SetupStatus } from '@/server/internal/setup';

/**
 * Get the current setup status by counting core entities.
 * Used by the Setup Wizard.
 */
export async function getSetupStatus(): Promise<SetupStatus> {
  await requireAdmin();
  return getSetupStatusInternal();
}

/** feature-plan-ux-page-fixes.md C17: who still has no direct charge code (Setup page only; Home never reads names). */
export async function getSetupAccessGaps(): Promise<SetupAccessGaps> {
  await requireAdmin();
  return getSetupAccessGapsInternal();
}
