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
  Switch,
  ActionIcon,
  Tooltip,
  Alert,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { runAction } from '@/lib/run-action';
import { IconPlus, IconEdit, IconKey, IconAlertCircle, IconLockOpen } from '@tabler/icons-react';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { useAppTable } from '@/components/table/mrtDefaults';
import { createUserWithPassword, updateUser, getUsers, unlockUserAccount, setUserApprover } from '@/server/actions/users';
import { adminResetPassword } from '@/server/actions/password';
import { ROLE_COLOR } from '@/lib/ui/status-colors';
import { PageHeader } from '@/components/ui/PageHeader';
import { WriteButton, useCanWrite } from '@/components/shell/WorkspaceMode';
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
  const canWrite = useCanWrite();
  const [users, setUsers] = useState<User[]>(initialUsers);
  const [isPending, startTransition] = useTransition();

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
    startTransition(async () => {
      const result = await runAction(unlockUserAccount(user.email), { errorTitle: 'Couldn’t unlock account' });
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

  function handleToggleFlsaExempt(user: User) {
    startTransition(async () => {
      const newExempt = !user.flsaExempt;
      const result = await runAction(updateUser(user.id, { flsaExempt: newExempt }), { errorTitle: 'Action Failed' });
      if (!result.ok) return;
      const refreshed = await getUsers();
      setUsers(refreshed as User[]);
      notifications.show({
        title: newExempt ? 'FLSA Exempt' : 'FLSA Non-Exempt',
        message: `${user.fullName} is now ${newExempt ? 'FLSA Exempt (salaried)' : 'FLSA Non-Exempt (hourly)'}.`,
        color: newExempt ? 'signal' : 'gray',
      });
    });
  }

  function handleToggleActive(user: User) {
    startTransition(async () => {
      const newActive = !user.isActive;
      const result = await runAction(updateUser(user.id, { isActive: newActive }), { errorTitle: 'Action Failed' });
      if (!result.ok) return;
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
      header: 'Active',
      Cell: ({ row }) => (
        <Tooltip label={row.original.id === currentUserId ? "You can't deactivate your own account" : undefined} disabled={row.original.id !== currentUserId}>
          <Switch
            checked={row.original.isActive}
            onChange={() => handleToggleActive(row.original)}
            disabled={!canWrite || (isPending || row.original.id === currentUserId)}
            size="sm"
          />
        </Tooltip>
      ),
      size: 90,
    },
    {
      accessorKey: 'flsaExempt',
      header: 'FLSA Exempt',
      Cell: ({ row }) => (
        <Switch
          checked={row.original.flsaExempt}
          onChange={() => handleToggleFlsaExempt(row.original)}
          disabled={!canWrite || (isPending)}
          size="sm"
          label={row.original.flsaExempt ? 'Exempt' : 'Non-Exempt'}
        />
      ),
      size: 140,
    },
  ];

  const table = useAppTable({
    columns,
    data: users,
    enableRowActions: true,
    renderRowActions: ({ row }) => (
      <Group gap="xs" wrap="nowrap" justify="center">
        <Tooltip label="Edit User">
          <ActionIcon disabled={!canWrite} variant="subtle" onClick={() => openEditModal(row.original)} aria-label="Edit user">
            <IconEdit size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Reset Password">
          <ActionIcon
            variant="subtle"
            color="warning"
            onClick={() => openResetModal(row.original)}
            aria-label="Reset password"
          >
            <IconKey size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Unlock Account">
          <ActionIcon
            variant="subtle"
            color="success"
            onClick={() => handleUnlockAccount(row.original)}
            disabled={isPending}
            aria-label="Unlock account"
          >
            <IconLockOpen size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
    ),
  });

  return (
    <>
      <PageHeader
        title="User Management"
        actions={
          <WriteButton leftSection={<IconPlus size={16} />} onClick={openCreateModal}>
            Add User
          </WriteButton>
        }
      />
      <MantineReactTable table={table} />

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
            <Alert icon={<IconAlertCircle size={16} />} color="red">
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
