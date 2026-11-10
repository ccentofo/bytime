'use client';

import { useMemo, useRef, useState } from 'react';
import {
  Alert, Anchor, Button, Drawer, Group, List, Modal, MultiSelect, PasswordInput, Radio, Select, Stack, Text, TextInput,
} from '@mantine/core';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { runAction } from '@/lib/run-action';
import { toastError, toastSuccess } from '@/lib/toast';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { RowActions, type RowAction } from '@/components/ui/RowActions';
import { useBusyRows, useLastTarget } from '@/components/ui/useRowState';
import { useBusy } from '@/components/ui/useBusy';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAppTable } from '@/components/table/mrtDefaults';
import { createUserWithPassword, updateUser, getUsersForAdminPage, unlockUserAccount, setUserApprover } from '@/server/actions/users';
import { adminResetPassword } from '@/server/actions/password';
import { adminResetMfa } from '@/server/actions/mfa';
import { PageHeader } from '@/components/ui/PageHeader';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { approverSelectOptions } from '@/lib/approvals/approver-options';
import { PASSWORD_RULES, validatePassword } from '@/lib/password-rules';
import { formatCount } from '@/lib/format';
import classes from './Users.module.css';

type User = {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  isActive: boolean;
  flsaExempt: boolean;
  approverId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** feature-plan-ux-people-codes.md §5.1 (getUsersForAdminPage). */
  mfaEnabled?: boolean;
  lock?: { minutesRemaining: number } | null;
  approverName?: string | null;
};

/** An active CLIN on an active contract — the "CLINs they approve" picker (feature-plan-approval-scope.md §5). */
export type ApprovalClinOption = { clinId: string; clinNumber: string; clinDescription: string | null; contractId: string; contractName: string };

type Props = {
  initialUsers: User[];
  currentUserId: string;
  /** feature-plan-approval-scope.md §5: the CLINs a new supervisor can be given to approve. */
  approvalClins?: ApprovalClinOption[];
  /** getSeatUsage: active users and the plan's limit (null = unlimited). */
  seats?: { active: number; limit: number | null };
};

const ROLE_OPTIONS = [
  { value: 'employee', label: 'Employee — records time' },
  { value: 'supervisor', label: 'Supervisor — records time and approves their CLINs' },
  { value: 'admin', label: 'Admin — manages everything' },
];
const ROLE_WORD: Record<User['role'], string> = { admin: 'Admin', supervisor: 'Supervisor', employee: 'Employee' };

type UserForm = {
  email: string;
  fullName: string;
  role: string;
  password: string;
  /** '' until chosen on Add (required, no default); 'exempt' / 'nonexempt'. */
  overtime: '' | 'exempt' | 'nonexempt';
  /** certified-outputs C2: designated approver ('' = none — admins approve). Supervisor/admin users only. */
  approverId: string;
  /** feature-plan-approval-scope.md §5: a NEW supervisor's approval CLINs (Add, or a real change to supervisor). */
  approvalClinIds: string[];
};
type FieldKey = 'fullName' | 'email' | 'overtime' | 'password';

type Role = User['role'];
type StatusFilter = 'active' | 'inactive' | 'locked' | 'all';

const SIGNED_OUT = " They'll be signed out within a minute and must sign in again.";
const SCOPE_REMOVED = "Their approval scope is removed. Charge code access doesn't change.";

/**
 * feature-plan-ux-page-fixes.md C16: the confirm for a role change, matching the approval rules
 * (internal/approval-rules.ts) — a supervisor approves employees on the CLINs of their approval scope, and supervisors or
 * admins who name them as approver; a second admin ends sole-admin self-approval; a role change bumps sessionVersion.
 * feature-plan-approval-scope.md §5: a promotion summarizes the CLINs chosen in the Drawer (`approve`: their labels); a
 * demotion from supervisor says the approval scope goes and charge code access stays.
 */
export function roleChangeCopy(name: string, from: Role, to: Role, actingIsSoleAdmin: boolean, approve: string[] = []) {
  const approveLine = approve.length > 0 ? ` They'll approve: ${approve.join(', ')}.` : " They won't approve any CLINs yet.";
  const scopeRemoved = from === 'supervisor' && to !== 'supervisor' ? ` ${SCOPE_REMOVED}` : '';
  if (to === 'admin') {
    return {
      tone: 'danger' as const,
      title: `Make ${name} an admin?`,
      message: 'Admins have full access: every timesheet and cost figure, users, contracts, billing and workspace settings.'
        + (actingIsSoleAdmin ? " You'll no longer be able to approve your own timesheets, because another admin can." : '') + scopeRemoved + SIGNED_OUT,
      confirmLabel: 'Make admin',
    };
  }
  if (to === 'supervisor' && from === 'admin') {
    return {
      tone: 'neutral' as const,
      title: `Change ${name} from admin to supervisor?`,
      message: 'They lose access to users, contracts, costs and settings.' + approveLine + SIGNED_OUT,
      confirmLabel: 'Change role',
    };
  }
  if (to === 'supervisor') {
    return {
      tone: 'neutral' as const,
      title: `Make ${name} a supervisor?`,
      message: 'They can review and approve timesheets for employees on the CLINs they approve, and for supervisors or admins who have them set as their approver. Charge code access doesn\'t change.'
        + approveLine + SIGNED_OUT,
      confirmLabel: 'Make supervisor',
    };
  }
  return {
    tone: 'neutral' as const,
    title: `Change ${name} to employee?`,
    message: 'They can no longer review or approve timesheets. Admins, and any supervisor who approves those employees\' CLINs, can still approve them.' + scopeRemoved + SIGNED_OUT,
    confirmLabel: 'Change role',
  };
}

const FLSA_MESSAGE = 'Payroll export uses this to calculate overtime for every period, including past ones.';

/** The FLSA status confirm (the ⋯ menu's and the Edit save's). */
export function flsaChangeCopy(name: string, toExempt: boolean) {
  return {
    tone: 'neutral' as const,
    title: `Mark ${name} as FLSA ${toExempt ? 'exempt' : 'non-exempt'}?`,
    message: FLSA_MESSAGE,
    confirmLabel: toExempt ? 'Mark as exempt' : 'Mark as non-exempt',
  };
}

/**
 * UX-4C1-AUDIT.md M1: what an Edit save asks first — the role confirm, the FLSA confirm, or (both changed) ONE confirm
 * carrying both messages. Null when neither changed (the save runs directly).
 */
export function editConfirmCopy(name: string, role: { from: Role; to: Role } | null, toExempt: boolean | null, actingIsSoleAdmin: boolean, approve: string[] = []) {
  const r = role && roleChangeCopy(name, role.from, role.to, actingIsSoleAdmin, approve);
  if (r && toExempt !== null) {
    return { ...r, message: `${r.message} Their overtime status changes to ${toExempt ? 'exempt' : 'non-exempt'}: ${FLSA_MESSAGE.charAt(0).toLowerCase()}${FLSA_MESSAGE.slice(1)}`, confirmLabel: 'Save changes' };
  }
  if (r) return r;
  return toExempt === null ? null : flsaChangeCopy(name, toExempt);
}

const PARTIAL_SAVE = "The role was saved, but the approver couldn't be updated. Try saving again.";

const EMPTY_FORM: UserForm = { email: '', fullName: '', role: 'employee', password: '', overtime: '', approverId: '', approvalClinIds: [] };

/** What applies to a user's ⋯ menu (§5.2): Unlock only when locked; two-step reset only when on and not yourself. */
export function userMenuKeys(u: Pick<User, 'id' | 'isActive' | 'mfaEnabled' | 'lock'>, currentUserId: string): string[] {
  return [
    ...(u.lock ? ['unlock'] : []),
    'reset-password',
    ...(u.mfaEnabled && u.id !== currentUserId ? ['reset-mfa'] : []),
    'flsa',
    u.isActive ? 'deactivate' : 'reactivate',
  ];
}

export function UsersClient({ initialUsers, currentUserId, seats, approvalClins = [] }: Props) {
  const [users, setUsers] = useState<User[]>(initialUsers);
  const busy = useBusy();
  // Row actions that run without a confirm (Unlock, Reactivate) show a loader on THEIR row only.
  const busyRows = useBusyRows();
  const [roleFilter, setRoleFilter] = useState<'all' | Role>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  // Confirmations (feature-plan-ux-foundations.md §4.5, B2): deactivation and FLSA status ask first.
  const [confirmDeactivate, setConfirmDeactivate] = useState<User | null>(null);
  const [confirmFlsa, setConfirmFlsa] = useState<User | null>(null);
  // The modals keep showing the last target while they animate closed (no "Deactivate ?" flash).
  const shownDeactivate = useLastTarget(confirmDeactivate);
  const shownFlsa = useLastTarget(confirmFlsa);

  // Drawer state (Add / Edit)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [form, setForm] = useState<UserForm>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const fieldRefs = useRef<Partial<Record<FieldKey, HTMLElement | null>>>({});
  // C16 / M1: a role or overtime change asks first; the confirm shows the save's error (the form's own Alert is hidden meanwhile).
  const [editConfirm, setEditConfirm] = useState<{ name: string; role: { from: Role; to: Role } | null; toExempt: boolean | null; approve: string[] } | null>(null);
  const shownEdit = useLastTarget(editConfirm);
  const activeAdmins = users.filter((u) => u.role === 'admin' && u.isActive);
  const actingIsSoleAdmin = activeAdmins.length === 1 && activeAdmins[0].id === currentUserId;
  const editCopy = shownEdit && editConfirmCopy(shownEdit.name, shownEdit.role, shownEdit.toExempt, actingIsSoleAdmin, shownEdit.approve);
  const flsaCopy = shownFlsa && flsaChangeCopy(shownFlsa.fullName, !shownFlsa.flsaExempt);

  // Reset password
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const shownReset = useLastTarget(resetTarget);
  const [resetPassword, setResetPassword] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);
  // Reset two-step sign-in (R6)
  const [mfaTarget, setMfaTarget] = useState<User | null>(null);
  const shownMfa = useLastTarget(mfaTarget);
  const [mfaPassword, setMfaPassword] = useState('');
  const [mfaError, setMfaError] = useState<string | null>(null);

  async function refresh() {
    try {
      setUsers((await getUsersForAdminPage()) as User[]);
    } catch {
      toastError({ title: 'List not refreshed', message: 'Saved, but the list couldn’t refresh. Reload the page.' });
    }
  }

  const freeSeats = seats && seats.limit !== null ? Math.max(0, seats.limit - seats.active) : null;

  function openCreate() {
    setEditingUser(null);
    setForm(EMPTY_FORM);
    setFieldErrors({});
    setFormError(null);
    setDrawerOpen(true);
  }

  function openEdit(user: User) {
    setEditingUser(user);
    setForm({
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      password: '', // never pre-filled; not on Edit
      overtime: user.flsaExempt ? 'exempt' : 'nonexempt',
      approverId: user.approverId ?? '',
      approvalClinIds: [],
    });
    setFieldErrors({});
    setFormError(null);
    setDrawerOpen(true);
  }

  /** §5.2: validate on click; the Alert lists every problem with a link to its field. */
  function validate(): Partial<Record<FieldKey, string>> {
    const e: Partial<Record<FieldKey, string>> = {};
    if (!form.fullName.trim()) e.fullName = 'Enter a full name.';
    if (!form.email.trim()) e.email = 'Enter an email.';
    if (!form.overtime) e.overtime = 'Choose an overtime status.';
    if (!editingUser) {
      const pw = validatePassword(form.password);
      if (pw) e.password = pw;
    }
    return e;
  }

  /** §5: the picker shows (and its ids are sent) only on Add, or for a REAL change to supervisor. */
  const pickingApprovalClins = form.role === 'supervisor' && (!editingUser || editingUser.role !== 'supervisor');
  const clinName = (id: string) => {
    const c = approvalClins.find((x) => x.clinId === id);
    return c ? `${c.contractName} CLIN ${c.clinNumber}` : 'a CLIN';
  };
  const approvalClinGroups = [...new Map(approvalClins.map((c) => [c.contractId, c.contractName])).entries()].map(([contractId, contractName]) => ({
    group: contractName,
    items: approvalClins.filter((c) => c.contractId === contractId).map((c) => ({ value: c.clinId, label: `${c.contractName} CLIN ${c.clinNumber}${c.clinDescription ? ` — ${c.clinDescription}` : ''}` })),
  }));

  async function handleSubmit({ confirmed = false }: { confirmed?: boolean } = {}) {
    const errors = validate();
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;
    if (editingUser && !confirmed) {
      const role = form.role !== editingUser.role ? { from: editingUser.role, to: form.role as Role } : null;
      const toExempt = (form.overtime === 'exempt') !== editingUser.flsaExempt ? form.overtime === 'exempt' : null;
      const approve = pickingApprovalClins ? form.approvalClinIds.map(clinName) : [];
      if (role || toExempt !== null) { setEditConfirm({ name: editingUser.fullName, role, toExempt, approve }); return; }
    }
    await busy.run('save', async () => {
      const flsaExempt = form.overtime === 'exempt';
      if (editingUser) {
        const updateData: { fullName?: string; email?: string; role?: Role; flsaExempt?: boolean; approvalClinIds?: string[] } = {};
        if (form.fullName !== editingUser.fullName) updateData.fullName = form.fullName;
        if (form.email !== editingUser.email) updateData.email = form.email;
        if (form.role !== editingUser.role) updateData.role = form.role as Role;
        if (flsaExempt !== editingUser.flsaExempt) updateData.flsaExempt = flsaExempt;
        if (pickingApprovalClins) updateData.approvalClinIds = form.approvalClinIds; // the role and the grants save (or fail) together

        const saving = Object.keys(updateData).length > 0;
        if (saving) {
          const result = await runAction(updateUser(editingUser.id, updateData), { silent: true });
          if (!result.ok) { setFormError(result.error); return; }
        }
        // C2 (CO-D12): the approver is designated separately, and only for supervisor/admin users.
        if ((form.role === 'supervisor' || form.role === 'admin') && form.approverId !== (editingUser.approverId ?? '')) {
          const result = await runAction(setUserApprover(editingUser.id, form.approverId || null), { silent: true });
          if (!result.ok) {
            if (saving) {
              // C16 partial save: the first update landed. Refresh the list and editingUser before any retry, so a retry
              // sends only the approver and doesn't ask to confirm a role that's already saved.
              setEditingUser({ ...editingUser, ...updateData });
              try {
                const refreshed = (await getUsersForAdminPage()) as User[];
                setUsers(refreshed);
                const fresh = refreshed.find((u) => u.id === editingUser.id);
                if (fresh) setEditingUser(fresh);
              } catch {
                // keep the local copy above
              }
            }
            setFormError(saving && updateData.role ? PARTIAL_SAVE : result.error);
            return;
          }
        }
        toastSuccess({ title: 'User updated', message: `${form.fullName} has been updated.` });
      } else {
        const result = await runAction(createUserWithPassword({
          email: form.email,
          fullName: form.fullName,
          role: form.role as Role,
          password: form.password,
          flsaExempt,
          approverId: (form.role === 'supervisor' || form.role === 'admin') && form.approverId ? form.approverId : null,
          ...(pickingApprovalClins ? { approvalClinIds: form.approvalClinIds } : {}),
        }), { silent: true });
        if (!result.ok) { setFormError(result.error); return; } // e.g. the plan's seat limit or a duplicate email, verbatim
        toastSuccess({ title: 'User added', message: `${form.fullName} can sign in with the temporary password.` });
      }
      await refresh();
      setEditConfirm(null);
      setDrawerOpen(false);
    });
  }

  async function handleUnlock(user: User) {
    busyRows.start(user.id);
    const result = await runAction(unlockUserAccount(user.email), { errorTitle: 'Couldn’t unlock account' });
    busyRows.done(user.id);
    if (!result.ok) return;
    toastSuccess({ title: 'Unlocked', message: `${user.fullName} can sign in again` });
    await refresh();
  }

  async function handleResetPassword() {
    if (!resetTarget) return;
    // §5.2: never disabled — validated on click with the shared rules.
    const problem = validatePassword(resetPassword);
    if (problem) { setResetError(problem); return; }
    await busy.run('reset-password', async () => {
      setResetError(null);
      const result = await runAction(adminResetPassword({ targetUserId: resetTarget.id, newPassword: resetPassword }), { silent: true });
      if (!result.ok) { setResetError(result.error); return; }
      setResetTarget(null);
      toastSuccess({ title: 'Password reset', message: `${resetTarget.fullName} can sign in with the new password.` });
    });
  }

  async function handleResetMfa() {
    if (!mfaTarget) return;
    if (!mfaPassword) { setMfaError('Enter your password.'); return; }
    await busy.run('reset-mfa', async () => {
      setMfaError(null);
      const result = await runAction(adminResetMfa({ userId: mfaTarget.id, currentPassword: mfaPassword }), { silent: true });
      if (!result.ok) { setMfaError(result.error); return; }
      setMfaTarget(null);
      if (result.data.changed) toastSuccess({ title: 'Two-step sign-in reset', message: `${mfaTarget.fullName} is signed out within a minute.` });
      else toastSuccess({ title: 'Nothing to reset', message: 'Two-step sign-in was already off' });
      await refresh();
    });
  }

  /** Same server call as before; the confirm closes only on success (onDone). */
  async function handleToggleFlsaExempt(user: User, onDone?: () => void) {
    await busy.run('flsa', async () => {
      const newExempt = !user.flsaExempt;
      const result = await runAction(updateUser(user.id, { flsaExempt: newExempt }), { errorTitle: 'Action Failed' });
      if (!result.ok) return;
      onDone?.();
      await refresh();
      toastSuccess({ title: newExempt ? 'Marked exempt' : 'Marked non-exempt', message: `${user.fullName} is now FLSA ${newExempt ? 'exempt' : 'non-exempt'}.` });
    });
  }

  /** Same server call as before; deactivation runs from the confirm (closed only on success), reactivation directly. */
  async function handleToggleActive(user: User, onDone?: () => void) {
    if (!onDone) busyRows.start(user.id);
    await busy.run(`active:${user.id}`, async () => {
      const newActive = !user.isActive;
      const result = await runAction(updateUser(user.id, { isActive: newActive }), { errorTitle: 'Action Failed' });
      busyRows.done(user.id);
      if (!result.ok) return;
      onDone?.();
      await refresh();
      toastSuccess({ title: newActive ? 'User reactivated' : 'User deactivated', message: `${user.fullName} has been ${newActive ? 'reactivated' : 'deactivated'}.` });
    });
  }

  const rows = useMemo(() => users.filter((u) => {
    if (roleFilter !== 'all' && u.role !== roleFilter) return false;
    if (statusFilter === 'active') return u.isActive;
    if (statusFilter === 'inactive') return !u.isActive;
    if (statusFilter === 'locked') return u.isActive && !!u.lock;
    return true;
  }), [users, roleFilter, statusFilter]);

  const columns = useMemo<MRT_ColumnDef<User>[]>(() => [
    {
      // Search covers the name and email (the accessor), §5.2.
      id: 'name', header: 'Name', accessorFn: (u) => `${u.fullName} ${u.email}`, enableSorting: false,
      Cell: ({ row: { original: u } }) => (
        <>
          <Text fw={600} size="sm">{u.fullName}</Text>
          <Text size="xs" c="dimmed">{u.email}{u.id === currentUserId ? ' · you' : ''}</Text>
        </>
      ),
    },
    { id: 'role', header: 'Role', accessorFn: (u) => ROLE_WORD[u.role], enableSorting: false, enableGlobalFilter: false },
    {
      id: 'approver', header: 'Approver', enableSorting: false, enableGlobalFilter: false,
      Cell: ({ row: { original: u } }) => (u.role === 'employee'
        ? <span className={classes.dim}>CLIN supervisors</span>
        : u.approverName ? u.approverName : <span className={classes.dim}>None — admins approve</span>),
    },
    { id: 'overtime', header: 'Overtime', accessorFn: (u) => (u.flsaExempt ? 'Exempt' : 'Non-exempt'), enableSorting: false, enableGlobalFilter: false },
    {
      id: 'mfa', header: 'Two-step sign-in', enableSorting: false, enableGlobalFilter: false,
      Cell: ({ row: { original: u } }) => <StatusBadge word={u.mfaEnabled ? 'On' : 'Off'} tone={u.mfaEnabled ? 'ok' : 'dim'} />,
    },
    {
      id: 'status', header: 'Status', enableSorting: false, enableGlobalFilter: false,
      Cell: ({ row: { original: u } }) => (u.isActive && u.lock
        ? <span data-testid="user-locked"><StatusBadge word={`Locked · ${formatCount(u.lock.minutesRemaining)} min`} tone="warn" /></span>
        : <StatusBadge status={u.isActive ? 'active' : 'inactive'} />),
    },
  ], [currentUserId]);

  const table = useAppTable({
    columns,
    data: rows,
    hairline: true,
    compact: rows.length <= 25,
    enableRowActions: true,
    renderRowActions: ({ row }) => {
      const user = row.original;
      const all: Record<string, RowAction> = {
        // Credential actions stay available in read-only mode, matching the server (users.ts unlock, password.ts, mfa.ts).
        unlock: { key: 'unlock', label: 'Unlock now', icon: 'unlock', writes: false, busy: busyRows.isBusy(user.id), onSelect: () => { void handleUnlock(user); } },
        'reset-password': { key: 'reset-password', label: 'Reset password…', icon: 'resetPassword', writes: false, onSelect: () => { setResetTarget(user); setResetPassword(''); setResetError(null); } },
        'reset-mfa': { key: 'reset-mfa', label: 'Reset two-step sign-in…', icon: 'lock', writes: false, onSelect: () => { setMfaTarget(user); setMfaPassword(''); setMfaError(null); } },
        flsa: { key: 'flsa', label: user.flsaExempt ? 'Mark as non-exempt…' : 'Mark as exempt…', icon: 'flsa', onSelect: () => setConfirmFlsa(user) },
        deactivate: {
          key: 'deactivate', label: 'Deactivate…', icon: 'deactivate', tone: 'danger', onSelect: () => setConfirmDeactivate(user),
          disabledReason: user.id === currentUserId ? "You can't deactivate your own account" : undefined,
        },
        reactivate: { key: 'reactivate', label: 'Reactivate', icon: 'reactivate', busy: busyRows.isBusy(user.id), onSelect: () => { void handleToggleActive(user); } },
      };
      return (
        <RowActions
          rowLabel={user.fullName}
          primary={{ key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => openEdit(user) }}
          items={userMenuKeys(user, currentUserId).map((k) => all[k])}
        />
      );
    },
    emptyState: { title: 'No users match.' },
  });

  // ── Drawer ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const errorList = (Object.entries(fieldErrors) as Array<[FieldKey, string]>).filter(([, v]) => v);
  const approverOptions = approverSelectOptions({ id: editingUser?.id ?? '', role: form.role }, users);
  const passwordRules = PASSWORD_RULES.map((r) => ({ ...r, ok: r.met(form.password) }));
  const focusField = (k: FieldKey) => {
    const el = fieldRefs.current[k];
    const target = el?.matches('input, textarea, select') ? el : el?.querySelector<HTMLElement>('input');
    target?.focus();
  };

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone who can sign in: their role, who approves their timesheets, and their overtime status."
        actions={<WriteButton leftSection={<Icons.create size={ICON_SIZE.button} />} onClick={openCreate}>Add user</WriteButton>}
      />
      <Group align="flex-end" gap="md" mb="sm" wrap="wrap">
        <Select label="Role" w={180} allowDeselect={false} value={roleFilter} onChange={(v) => setRoleFilter((v as 'all' | Role) ?? 'all')}
          data={[{ value: 'all', label: 'All roles' }, { value: 'admin', label: 'Admin' }, { value: 'supervisor', label: 'Supervisor' }, { value: 'employee', label: 'Employee' }]} />
        <Select label="Status" w={160} allowDeselect={false} value={statusFilter} onChange={(v) => setStatusFilter((v as StatusFilter) ?? 'active')}
          data={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'locked', label: 'Locked' }, { value: 'all', label: 'All' }]} />
        {seats && (
          <Text size="sm" c="dimmed" ml="auto" data-testid="seat-line">
            {formatCount(seats.active)} active{freeSeats !== null && seats.limit !== null ? ` · ${formatCount(freeSeats)} of ${formatCount(seats.limit)} seats free` : ''}
          </Text>
        )}
      </Group>
      <MantineReactTable table={table} />

      <ConfirmModal
        opened={!!confirmDeactivate}
        title={`Deactivate ${shownDeactivate?.fullName ?? ''}?`}
        message="They're signed out and can't sign in. Timesheets waiting for their approval go to admins. Their timesheets and history stay on record."
        confirmLabel="Deactivate"
        loading={confirmDeactivate ? busy.is(`active:${confirmDeactivate.id}`) : false}
        onConfirm={() => { if (confirmDeactivate) void handleToggleActive(confirmDeactivate, () => setConfirmDeactivate(null)); }}
        onCancel={() => setConfirmDeactivate(null)}
      />

      <ConfirmModal
        opened={!!confirmFlsa}
        tone="neutral"
        title={flsaCopy?.title ?? ''}
        message={flsaCopy?.message ?? ''}
        confirmLabel={flsaCopy?.confirmLabel}
        loading={busy.is('flsa')}
        onConfirm={() => { if (confirmFlsa) void handleToggleFlsaExempt(confirmFlsa, () => setConfirmFlsa(null)); }}
        onCancel={() => setConfirmFlsa(null)}
      />

      <Modal opened={!!resetTarget} onClose={() => { if (!busy.is('reset-password')) setResetTarget(null); }} title={`Reset password — ${shownReset?.fullName ?? ''}`} size="sm">
        <Stack>
          <Text size="sm" c="dimmed">Set a new password for {shownReset?.fullName} ({shownReset?.email}). They&apos;re signed out and sign in with it.</Text>
          <PasswordInput label="New password" required value={resetPassword} onChange={(e) => setResetPassword(e.currentTarget.value)} />
          {resetError && <Alert color="red" role="alert">{resetError}</Alert>}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => { if (!busy.is('reset-password')) setResetTarget(null); }}>Cancel</Button>
            <Button color="warning" {...busy.props('reset-password')} onClick={() => { void handleResetPassword(); }}>Reset password</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={!!mfaTarget} onClose={() => { if (!busy.is('reset-mfa')) setMfaTarget(null); }} title={`Reset two-step sign-in for ${shownMfa?.fullName ?? ''}?`} size="md">
        <Stack>
          <Text size="sm">They&apos;re signed out within a minute. They&apos;ll sign in with just their password and can turn two-step sign-in on again from their profile.</Text>
          <PasswordInput label="Your password" required value={mfaPassword} onChange={(e) => setMfaPassword(e.currentTarget.value)} autoComplete="current-password" />
          {mfaError && <Alert color="red" role="alert" data-testid="mfa-reset-error">{mfaError}</Alert>}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => { if (!busy.is('reset-mfa')) setMfaTarget(null); }}>Cancel</Button>
            <Button color="warning" {...busy.props('reset-mfa')} onClick={() => { void handleResetMfa(); }}>Reset two-step sign-in</Button>
          </Group>
        </Stack>
      </Modal>

      <Drawer
        opened={drawerOpen}
        onClose={() => { if (!busy.is('save')) setDrawerOpen(false); }}
        title={editingUser ? 'Edit user' : 'Add user'}
        position="right"
        size="md"
        closeOnEscape={!editConfirm}
      >
        <Stack>
          {/* One summary of every problem (links focus the field), plus the server's error — hidden while the role confirm shows it. */}
          {(errorList.length > 0 || (formError && !editConfirm)) && (
            <Alert color="red" role="alert" data-testid="user-form-alert">
              {errorList.length > 0 && (
                <>
                  <Text size="sm" fw={600}>Fix {formatCount(errorList.length)} {errorList.length === 1 ? 'thing' : 'things'} to {editingUser ? 'save this user' : 'add this user'}:</Text>
                  <List size="sm" mt={4}>
                    {errorList.map(([k, msg]) => (
                      <List.Item key={k}><Anchor component="button" type="button" size="sm" className={classes.alertLink} onClick={() => focusField(k)}>{msg}</Anchor></List.Item>
                    ))}
                  </List>
                </>
              )}
              {formError && !editConfirm && <Text size="sm" mt={errorList.length > 0 ? 4 : 0}>{formError}</Text>}
            </Alert>
          )}
          <TextInput label="Full name" required ref={(el) => { fieldRefs.current.fullName = el; }} error={fieldErrors.fullName}
            value={form.fullName} onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, fullName: v })); }} />
          <TextInput label="Email" type="email" required ref={(el) => { fieldRefs.current.email = el; }} error={fieldErrors.email}
            value={form.email} onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, email: v })); }} />
          <Select
            label="Role"
            description={editingUser?.id === currentUserId ? "You can't change your own role" : undefined}
            data={ROLE_OPTIONS}
            value={form.role}
            allowDeselect={false}
            onChange={(val) => { if (editingUser?.id !== currentUserId) setForm((f) => ({ ...f, role: val ?? 'employee' })); }}
            readOnly={editingUser?.id === currentUserId}
            required
          />
          {pickingApprovalClins && (
            <MultiSelect
              label="CLINs they approve"
              description="Charge code access doesn't change. Their approval scope starts with only what you choose here."
              data-testid="approval-clins"
              data={approvalClinGroups}
              value={form.approvalClinIds}
              onChange={(v) => setForm((f) => ({ ...f, approvalClinIds: v }))}
              searchable
              clearable
              placeholder={form.approvalClinIds.length === 0 ? 'None yet' : undefined}
            />
          )}
          <Radio.Group
            label="Overtime status" required description="Payroll export uses this to work out overtime."
            ref={(el) => { fieldRefs.current.overtime = el; }}
            value={form.overtime} error={fieldErrors.overtime}
            onChange={(v) => setForm((f) => ({ ...f, overtime: v as UserForm['overtime'] }))}
          >
            <Group mt={6}>
              <Radio value="nonexempt" label="Non-exempt (paid overtime)" />
              <Radio value="exempt" label="Exempt" />
            </Group>
          </Radio.Group>
          {(() => {
            return approverOptions && (
              <Select
                label="Approver"
                description="Who approves this person's timesheets. Without one, admins approve. Auditors prefer an independent reviewer."
                data={approverOptions}
                value={form.approverId}
                onChange={(val) => setForm((f) => ({ ...f, approverId: val ?? '' }))}
                allowDeselect={false}
              />
            );
          })()}
          {!editingUser && (
            <div>
              <PasswordInput label="Temporary password" required ref={(el) => { fieldRefs.current.password = el; }} error={fieldErrors.password}
                value={form.password} onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, password: v })); }}
                description="Share it with them privately. They can change it after signing in." />
              <ul className={classes.rules} data-testid="password-rules">
                {passwordRules.map((r) => <li key={r.id} data-met={r.ok || undefined}>{r.ok ? '✓' : '·'} {r.label}</li>)}
              </ul>
            </div>
          )}
          <Group justify="flex-end" gap="sm" mt="sm">
            {!editingUser && freeSeats !== null && <Text size="sm" c="dimmed" mr="auto" data-testid="seat-use">Uses 1 of {formatCount(freeSeats)} free seats</Text>}
            <Button variant="default" onClick={() => { if (!busy.is('save')) setDrawerOpen(false); }}>Cancel</Button>
            <WriteButton {...busy.props('save')} onClick={() => { void handleSubmit(); }}>{editingUser ? 'Save changes' : 'Add user'}</WriteButton>
          </Group>
        </Stack>
      </Drawer>

      <ConfirmModal
        opened={!!editConfirm}
        tone={editCopy?.tone}
        title={editCopy?.title ?? ''}
        message={editCopy?.message ?? ''}
        confirmLabel={editCopy?.confirmLabel}
        loading={busy.is('save')}
        error={formError}
        onConfirm={() => { void handleSubmit({ confirmed: true }); }}
        onCancel={() => { setEditConfirm(null); setFormError(null); }}   // UX-4A-AUDIT.md L3: the error belonged to the confirm
      />
    </>
  );
}
