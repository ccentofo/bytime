'use server';

import { getDb, getDbForWrite } from '@/db';
import { approvalScopes, userAssignments, users, clins, contracts } from '@/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { userAction, type ActionResult } from '@/lib/action-result';
import { UserFacingError } from '@/lib/errors';
import { validateUUID } from '@/lib/validation';
import { scopeChange } from '@/server/internal/approval-rules';
import {
  UNREVIEWED_MIGRATED_SCOPE, assertActiveClins, deactivateScopeRows, grantScopeRows, markScopeRowsKept,
} from '@/server/internal/approval-scopes';
import { notifyReroutedApprovals } from '@/server/internal/submission-notify';

const CHOOSE_SUPERVISOR = 'Choose an active supervisor.';

// ── Approval scope (feature-plan-approval-scope.md §4.2) ───────────────────────────────────────────────────────────

const MAX_GRANT = 200;
const MAX_REVIEW = 500;

/** 1–max deduped, lowercased UUIDs (an empty or oversized list is refused with the given wording). */
function idList(value: unknown, label: string, max: number, empty: string, tooMany: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new UserFacingError(empty);
  const ids = [...new Set(value.map((id) => validateUUID(id, label)))];
  if (ids.length > max) throw new UserFacingError(tooMany);
  return ids;
}

/**
 * Add CLINs to a supervisor's approval scope (replaces assignUserToClin). In ONE scopeChange: the person is an active
 * supervisor and every CLIN is active on an active contract (checked after the lock); each CLIN not already active is
 * granted (source 'app', granted and reviewed now, by the admin) and logged; waiting timesheets re-route.
 */
export async function grantApprovalScope(data: { supervisorId: string; clinIds: string[] }): Promise<ActionResult<{ granted: number }>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    if (!data?.supervisorId) throw new UserFacingError(CHOOSE_SUPERVISOR);
    const supervisorId = validateUUID(data.supervisorId, 'Supervisor');
    const clinIds = idList(data.clinIds, 'CLIN', MAX_GRANT, 'Choose at least one CLIN.', 'Choose 200 CLINs or fewer at a time.');
    const db = await getDbForWrite();
    const { result, rerouted } = await scopeChange(db, async (tx) => {
      const [person] = await tx.select({ role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, supervisorId));
      if (!person || !person.isActive || person.role !== 'supervisor') throw new UserFacingError(CHOOSE_SUPERVISOR);
      await assertActiveClins(tx, clinIds);
      return (await grantScopeRows(tx, { actorId: actor.id, supervisorId, clinIds, source: 'app' })).length;
    });
    await notifyReroutedApprovals(rerouted);
    return { granted: result };
  });
}

/**
 * Remove a CLIN from a supervisor's approval scope (replaces unassignUserFromClin): deactivated, reviewed if it wasn't,
 * logged, waiting timesheets re-routed. Already inactive (or never granted) → `{ changed: false }`, nothing logged.
 */
export async function revokeApprovalScope(data: { supervisorId: string; clinId: string }): Promise<ActionResult<{ changed: boolean }>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const supervisorId = validateUUID(data?.supervisorId, 'Supervisor');
    const clinId = validateUUID(data?.clinId, 'CLIN');
    const db = await getDbForWrite();
    const { result, rerouted } = await scopeChange(db, async (tx) => {
      const rows = await tx.select({ id: approvalScopes.id }).from(approvalScopes)
        .where(and(eq(approvalScopes.supervisorId, supervisorId), eq(approvalScopes.clinId, clinId), eq(approvalScopes.isActive, true)));
      return (await deactivateScopeRows(tx, { actorId: actor.id, rowIds: rows.map((r) => r.id) })).length > 0;
    });
    await notifyReroutedApprovals(rerouted);
    return { changed: result };
  });
}

/**
 * The one-time review of converted scopes (S6): Keep → reviewed, logged `kept`; Remove → deactivated and reviewed,
 * logged `removed`. One scopeChange; only rows still matching the S6 predicate are touched — others (already
 * reviewed, removed, or granted in the app) are skipped and counted.
 */
export async function reviewMigratedScopes(data: { keep: string[]; remove: string[] }): Promise<ActionResult<{ kept: number; removed: number; skipped: number }>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const keep = Array.isArray(data?.keep) ? [...new Set(data.keep.map((id) => validateUUID(id, 'Approval scope')))] : null;
    const remove = Array.isArray(data?.remove) ? [...new Set(data.remove.map((id) => validateUUID(id, 'Approval scope')))] : null;
    if (!keep || !remove) throw new UserFacingError('Choose Keep or Remove for each approval scope.');
    if (keep.length + remove.length === 0) throw new UserFacingError('There are no approval scopes to review.');
    if (keep.length + remove.length > MAX_REVIEW) throw new UserFacingError('Review 500 approval scopes or fewer at a time.');
    if (keep.some((id) => remove.includes(id))) throw new UserFacingError('An approval scope can’t be both kept and removed.');
    const db = await getDbForWrite();
    const { result, rerouted } = await scopeChange(db, async (tx) => {
      const pending = new Set((await tx.select({ id: approvalScopes.id }).from(approvalScopes)
        .where(and(inArray(approvalScopes.id, [...keep, ...remove]), UNREVIEWED_MIGRATED_SCOPE))).map((r) => r.id));
      const kept = await markScopeRowsKept(tx, { actorId: actor.id, rowIds: keep.filter((id) => pending.has(id)) });
      const removed = await deactivateScopeRows(tx, { actorId: actor.id, rowIds: remove.filter((id) => pending.has(id)) });
      return { kept: kept.length, removed: removed.length, skipped: keep.length + remove.length - kept.length - removed.length };
    });
    await notifyReroutedApprovals(rerouted);
    return result;
  });
}

const grantedBy = alias(users, 'scope_granted_by');

export interface ApprovalScopeRow {
  id: string;
  supervisorId: string;
  supervisorName: string;
  /** The holder's current role and state (a review row may belong to someone inactive or no longer a supervisor). */
  holderRole: 'admin' | 'supervisor' | 'employee';
  holderActive: boolean;
  clinId: string;
  clinNumber: string;
  clinDescription: string | null;
  contractName: string;
  contractNumber: string;
  /** The CLIN is active on an active contract. */
  clinActive: boolean;
  source: string;
  grantedAt: Date;
  grantedByName: string | null;
  /** S6: a converted scope nobody has kept or removed yet. */
  needsReview: boolean;
}

/**
 * The Approval scope tab's data in ONE load slot (two sequential queries): every ACTIVE scope row (any holder — the
 * review rows are the ones with `needsReview`, the S6 predicate) with names, and the active CLIN membership rows (People
 * counts and the uncovered CLINs). Replaces getAssignments on the Assignments page. Read-only.
 */
export async function getApprovalScopesView(): Promise<{ scopes: ApprovalScopeRow[]; membership: Array<{ userId: string; clinId: string }> }> {
  await requireAdmin();
  const db = await getDb();
  const scopes = await db
    .select({
      id: approvalScopes.id,
      supervisorId: approvalScopes.supervisorId,
      supervisorName: users.fullName,
      holderRole: users.role,
      holderActive: users.isActive,
      clinId: approvalScopes.clinId,
      clinNumber: clins.clinNumber,
      clinDescription: clins.description,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      clinActive: sql<boolean>`(${clins.status} = 'active' AND ${contracts.status} = 'active')`,
      source: approvalScopes.source,
      grantedAt: approvalScopes.grantedAt,
      grantedByName: grantedBy.fullName,
      needsReview: sql<boolean>`(${UNREVIEWED_MIGRATED_SCOPE})`,
    })
    .from(approvalScopes)
    .innerJoin(users, eq(users.id, approvalScopes.supervisorId))
    .innerJoin(clins, eq(clins.id, approvalScopes.clinId))
    .innerJoin(contracts, eq(contracts.id, clins.contractId))
    .leftJoin(grantedBy, eq(grantedBy.id, approvalScopes.grantedBy))
    .where(eq(approvalScopes.isActive, true))
    .orderBy(users.fullName, contracts.name, clins.clinNumber);
  const membership = await db.select({ userId: userAssignments.userId, clinId: userAssignments.clinId })
    .from(userAssignments).where(eq(userAssignments.isActive, true));
  return { scopes, membership };
}

/** Active CLINs on active contracts, by contract then CLIN — the approval-CLIN pickers (Assignments, Users). Read-only. */
export async function getApprovalClinOptions(): Promise<Array<{ clinId: string; clinNumber: string; clinDescription: string | null; contractId: string; contractName: string; contractNumber: string }>> {
  await requireAdmin();
  const db = await getDb();
  return db.select({ clinId: clins.id, clinNumber: clins.clinNumber, clinDescription: clins.description, contractId: contracts.id, contractName: contracts.name, contractNumber: contracts.contractNumber })
    .from(clins).innerJoin(contracts, eq(clins.contractId, contracts.id))
    .where(and(eq(clins.status, 'active'), eq(contracts.status, 'active')))
    .orderBy(contracts.name, clins.clinNumber);
}
