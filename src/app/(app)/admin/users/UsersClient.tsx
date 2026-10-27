'use client';

import { useState, useTransition } from 'react';
import {
  Button,
  Modal,
  TextInput,
  PasswordInput,
  Select,
  Group,
  Stack,
  Badge,
  Alert,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { runAction } from '@/lib/run-action';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { RowActions } from '@/components/ui/RowActions';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { useAppTable } from '@/components/table/mrtDefaults';
import { createUserWithPassword, updateUser, getUsers, unlockUserAccount, setUserApprover } from '@/server/actions/users';
import { adminResetPassword } from '@/server/actions/password';
import { RECORD_STATUS_COLOR, ROLE_COLOR } from '@/lib/ui/status-colors';
import { PageHeader } from '@/components/ui/PageHeader';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { approverSelectOptions } from '@/lib/approvals/approver-options';

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
};

type Props = {
  initialUsers: User[];
  currentUserId: string;
};

const ROLE_OPTIONS = [
  { value: 'employee', label: 'Employee' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'admin', label: 'Admin' },
];

type UserForm = {
  email: string;
  fullName: string;
  role: string;
  password: string;
  /** certified-outputs C2: designated approver ('' = none — admins approve). Supervisor/admin users only. */
  approverId: string;
};

const EMPTY_FORM: UserForm = {
  email: '',
  fullName: '',
  role: 'employee',
  password: '',
  approverId: '',
};

export function UsersClient({ initialUsers, currentUserId }: Props) {
  const [users, setUsers] = useState<User[]>(initialUsers);
  const [isPending, startTransition] = useTransition();
  // Row actions that run without a confirm (Unlock, Reactivate) show a loader on THEIR row only.
  const [busyRow, setBusyRow] = useState<string | null>(null);
  // Confirmations (feature-plan-ux-foundations.md §4.5, B2): deactivation and FLSA status ask first.
  const [confirmDeactivate, setConfirmDeactivate] = useState<User | null>(null);
  const [confirmFlsa, setConfirmFlsa] = useState<User | null>(null);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [form, setForm] = useState<UserForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  // Reset password modal state
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);

  function openCreateModal() {
    setEditingUser(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  }

  function openEditModal(user: User) {
    setEditingUser(user);
    setForm({
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      password: '', // Don't pre-fill password
      approverId: user.approverId ?? '',
    });
    setFormError(null);
    setModalOpen(true);
  }

  function handleSubmit() {
    startTransition(async () => {
      setFormError(null);
      if (editingUser) {
        // Update existing user
        const updateData: { fullName?: string; email?: string; role?: 'admin' | 'supervisor' | 'employee' } = {};
        if (form.fullName !== editingUser.fullName) updateData.fullName = form.fullName;
        if (form.email !== editingUser.email) updateData.email = form.email;
        if (form.role !== editingUser.role) updateData.role = form.role as 'admin' | 'supervisor' | 'employee';

        if (Object.keys(updateData).length > 0) {
          const result = await runAction(updateUser(editingUser.id, updateData), { silent: true });
          if (!result.ok) {
            setFormError(result.error);
            return;
          }
        }
        // C2 (CO-D12): the approver is designated separately, and only for supervisor/admin users.
        if ((form.role === 'supervisor' || form.role === 'admin') && form.approverId !== (editingUser.approverId ?? '')) {
          const result = await runAction(setUserApprover(editingUser.id, form.approverId || null), { silent: true });
          if (!result.ok) {
            setFormError(result.error);
            return;
          }
        }
        notifications.show({
          title: 'User Updated',
          message: `${form.fullName} has been updated successfully.`,
          color: 'success',
        });
      } else {
        // Create new user
        if (!form.email || !form.fullName || !form.password) {
          setFormError('All fields are required for new users.');
          return;
        }
        if (form.password.length < 8) {
          setFormError('Password must be at least 8 characters.');
          return;
        }
        const result = await runAction(createUserWithPassword({
          email: form.email,
          fullName: form.fullName,
          role: form.role as 'admin' | 'supervisor' | 'employee',
          password: form.password,
        }), { silent: true });
        if (!result.ok) {
          setFormError(result.error); // e.g. the plan's seat limit, verbatim
          return;
        }
        notifications.show({
          title: 'User Created',
          message: `${form.fullName} has been created successfully.`,
          color: 'success',
        });
      }

      // Refresh user list
      const refreshed = await getUsers();
      setUsers(refreshed as User[]);
      setModalOpen(false);
    });
  }

  function openResetModal(user: User) {
    setResetTarget(user);
    setResetPassword('');
    setResetError(null);
    setResetModalOpen(true);
  }

  function handleUnlockAccount(user: User) {
    setBusyRow(user.id);
    startTransition(async () => {
      const result = await runAction(unlockUserAccount(user.email), { errorTitle: 'Couldn’t unlock account' });
      setBusyRow(null);
      if (!result.ok) return;
      notifications.show({
        title: 'Account Unlocked',
        message: `${user.fullName}'s account has been unlocked. They can now log in.`,
        color: 'success',
      });
    });
  }

  function handleResetPassword() {
    if (!resetTarget || !resetPassword) return;
    startTransition(async () => {
      setResetError(null);
      const result = await runAction(adminResetPassword({
        targetUserId: resetTarget.id,
        newPassword: resetPassword,
      }), { silent: true });
      if (!result.ok) {
        setResetError(result.error);
        return;
      }
      setResetModalOpen(false);
      notifications.show({
        title: 'Password Reset',
        message: `Password for ${resetTarget.fullName} has been reset.`,
        color: 'success',
      });
    });
  }

  /** Same server call as before; the confirm closes only on success (onDone). */
  function handleToggleFlsaExempt(user: User, onDone?: () => void) {
    startTransition(async () => {
      const newExempt = !user.flsaExempt;
      const result = await runAction(updateUser(user.id, { flsaExempt: newExempt }), { errorTitle: 'Action Failed' });
      if (!result.ok) return;
      onDone?.();
      const refreshed = await getUsers();
      setUsers(refreshed as User[]);
      notifications.show({
        title: newExempt ? 'FLSA Exempt' : 'FLSA Non-Exempt',
        message: `${user.fullName} is now ${newExempt ? 'FLSA Exempt (salaried)' : 'FLSA Non-Exempt (hourly)'}.`,
        color: newExempt ? 'signal' : 'gray',
      });
    });
  }

  /** Same server call as before; deactivation runs from the confirm (closed only on success), reactivation directly. */
  function handleToggleActive(user: User, onDone?: () => void) {
    if (!onDone) setBusyRow(user.id);
    startTransition(async () => {
      const newActive = !user.isActive;
      const result = await runAction(updateUser(user.id, { isActive: newActive }), { errorTitle: 'Action Failed' });
      setBusyRow(null);
      if (!result.ok) return;
      onDone?.();
      const refreshed = await getUsers();
      setUsers(refreshed as User[]);
      notifications.show({
        title: newActive ? 'User Activated' : 'User Deactivated',
        message: `${user.fullName} has been ${newActive ? 'activated' : 'deactivated'}.`,
        color: newActive ? 'success' : 'warning',
      });
    });
  }

  const columns: MRT_ColumnDef<User>[] = [
    { accessorKey: 'fullName', header: 'Name', size: 180 },
    { accessorKey: 'email', header: 'Email', size: 220 },
    {
      accessorKey: 'role',
      header: 'Role',
      Cell: ({ cell }) => {
        const role = cell.getValue<string>() as keyof typeof ROLE_COLOR;
        return (
          <Badge color={ROLE_COLOR[role] ?? 'gray'}>
            {role.charAt(0).toUpperCase() + role.slice(1)}
          </Badge>
        );
      },
      size: 120,
    },
    {
      accessorKey: 'isActive',
      header: 'Status',
      Cell: ({ row }) => (
        <Badge color={row.original.isActive ? RECORD_STATUS_COLOR.active : RECORD_STATUS_COLOR.inactive}>
          {row.original.isActive ? 'Active' : 'Inactive'}
        </Badge>
      ),
      size: 100,
    },
    {
      accessorKey: 'flsaExempt',
      header: 'FLSA',
      Cell: ({ row }) => (row.original.flsaExempt ? 'Exempt' : 'Non-exempt'),
      size: 110,
    },
  ];

  const table = useAppTable({
    columns,
    data: users,
    enableRowActions: true,
    renderRowActions: ({ row }) => {
      const user = row.original;
      return (
        <RowActions
          rowLabel={user.fullName}
          primary={{ key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => openEditModal(user) }}
          items={[
            // Credential actions stay available in read-only mode, matching the server (users.ts unlock, password.ts).
            { key: 'reset-password', label: 'Reset password…', icon: 'resetPassword', writes: false, onSelect: () => openResetModal(user) },
            { key: 'unlock', label: 'Unlock account', icon: 'unlock', writes: false, busy: busyRow === user.id, onSelect: () => handleUnlockAccount(user) },
            { key: 'flsa', label: user.flsaExempt ? 'Mark as non-exempt…' : 'Mark as FLSA exempt…', icon: 'flsa', onSelect: () => setConfirmFlsa(user) },
            user.isActive
              ? {
                key: 'deactivate', label: 'Deactivate…', icon: 'deactivate', tone: 'danger', onSelect: () => setConfirmDeactivate(user),
                disabledReason: user.id === currentUserId ? "You can't deactivate your own account" : undefined,
              }
              : { key: 'reactivate', label: 'Reactivate', icon: 'reactivate', busy: busyRow === user.id, onSelect: () => handleToggleActive(user) },
          ]}
        />
      );
    },
  });

  return (
    <>
      <PageHeader
        title="User Management"
        actions={
          <WriteButton leftSection={<Icons.create size={ICON_SIZE.button} />} onClick={openCreateModal}>
            Add User
          </WriteButton>
        }
      />
      <MantineReactTable table={table} />

      <ConfirmModal
        opened={!!confirmDeactivate}
        title={`Deactivate ${confirmDeactivate?.fullName ?? ''}?`}
        message="They're signed out and can't sign in. Timesheets waiting for their approval go to admins. Their timesheets and history stay on record."
        confirmLabel="Deactivate"
        loading={isPending}
        onConfirm={() => confirmDeactivate && handleToggleActive(confirmDeactivate, () => setConfirmDeactivate(null))}
        onCancel={() => setConfirmDeactivate(null)}
      />

      <ConfirmModal
        opened={!!confirmFlsa}
        tone="neutral"
        title={confirmFlsa ? `Mark ${confirmFlsa.fullName} as FLSA ${confirmFlsa.flsaExempt ? 'non-exempt' : 'exempt'}?` : ''}
        message="Payroll export uses this to calculate overtime for every period, including past ones."
        confirmLabel={confirmFlsa?.flsaExempt ? 'Mark as non-exempt' : 'Mark as exempt'}
        loading={isPending}
        onConfirm={() => confirmFlsa && handleToggleFlsaExempt(confirmFlsa, () => setConfirmFlsa(null))}
        onCancel={() => setConfirmFlsa(null)}
      />

      <Modal
        opened={resetModalOpen}
        onClose={() => setResetModalOpen(false)}
        title={`Reset Password — ${resetTarget?.fullName}`}
        size="sm"
      >
        <Stack>
          <Text size="sm" c="dimmed">
            Set a new password for {resetTarget?.fullName} ({resetTarget?.email}).
            The user will need to use this password to log in.
          </Text>
          <PasswordInput
            label="New Password"
            placeholder="Minimum 8 characters"
            value={resetPassword}
            onChange={(e) => setResetPassword(e.currentTarget.value)}
            required
          />
          {resetError && (
            <Alert icon={<Icons.statusError size={ICON_SIZE.button} />} color="red">
              {resetError}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setResetModalOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleResetPassword}
              loading={isPending}
              disabled={!resetPassword || resetPassword.length < 8}
              color="warning"
            >
              Reset Password
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingUser ? 'Edit User' : 'Create User'}
        size="md"
      >
        <Stack>
          <TextInput
            label="Full Name"
            required
            value={form.fullName}
            onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
          />
          <TextInput
            label="Email"
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
          <Select
            label="Role"
            description={editingUser?.id === currentUserId ? "You can't change your own role" : undefined}
            data={ROLE_OPTIONS}
            value={form.role}
            onChange={(val) => setForm((f) => ({ ...f, role: val ?? 'employee' }))}
            disabled={editingUser?.id === currentUserId}
            required
          />
          {(() => {
            const approverOptions = editingUser ? approverSelectOptions({ id: editingUser.id, role: form.role }, users) : null;
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
            <PasswordInput
              label="Password"
              required
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              placeholder="Minimum 8 characters"
            />
          )}
          {formError && (
            <Badge color="red" size="lg" style={{ whiteSpace: 'normal', height: 'auto', padding: '8px' }}>
              {formError}
            </Badge>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <WriteButton onClick={handleSubmit} loading={isPending}>
              {editingUser ? 'Save Changes' : 'Create User'}
            </WriteButton>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
