import 'server-only';
import type { ReadDb } from '@/db';
import { activeAdminIds, currentSelfApprovalOn, effectiveDesignee, type ApprovalFacts } from './approval-rules';

export interface ApprovalNotices { selfApprovalBackOn: { logId: string } | null; recommendDesignee: boolean }

/**
 * Admin notices (feature-plan-certified-outputs.md C2, CO-D19), extracted for Home (UX-2 §4.5): `selfApprovalBackOn` —
 * self-approval came back on for this admin; `recommendDesignee` — the only active admin, with no effective designee.
 * INTERNAL, no guard: the getApprovalNotices action guards; Home's page authorizes and passes its own facts.
 */
export async function approvalNotices(db: Pick<ReadDb, 'select'>, adminId: string, facts: ApprovalFacts): Promise<ApprovalNotices> {
  const on = await currentSelfApprovalOn(db, adminId, facts);
  const admins = activeAdminIds(facts);
  return {
    selfApprovalBackOn: on ? { logId: on.logId } : null,
    recommendDesignee: admins.length === 1 && admins[0] === adminId && effectiveDesignee(facts, adminId) === null,
  };
}
