/**
 * The user-management "Approver" select (feature-plan-certified-outputs.md C2, CO-D12): shown only for supervisor- and
 * admin-role users; options = active admins and supervisors other than the user, plus "None (admins approve)".
 * Pure — the server (setUserApprover) enforces the same rule.
 */
export interface ApproverCandidate {
  id: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  isActive: boolean;
}

export function approverSelectOptions(
  target: { id: string; role: string },
  users: ApproverCandidate[],
): Array<{ value: string; label: string }> | null {
  if (target.role !== 'supervisor' && target.role !== 'admin') return null; // hidden for employee-role users
  return [
    { value: '', label: 'None (admins approve)' },
    ...users
      .filter((u) => u.isActive && (u.role === 'admin' || u.role === 'supervisor') && u.id !== target.id)
      .map((u) => ({ value: u.id, label: `${u.fullName} (${u.role})` })),
  ];
}
