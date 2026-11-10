import 'server-only';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { adminChangeLog, approvalScopes, clins, contracts, userAssignments, users } from '@/db/schema';

/**
 * The deploy-window check (feature-plan-approval-scope.md S9, §12.1). REPORT-ONLY: it runs in a READ ONLY transaction,
 * so Postgres refuses any write. Between `db:migrate:all` and the new code going live, the OLD code may still change
 * CLIN rows; these lists show what the founder should look at on Assignments → Approval scope:
 * 1. a supervisor's active membership row with no approval_scopes row (the old code treated it as approval scope);
 * 2. `role_changed` to supervisor logged at or after `since` (the old code promoted without choosing CLINs);
 * 3. an active, unreviewed migrated scope whose membership row is no longer active (the old code unassigned it).
 */
export interface ApprovalScopeWindowFindings {
  membershipWithoutScope: Array<{ supervisorName: string; supervisorEmail: string; clinLabel: string; assignedAt: Date }>;
  promotedSince: Array<{ userName: string; userEmail: string; at: Date }>;
  unreviewedWithoutMembership: Array<{ supervisorName: string; supervisorEmail: string; clinLabel: string }>;
}

const clinLabel = sql<string>`${contracts.name} || ' CLIN ' || ${clins.clinNumber}`;

export async function approvalScopeWindowFindings(db: PostgresJsDatabase<Record<string, unknown>>, since: Date): Promise<ApprovalScopeWindowFindings> {
  return db.transaction(async (tx) => {
    const scope = alias(approvalScopes, 'window_scope');
    const membershipWithoutScope = await tx
      .select({ supervisorName: users.fullName, supervisorEmail: users.email, clinLabel, assignedAt: userAssignments.assignedAt })
      .from(userAssignments)
      .innerJoin(users, eq(users.id, userAssignments.userId))
      .innerJoin(clins, eq(clins.id, userAssignments.clinId))
      .innerJoin(contracts, eq(contracts.id, clins.contractId))
      .leftJoin(scope, and(eq(scope.supervisorId, userAssignments.userId), eq(scope.clinId, userAssignments.clinId)))
      .where(and(eq(users.role, 'supervisor'), eq(userAssignments.isActive, true), isNull(scope.id)))
      .orderBy(users.fullName, contracts.name, clins.clinNumber);

    const promotedSince = await tx
      .select({ userName: users.fullName, userEmail: users.email, at: adminChangeLog.createdAt })
      .from(adminChangeLog)
      .innerJoin(users, eq(users.id, adminChangeLog.entityId))
      .where(and(
        eq(adminChangeLog.entity, 'user'),
        eq(adminChangeLog.action, 'role_changed'),
        sql`${adminChangeLog.newValue}->>'role' = 'supervisor'`,
        gte(adminChangeLog.createdAt, since),
      ))
      .orderBy(adminChangeLog.createdAt);

    const unreviewedWithoutMembership = await tx
      .select({ supervisorName: users.fullName, supervisorEmail: users.email, clinLabel })
      .from(approvalScopes)
      .innerJoin(users, eq(users.id, approvalScopes.supervisorId))
      .innerJoin(clins, eq(clins.id, approvalScopes.clinId))
      .innerJoin(contracts, eq(contracts.id, clins.contractId))
      .where(and(
        eq(approvalScopes.source, 'migration'), eq(approvalScopes.isActive, true), isNull(approvalScopes.reviewedAt),
        sql`NOT EXISTS (SELECT 1 FROM user_assignments ua WHERE ua.user_id = ${approvalScopes.supervisorId} AND ua.clin_id = ${approvalScopes.clinId} AND ua.is_active)`,
      ))
      .orderBy(users.fullName, contracts.name, clins.clinNumber);

    return { membershipWithoutScope, promotedSince, unreviewedWithoutMembership };
  }, { accessMode: 'read only' });
}

/** The per-tenant report the script prints. Pure. */
export function formatWindowFindings(slug: string, f: ApprovalScopeWindowFindings): string[] {
  const total = f.membershipWithoutScope.length + f.promotedSince.length + f.unreviewedWithoutMembership.length;
  if (total === 0) return [`✓ ${slug}: nothing to check`];
  const lines = [`• ${slug}: ${total} item(s) to check on Assignments → Approval scope`];
  for (const r of f.membershipWithoutScope) {
    lines.push(`  - ${r.supervisorName} <${r.supervisorEmail}> is on ${r.clinLabel} (since ${r.assignedAt.toISOString()}) but has no approval scope row there`);
  }
  for (const r of f.promotedSince) lines.push(`  - ${r.userName} <${r.userEmail}> was made a supervisor at ${r.at.toISOString()}: choose their approval CLINs`);
  for (const r of f.unreviewedWithoutMembership) {
    lines.push(`  - ${r.supervisorName} <${r.supervisorEmail}> still has a converted (unreviewed) scope on ${r.clinLabel} but is no longer on it`);
  }
  return lines;
}
