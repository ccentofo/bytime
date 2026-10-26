import { describe, it, expect, vi } from 'vitest';

/**
 * feature-plan-certified-outputs.md C2 — the pure approver rules (§5 "Approval" state table, §9 rows "Approver",
 * "Approver (base)", "Designee scope", "Self-approval switch", submission recipients and re-routing). The actions apply
 * these to a fresh snapshot (loadApprovalFacts); the integration suite proves the wiring against Postgres.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/db', () => ({ getDb: async () => ({}) }));

import {
  canApprove, effectiveDesignee, eligibleApprovers, newlyEligible, reviewScopeFrom, selfApprovalAvailable,
  type ApprovalFacts, type ApprovalUser, type EligibilitySnapshot,
} from '@/server/internal/approval-rules';

type Spec = Partial<ApprovalUser> & { id: string; clins?: string[] };
function facts(...specs: Spec[]): ApprovalFacts {
  const users = new Map<string, ApprovalUser>();
  const clinsByUser = new Map<string, Set<string>>();
  for (const s of specs) {
    users.set(s.id, { id: s.id, role: s.role ?? 'employee', isActive: s.isActive ?? true, approverId: s.approverId ?? null });
    if (s.clins?.length) clinsByUser.set(s.id, new Set(s.clins));
  }
  return { users, clinsByUser };
}

describe('effectiveDesignee', () => {
  it('honoured only for supervisor/admin users, and only while the designee is an active admin/supervisor', () => {
    const f = facts(
      { id: 'sup', role: 'supervisor', approverId: 'book' },
      { id: 'adm', role: 'admin', approverId: 'book' },
      { id: 'emp', role: 'employee', approverId: 'book' },     // employee-role: never honoured (CO-D12)
      { id: 'book', role: 'supervisor' },
      { id: 'sup2', role: 'supervisor', approverId: 'gone' },
      { id: 'gone', role: 'supervisor', isActive: false },      // deactivated designee
      { id: 'sup3', role: 'supervisor', approverId: 'demoted' },
      { id: 'demoted', role: 'employee' },                      // demoted designee
    );
    expect(effectiveDesignee(f, 'sup')).toBe('book');
    expect(effectiveDesignee(f, 'adm')).toBe('book');
    expect(effectiveDesignee(f, 'emp')).toBeNull();
    expect(effectiveDesignee(f, 'sup2')).toBeNull();
    expect(effectiveDesignee(f, 'sup3')).toBeNull();
  });
});

describe('canApprove — §5 approval table', () => {
  const f = facts(
    { id: 'admin1', role: 'admin' },
    { id: 'admin2', role: 'admin' },
    { id: 'supA', role: 'supervisor', clins: ['c1'] },
    { id: 'supB', role: 'supervisor', clins: ['c1'] },                    // CLIN-sharing peer of supA
    { id: 'designee', role: 'supervisor' },                                // no CLINs at all
    { id: 'supC', role: 'supervisor', clins: ['c9'], approverId: 'designee' },
    { id: 'emp', role: 'employee', clins: ['c1'] },
    { id: 'emp2', role: 'employee', clins: ['c2'] },
  );

  it('supervisor: approves a CLIN-sharing employee-role user; not one without a shared CLIN', () => {
    expect(canApprove(f, 'supA', 'emp')).toBe(true);
    expect(canApprove(f, 'supA', 'emp2')).toBe(false);
  });

  it('no peer approval (CO-D5): a supervisor never approves a CLIN-sharing supervisor', () => {
    expect(canApprove(f, 'supA', 'supB')).toBe(false);
    expect(canApprove(f, 'supB', 'supA')).toBe(false);
  });

  it('a designated supervisor approves their supervisee even without a shared CLIN; nobody else non-admin does', () => {
    expect(canApprove(f, 'designee', 'supC')).toBe(true);
    expect(canApprove(f, 'supA', 'supC')).toBe(false);
  });

  it('other admins always approve; a non-admin never approves themselves', () => {
    expect(canApprove(f, 'admin1', 'supB')).toBe(true);
    expect(canApprove(f, 'admin2', 'admin1')).toBe(true);
    expect(canApprove(f, 'supA', 'supA')).toBe(false);
    expect(canApprove(f, 'emp', 'emp')).toBe(false);
  });

  it('admin self: only the sole active admin without an effective designee (CO-D6/CO-D12)', () => {
    const sole = facts({ id: 'a', role: 'admin' }, { id: 'x', role: 'supervisor' });
    expect(canApprove(sole, 'a', 'a')).toBe(true);
    const twoAdmins = facts({ id: 'a', role: 'admin' }, { id: 'b', role: 'admin' });
    expect(canApprove(twoAdmins, 'a', 'a')).toBe(false);
    const secondInactive = facts({ id: 'a', role: 'admin' }, { id: 'b', role: 'admin', isActive: false });
    expect(canApprove(secondInactive, 'a', 'a')).toBe(true); // second admin deactivated → available again
    const withDesignee = facts({ id: 'a', role: 'admin', approverId: 'x' }, { id: 'x', role: 'supervisor' });
    expect(canApprove(withDesignee, 'a', 'a')).toBe(false);
    expect(canApprove(withDesignee, 'x', 'a')).toBe(true); // the designee approves the admin
    const designeeGone = facts({ id: 'a', role: 'admin', approverId: 'x' }, { id: 'x', role: 'supervisor', isActive: false });
    expect(canApprove(designeeGone, 'a', 'a')).toBe(true); // designee lost → self-approval available again
  });

  it('a designee demoted or deactivated can no longer approve (admins still can)', () => {
    const demoted = facts({ id: 'sup', role: 'supervisor', approverId: 'd' }, { id: 'd', role: 'employee' }, { id: 'adm', role: 'admin' });
    expect(canApprove(demoted, 'd', 'sup')).toBe(false);
    expect(canApprove(demoted, 'adm', 'sup')).toBe(true);
  });

  it('a supervisor demoted to employee: the former designee (no shared CLIN) can no longer approve them', () => {
    const f2 = facts({ id: 'was-sup', role: 'employee', approverId: 'd' }, { id: 'd', role: 'supervisor' });
    expect(canApprove(f2, 'd', 'was-sup')).toBe(false);
  });

  it('an admin who did not designate the supervisor can\'t be approved by them', () => {
    const f3 = facts({ id: 'adm', role: 'admin' }, { id: 'adm2', role: 'admin', approverId: 'sup' }, { id: 'sup', role: 'supervisor' });
    expect(canApprove(f3, 'sup', 'adm')).toBe(false);
    expect(canApprove(f3, 'sup', 'adm2')).toBe(true);
  });

  it('mutual designation (owner ↔ bookkeeper) works both ways; neither approves themselves', () => {
    const m = facts({ id: 'owner', role: 'admin', approverId: 'book' }, { id: 'book', role: 'supervisor', approverId: 'owner' });
    expect(canApprove(m, 'book', 'owner')).toBe(true);
    expect(canApprove(m, 'owner', 'book')).toBe(true);
    expect(canApprove(m, 'owner', 'owner')).toBe(false);
    expect(canApprove(m, 'book', 'book')).toBe(false);
  });
});

describe('reviewScope (CO-D18)', () => {
  it('a supervisor with NO CLINs designated by X sees exactly {self, X}', () => {
    const f = facts(
      { id: 'book', role: 'supervisor' },
      { id: 'X', role: 'admin', approverId: 'book' },
      { id: 'other', role: 'employee', clins: ['c1'] },
      { id: 'otherAdmin', role: 'admin' },
    );
    expect([...(reviewScopeFrom(f, 'book') as string[])].sort()).toEqual(['X', 'book'].sort());
  });

  it('CLIN sharers ∪ designators ∪ self; admins all; employees nothing', () => {
    const f = facts(
      { id: 'sup', role: 'supervisor', clins: ['c1'] },
      { id: 'emp', role: 'employee', clins: ['c1'] },
      { id: 'peer', role: 'supervisor', clins: ['c1'] }, // visible read-only (CO-D9), not approvable
      { id: 'far', role: 'supervisor', clins: ['c7'], approverId: 'sup' },
      { id: 'stranger', role: 'employee', clins: ['c3'] },
      { id: 'adm', role: 'admin' },
    );
    expect([...(reviewScopeFrom(f, 'sup') as string[])].sort()).toEqual(['emp', 'far', 'peer', 'sup']);
    expect(reviewScopeFrom(f, 'adm')).toBe('all');
    expect(reviewScopeFrom(f, 'emp')).toEqual([]);
  });

  it('an inactive actor sees nothing', () => {
    expect(reviewScopeFrom(facts({ id: 'sup', role: 'supervisor', isActive: false, clins: ['c1'] }), 'sup')).toEqual([]);
  });
});

describe('submission recipients and re-routing', () => {
  it('recipients = everyone canApprove: the designee and admins, never a peer supervisor or the submitter', () => {
    const f = facts(
      { id: 'sub', role: 'supervisor', clins: ['c1'], approverId: 'book' },
      { id: 'peer', role: 'supervisor', clins: ['c1'] },
      { id: 'book', role: 'supervisor' },
      { id: 'adm', role: 'admin' },
    );
    expect(eligibleApprovers(f, 'sub').sort()).toEqual(['adm', 'book']);
  });

  it('an admin\'s own submission never goes to themselves', () => {
    const f = facts({ id: 'adm', role: 'admin' });
    expect(eligibleApprovers(f, 'adm')).toEqual([]);
  });

  it('newlyEligible: only periods whose approver set GAINED someone, with only the new recipients', () => {
    const before: EligibilitySnapshot = new Map([
      ['p2', { userId: 'emp', approvers: new Set(['adm']), designee: null }],
    ]);
    const after: EligibilitySnapshot = new Map([
      ['p2', { userId: 'emp', approvers: new Set(['adm', 'adm2']), designee: null }],   // a new admin
      ['p3', { userId: 'emp3', approvers: new Set(['adm']), designee: null }],
    ]);
    expect(newlyEligible(before, after)).toEqual([
      { periodId: 'p2', userId: 'emp', recipients: ['adm2'], designeeLost: false },
      { periodId: 'p3', userId: 'emp3', recipients: ['adm'], designeeLost: false },
    ]);
  });

  it('ruling Q8: losing the effective designee re-notifies EVERY current approver (once each), flagged for the note', () => {
    const before: EligibilitySnapshot = new Map([
      ['p1', { userId: 'sup', approvers: new Set(['adm', 'book']), designee: 'book' }],
      ['p4', { userId: 'sup4', approvers: new Set(['adm', 'old']), designee: 'old' }],
      ['p5', { userId: 'sup5', approvers: new Set(['adm', 'same']), designee: 'same' }],
    ]);
    const after: EligibilitySnapshot = new Map([
      ['p1', { userId: 'sup', approvers: new Set(['adm']), designee: null }],                  // designee deactivated
      ['p4', { userId: 'sup4', approvers: new Set(['adm', 'new']), designee: 'new' }],        // designation changed
      ['p5', { userId: 'sup5', approvers: new Set(['adm', 'same']), designee: 'same' }],      // unchanged → nothing
    ]);
    expect(newlyEligible(before, after)).toEqual([
      { periodId: 'p1', userId: 'sup', recipients: ['adm'], designeeLost: true },
      { periodId: 'p4', userId: 'sup4', recipients: ['adm', 'new'], designeeLost: true },
    ]);
  });

  it('waiting timesheet of a supervisor whose designee is deactivated → admins become the approvers', () => {
    const before = facts({ id: 'sup', role: 'supervisor', approverId: 'd' }, { id: 'd', role: 'supervisor' }, { id: 'adm', role: 'admin' });
    const after = facts({ id: 'sup', role: 'supervisor', approverId: 'd' }, { id: 'd', role: 'supervisor', isActive: false }, { id: 'adm', role: 'admin' });
    expect(eligibleApprovers(before, 'sup').sort()).toEqual(['adm', 'd']);
    expect(eligibleApprovers(after, 'sup')).toEqual(['adm']);
  });
});

describe('selfApprovalAvailable (CO-D19)', () => {
  it('only an active admin who is the only active admin and has no effective designee', () => {
    expect(selfApprovalAvailable(facts({ id: 'a', role: 'admin' }), 'a')).toBe(true);
    expect(selfApprovalAvailable(facts({ id: 'a', role: 'admin', isActive: false }), 'a')).toBe(false);
    expect(selfApprovalAvailable(facts({ id: 'a', role: 'supervisor' }), 'a')).toBe(false);
    expect(selfApprovalAvailable(facts({ id: 'a', role: 'admin' }, { id: 'b', role: 'admin' }), 'a')).toBe(false);
  });
});

describe('user management Approver select (CO-D12)', () => {
  it('shown for supervisor and admin users (active admins + supervisors ≠ self, plus None); hidden for employees', async () => {
    const { approverSelectOptions } = await import('@/lib/approvals/approver-options');
    const people = [
      { id: 'a', fullName: 'Ann', role: 'admin' as const, isActive: true },
      { id: 's', fullName: 'Sam', role: 'supervisor' as const, isActive: true },
      { id: 'x', fullName: 'Xe', role: 'supervisor' as const, isActive: false },
      { id: 'e', fullName: 'Eve', role: 'employee' as const, isActive: true },
    ];
    expect(approverSelectOptions({ id: 'e', role: 'employee' }, people)).toBeNull();
    expect(approverSelectOptions({ id: 's', role: 'supervisor' }, people)).toEqual([
      { value: '', label: 'None (admins approve)' }, { value: 'a', label: 'Ann (admin)' },
    ]);
    expect(approverSelectOptions({ id: 'a', role: 'admin' }, people)?.map((o) => o.value)).toEqual(['', 's']);
  });

  it('the Users screen renders the select only through approverSelectOptions', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve(__dirname, '../../app/(app)/admin/users/UsersClient.tsx'), 'utf8');
    expect(src).toMatch(/approverSelectOptions\(\{ id: editingUser\.id, role: form\.role \}, users\)/);
    expect(src).toMatch(/return approverOptions && \(/);
  });
});

describe('ruling Q8 email', () => {
  it('the submitted-email template prints the note; re-routing passes it only for a lost designee', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const React = await import('react');
    const { TimesheetSubmittedEmail } = await import('@/lib/email/templates/timesheet-submitted');
    const props = { supervisorName: 'Ann', employeeName: 'Sam', employeeEmail: 's@x', periodLabel: 'Oct 1 – Oct 15, 2026', submittedAt: 'now', appUrl: 'https://acme.example' };
    expect(renderToStaticMarkup(React.createElement(TimesheetSubmittedEmail, { ...props, note: 'Its designated approver is no longer available.' })))
      .toContain('Its designated approver is no longer available.');
    expect(renderToStaticMarkup(React.createElement(TimesheetSubmittedEmail, props))).not.toContain('no longer available');
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const notify = readFileSync(resolve(__dirname, '../../server/internal/submission-notify.ts'), 'utf8');
    expect(notify).toMatch(/only: item\.recipients, \.\.\.\(item\.designeeLost \? \{ note: DESIGNEE_LOST_NOTE \} : \{\}\)/);
  });
});
