'use server';

import { requireAdmin } from '@/lib/session';
import { getSetupStatusInternal, type SetupStatus } from '@/server/internal/setup';

export type { SetupStatus };

/**
 * Get the current setup status by counting core entities.
 * Used by the Setup Wizard.
 */
export async function getSetupStatus(): Promise<SetupStatus> {
  await requireAdmin();
  return getSetupStatusInternal();
}
