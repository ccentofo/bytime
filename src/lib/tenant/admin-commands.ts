import 'server-only';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { opsAlerts, tenantAuditEvents, tenantNotices } from '@/db/control-plane/schema';
import { withLockedPool, withTenantLock, type ControlTx } from '@/db/control-plane/locked';
import { addDays, cycleAnchor, deletionDateFrom, hasSubscribed, type LifecycleFacts } from './lifecycle';
import { DELETION_NOTICE_DAYS, POST_END_RETENTION_DAYS } from './lifecycle-config';
import { invalidateTenant, toLifecycleFacts } from './registry';
import { readTenant, recordAudit, updateTenantGuarded, type TenantRow } from './lifecycle-store';
import { enqueueNotice } from './notices';

/**
 * Founder commands behind `tenant:admin` (feature-plan-terms-compliance-fixes.md §5.6, F1, F2, F4). Each change is
 * planned from the row re-read under the tenant lock, applied with the lifecycle_version guard, and audited.
 */

export class AdminCommandError extends Error {}

type TenantPatch = Parameters<typeof updateTenantGuarded>[2];

export interface AdminPlan {
  describe: string;
  patch: TenantPatch;
  auditKind: string;
  auditDetail: string;
  /** Extra statements in the same locked transaction. */
  after?: (tx: ControlTx, now: Date) => Promise<void>;
}

export type Planner = (row: TenantRow, f: LifecycleFacts, now: Date) => AdminPlan;

const iso = (d: Date | null) => d?.toISOString() ?? '(none)';

function requireLifecycleStatus(row: TenantRow) {
  if (row.status !== 'active' && row.status !== 'suspended') throw new AdminCommandError(`Tenant is ${row.status}; refusing.`);
}

export const plans = {
  /** Refused once subscribed or while suspended; T = max(now, T) + N; a never-subscribed tenant's D is cleared. */
  extendTrial: (days: number): Planner => (row, f, now) => {
    if (!Number.isInteger(days) || days <= 0) throw new AdminCommandError('extend-trial requires a positive whole number of days.');
    requireLifecycleStatus(row);
    if (hasSubscribed(f)) throw new AdminCommandError('This workspace has subscribed; trial dates no longer apply.');
    if (row.status === 'suspended') throw new AdminCommandError('This workspace is suspended; refusing.');
    const base = row.trialEndsAt && row.trialEndsAt.getTime() > now.getTime() ? row.trialEndsAt : now;
    const trialEndsAt = addDays(base, days);
    return {
      describe: `extend the trial by ${days} day(s) to ${trialEndsAt.toISOString()}`,
      patch: { trialEndsAt, deletionScheduledFor: null },
      auditKind: 'trial-extended',
      auditDetail: `from=${iso(row.trialEndsAt)} to=${trialEndsAt.toISOString()}`,
    };
  },

  endTrial: (): Planner => (row, f, now) => {
    requireLifecycleStatus(row);
    if (hasSubscribed(f)) throw new AdminCommandError('This workspace has subscribed; trial dates no longer apply.');
    return {
      describe: 'end the trial now (read-only from now; the next cron run sends trial-ended)',
      patch: { trialEndsAt: now },
      auditKind: 'trial-ended-by-founder',
      auditDetail: `from=${iso(row.trialEndsAt)}`,
    };
  },

  /** Policy suspension (Terms §17.3). Replacing a non-payment suspension stops the D9 termination path. */
  suspend: (reason: string): Planner => (row, _f, now) => {
    if (!reason.trim()) throw new AdminCommandError('suspend requires --reason.');
    requireLifecycleStatus(row);
    if (row.suspensionReason === 'policy') throw new AdminCommandError('Already suspended for policy.');
    return {
      describe: `suspend for a POLICY breach: ${reason} (export blocked; admins are emailed)`,
      // F5: export is blocked by default for a policy hold.
      patch: { status: 'suspended', suspendedAt: now, suspensionReason: 'policy', policyExportAllowed: false },
      auditKind: 'policy-suspended',
      auditDetail: `${reason}${row.suspensionReason === 'nonpayment' ? ' (replaces a non-payment suspension)' : ''}`,
      // Terms §17.3 "notify you promptly": the admins' email, enqueued in the same transaction (anchor = suspended_at).
      after: async (tx, t) => { await enqueueNotice(tx, row.id, 'policy-suspended', t); },
    };
  },

  /** F5: allow or block export for ONE policy-suspended workspace, with a written reason (audited: who, when, why). */
  setPolicyExport: (allow: boolean, reason: string): Planner => (row) => {
    if (!reason.trim()) throw new AdminCommandError('set-policy-export requires --reason.');
    if (row.status !== 'suspended' || row.suspensionReason !== 'policy') {
      throw new AdminCommandError('Only a workspace suspended for a policy breach has export controls (non-payment suspensions can always export).');
    }
    return {
      describe: `${allow ? 'ALLOW' : 'BLOCK'} export for this policy-suspended workspace: ${reason}`,
      patch: { policyExportAllowed: allow },
      auditKind: allow ? 'policy-export-allowed' : 'policy-export-blocked',
      auditDetail: reason,
    };
  },

  unsuspend: (): Planner => (row) => {
    if (row.status !== 'suspended' || row.suspensionReason !== 'policy') {
      throw new AdminCommandError('Only a policy suspension can be lifted here (a non-payment suspension lifts when the customer pays).');
    }
    return {
      describe: 'lift the POLICY suspension',
      patch: { status: 'active', suspendedAt: null, suspensionReason: null, policyExportAllowed: false },
      auditKind: 'policy-unsuspended',
      auditDetail: '',
    };
  },

  /**
   * F1. on: clears D (closed precedes exempt) and supersedes every pending notice. off: re-applies the deletion
   * clock to an ended or trial-lapsed workspace (deletion-date rule: never in the past, room for notice).
   */
  setExempt: (on: boolean, reason: string): Planner => (row, f, now) => {
    if (!reason.trim()) throw new AdminCommandError('set-exempt requires --reason.');
    requireLifecycleStatus(row);
    if (on) {
      return {
        describe: 'set lifecycle_exempt ON (no expiry, no lifecycle emails, never scheduled for deletion)',
        patch: { lifecycleExempt: true, deletionScheduledFor: null },
        auditKind: 'exempt-on',
        auditDetail: reason,
        after: async (tx, t) => {
          await tx.update(tenantNotices).set({ supersededAt: t }).where(and(
            eq(tenantNotices.tenantId, row.id), isNull(tenantNotices.sentAt), isNull(tenantNotices.forcedAt), isNull(tenantNotices.supersededAt),
          ));
        },
      };
    }
    const lapsed = !hasSubscribed(f) && f.trialEndsAt !== null && now.getTime() >= f.trialEndsAt.getTime();
    const A = cycleAnchor(f);
    const D = (f.subscriptionEndedAt !== null || lapsed) && A !== null
      ? deletionDateFrom(addDays(A, POST_END_RETENTION_DAYS), now)
      : null;
    return {
      describe: `set lifecycle_exempt OFF${D ? ` (deletion date ${D.toISOString()})` : ''}`,
      patch: { lifecycleExempt: false, ...(D ? { deletionScheduledFor: D } : {}) },
      auditKind: 'exempt-off',
      auditDetail: `${reason}${D ? ` (deletion date ${D.toISOString()}, at least ${DELETION_NOTICE_DAYS} days out)` : ''}`,
    };
  },
};

/** Apply a plan under the tenant lock, re-planned from the re-read row (so a concurrent change is never lost). */
export async function applyAdminPlan(tenantId: string, planner: Planner, actor: string): Promise<TenantRow> {
  const updated = await withTenantLock(tenantId, async (tx) => {
    const row = await readTenant(tx, tenantId);
    if (!row) throw new AdminCommandError('Tenant disappeared.');
    const now = new Date();
    const p = planner(row, toLifecycleFacts(row), now);
    const after = await updateTenantGuarded(tx, row, p.patch, now);
    await recordAudit(tx, { tenantId: row.id, kind: p.auditKind, actor, detail: p.auditDetail });
    if (p.after) await p.after(tx, now);
    return after;
  });
  invalidateTenant(updated.slug);
  return updated;
}

/** The one pending notice `force-notice-sent` may mark. Refuses missing, superseded, ambiguous, sent or forced. */
export async function findForceableNotice(tenantId: string, kind: string, anchor?: Date) {
  const candidates = await withLockedPool((db) => db.select().from(tenantNotices)
    .where(and(eq(tenantNotices.tenantId, tenantId), eq(tenantNotices.kind, kind))).orderBy(desc(tenantNotices.createdAt)));
  const live = candidates.filter((n) => n.supersededAt === null && (!anchor || n.scheduledFor.getTime() === anchor.getTime()));
  if (live.length === 0) throw new AdminCommandError(`No non-superseded "${kind}" notice${anchor ? ` with anchor ${anchor.toISOString()}` : ''} exists; refusing.`);
  if (live.length > 1) throw new AdminCommandError(`Several "${kind}" notices exist; pass --anchor <iso> (anchors: ${live.map((n) => n.scheduledFor.toISOString()).join(', ')}).`);
  const notice = live[0];
  if (notice.sentAt) throw new AdminCommandError('That notice was actually delivered; nothing to force.');
  if (notice.forcedAt) throw new AdminCommandError('That notice is already forced.');
  return notice;
}

/** forced_at (never sent_at) + reason + audit id; unblocks transitions waiting on the notice. */
export async function forceNoticeSent(tenantId: string, noticeId: string, reason: string, actor: string): Promise<void> {
  if (!reason.trim()) throw new AdminCommandError('force-notice-sent requires --reason.');
  await withTenantLock(tenantId, async (tx) => {
    const row = await readTenant(tx, tenantId);
    if (!row) throw new AdminCommandError('Tenant disappeared.');
    const [current] = await tx.select().from(tenantNotices).where(eq(tenantNotices.id, noticeId));
    if (!current || current.tenantId !== tenantId || current.supersededAt || current.sentAt || current.forcedAt) {
      throw new AdminCommandError('The notice changed meanwhile; re-run.');
    }
    const now = new Date();
    const auditId = await recordAudit(tx, { tenantId, kind: 'force-notice-sent', actor, detail: `${current.kind} anchor=${current.scheduledFor.toISOString()}: ${reason}` });
    await tx.update(tenantNotices).set({ forcedAt: now, forcedReason: reason, forcedAuditId: auditId }).where(eq(tenantNotices.id, noticeId));
    await updateTenantGuarded(tx, row, {}, now); // version bump: any concurrent evaluation re-reads
  });
}

/** F2: record that a founder export was destroyed, or is kept under a legal hold. */
export async function recordFounderExportDisposal(tenantId: string, legalHold: string | undefined, actor: string): Promise<string> {
  const [taken] = await withLockedPool((db) => db.select().from(tenantAuditEvents)
    .where(and(eq(tenantAuditEvents.tenantId, tenantId), eq(tenantAuditEvents.kind, 'founder-export-taken')))
    .orderBy(desc(tenantAuditEvents.createdAt)).limit(1));
  if (!taken) throw new AdminCommandError('No founder export was recorded for this workspace.');
  await withLockedPool((db) => recordAudit(db, {
    tenantId,
    kind: legalHold ? 'founder-export-legal-hold' : 'founder-export-destroyed',
    actor,
    detail: legalHold ?? `export of ${taken.createdAt.toISOString()} destroyed`,
  }));
  return taken.detail ?? '';
}

/**
 * A free-text founder note on the workspace's audit trail (feature-plan-launch-blockers.md P6 §2, LB-D6): e.g. the
 * written record of what an in-place restore erased and why, referencing the customer's consent. Append-only;
 * changes no lifecycle state.
 */
export async function recordFounderNote(tenantId: string, note: string, actor: string): Promise<string> {
  if (!note.trim()) throw new AdminCommandError('audit-note requires --note "<text>".');
  return withLockedPool((db) => recordAudit(db, { tenantId, kind: 'founder-note', actor, detail: note.trim() }));
}

/** Manual resolution (bookkeeping only — never changes lifecycle state). */
export async function resolveAlertById(alertId: string, note: string, actor: string): Promise<void> {
  if (!note.trim()) throw new AdminCommandError('resolve-alert requires --note.');
  const [alert] = await withLockedPool((db) => db.select().from(opsAlerts).where(eq(opsAlerts.id, alertId)).limit(1));
  if (!alert) throw new AdminCommandError(`No alert ${alertId}.`);
  if (alert.resolvedAt) throw new AdminCommandError('Already resolved.');
  await withLockedPool((db) => db.update(opsAlerts).set({ resolvedAt: new Date(), resolutionNote: `${note} (${actor})` }).where(eq(opsAlerts.id, alertId)));
}
