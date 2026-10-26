import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import type { DbTx } from '@/db';
import { periodEvents, workspaceSettings } from '@/db/schema';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { UserFacingError } from '@/lib/errors';
import { IMPORT_WINDOW_CLOSED_MESSAGE } from '@/lib/migration/import-plan';

/**
 * The timesheet-history import window (feature-plan-certified-outputs.md C1, CO-D1). INTERNAL: callers are guarded.
 *
 * Open iff the founder's reopen is in force (`tenants.import_window_until > now`, read FRESH from the control plane —
 * never the 60 s registry cache), or the workspace is still onboarding: its `workspace_settings` row exists with
 * `history_import_closed_at` null AND no app-sourced `submitted` period event exists (covers old code that ran between
 * migration 0014 and the deploy). A missing settings row is closed. A failed control-plane read refuses the batch.
 *
 * Locking (§3 invariant): an import batch takes the window lock EXCLUSIVELY first; `submitPeriod` takes it SHARED as its
 * first statement. Both take it before any `lockEmployeeTimesheet`, so the two can never deadlock.
 */

const IMPORT_WINDOW_LOCK = 'workspace:import-window';

export async function lockImportWindowExclusive(tx: Pick<DbTx, 'execute'>): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${IMPORT_WINDOW_LOCK}))`);
}

export async function lockImportWindowShared(tx: Pick<DbTx, 'execute'>): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtext(${IMPORT_WINDOW_LOCK}))`);
}

export interface ImportWindowFacts {
  settingsRowExists: boolean;
  historyImportClosedAt: Date | null;
  hasAppSubmittedEvent: boolean;
  reopenUntil: Date | null;
}

/** Pure: the window rule above. */
export function isImportWindowOpen(facts: ImportWindowFacts, now: Date): boolean {
  if (facts.reopenUntil && facts.reopenUntil.getTime() > now.getTime()) return true;
  return facts.settingsRowExists && facts.historyImportClosedAt === null && !facts.hasAppSubmittedEvent;
}

/** The founder's reopen expiry, read fresh. Throws a UserFacingError when the control plane can't be read (fail closed). */
export async function readImportWindowReopen(tenantId: string): Promise<Date | null> {
  try {
    const [row] = await controlDb.select({ until: tenants.importWindowUntil }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return row?.until ?? null;
  } catch (err) {
    console.error('Import window: control-plane read failed:', err);
    throw new UserFacingError('Could not confirm whether timesheet history can be imported right now. Nothing was imported — please try again.');
  }
}

/** Read every fact of the window rule through the batch's transaction (after the exclusive lock). */
export async function readImportWindowFacts(tx: Pick<DbTx, 'select'>, tenantId: string): Promise<ImportWindowFacts> {
  const [settings] = await tx.select({ closedAt: workspaceSettings.historyImportClosedAt }).from(workspaceSettings).where(eq(workspaceSettings.id, 1)).limit(1);
  const [submitted] = await tx.select({ id: periodEvents.id }).from(periodEvents)
    .where(and(eq(periodEvents.event, 'submitted'), eq(periodEvents.source, 'app'))).limit(1);
  return {
    settingsRowExists: !!settings,
    historyImportClosedAt: settings?.closedAt ?? null,
    hasAppSubmittedEvent: !!submitted,
    reopenUntil: await readImportWindowReopen(tenantId),
  };
}

/** Throws the CO-D1 refusal unless the window is open. */
export async function assertImportWindowOpen(tx: Pick<DbTx, 'select'>, tenantId: string, now: Date): Promise<void> {
  if (!isImportWindowOpen(await readImportWindowFacts(tx, tenantId), now)) throw new UserFacingError(IMPORT_WINDOW_CLOSED_MESSAGE);
}

/** submitPeriod: close the window on the first submission (no row lock on later submits — the predicate is false). */
export async function closeImportWindowOnSubmit(tx: Pick<DbTx, 'update'>): Promise<void> {
  await tx.update(workspaceSettings)
    .set({ historyImportClosedAt: new Date() })
    .where(and(eq(workspaceSettings.id, 1), sql`${workspaceSettings.historyImportClosedAt} IS NULL`));
}
