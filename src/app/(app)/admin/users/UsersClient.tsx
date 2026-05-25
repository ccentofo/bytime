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
  Title,
  Badge,
  Switch,
  ActionIcon,
  Alert,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconEdit, IconKey, IconAlertCircle, IconLockOpen } from '@tabler/icons-react';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { createUserWithPassword, updateUser, getUsers, unlockUserAccount } from '@/server/actions/users';
import { adminResetPassword } from '@/server/actions/password';
import classes from "./Users.module.css";

type User = {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  isActive: boolean;
  flsaExempt: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type Props = {
  initialUsers: User[];
  currentUserId: string;
};

const ROLE_COLORS: Record<string, string> = {
  admin: 'red',
  supervisor: 'blue',
  employee: 'green',
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
};

const EMPTY_FORM: UserForm = {
  email: '',
  fullName: '',
  role: 'employee',
  password: '',
};

export function UsersClient({ initialUsers, currentUserId }: Props) {
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
    });
    setFormError(null);
    setModalOpen(true);
  }

  function handleSubmit() {
    startTransition(async () => {
      try {
        setFormError(null);
        if (editingUser) {
          // Update existing user
          const updateData: { fullName?: string; email?: string; role?: 'admin' | 'supervisor' | 'employee' } = {};
          if (form.fullName !== editingUser.fullName) updateData.fullName = form.fullName;
          if (form.email !== editingUser.email) updateData.email = form.email;
          if (form.role !== editingUser.role) updateData.role = form.role as 'admin' | 'supervisor' | 'employee';

          if (Object.keys(updateData).length > 0) {
            await updateUser(editingUser.id, updateData);
          }
          notifications.show({
            title: 'User Updated',
            message: `${form.fullName} has been updated successfully.`,
            color: 'green',
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
          await createUserWithPassword({
            email: form.email,
            fullName: form.fullName,
            role: form.role as 'admin' | 'supervisor' | 'employee',
            password: form.password,
          });
          notifications.show({
            title: 'User Created',
            message: `${form.fullName} has been created successfully.`,
            color: 'green',
          });
        }

        // Refresh user list
        const refreshed = await getUsers();
        setUsers(refreshed as User[]);
        setModalOpen(false);
      } catch (error) {
        setFormError(String(error));
        notifications.show({
          title: 'Action Failed',
          message: 'Something went wrong. Please try again.',
          color: 'red',
        });
      }
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
      await unlockUserAccount(user.email);
      notifications.show({
        title: 'Account Unlocked',
        message: `${user.fullName}'s account has been unlocked. They can now log in.`,
        color: 'green',
      });
    });
  }

  function handleResetPassword() {
    if (!resetTarget || !resetPassword) return;
    startTransition(async () => {
      try {
        setResetError(null);
        const result = await adminResetPassword({
          targetUserId: resetTarget.id,
          newPassword: resetPassword,
          adminUserId: currentUserId,
        });
        if (result.success) {
          setResetModalOpen(false);
          notifications.show({
            title: 'Password Reset',
            message: `Password for ${resetTarget.fullName} has been reset.`,
            color: 'green',
          });
        } else {
          setResetError(result.error ?? 'Failed to reset password.');
        }
      } catch (error) {
        setResetError(String(error));
      }
    });
  }

  function handleToggleFlsaExempt(user: User) {
    startTransition(async () => {
      const newExempt = !user.flsaExempt;
      await updateUser(user.id, { flsaExempt: newExempt });
      const refreshed = await getUsers();
      setUsers(refreshed as User[]);
      notifications.show({
        title: newExempt ? 'FLSA Exempt' : 'FLSA Non-Exempt',
        message: `${user.fullName} is now ${newExempt ? 'FLSA Exempt (salaried)' : 'FLSA Non-Exempt (hourly)'}.`,
        color: newExempt ? 'blue' : 'gray',
      });
    });
  }

  function handleToggleActive(user: User) {
    startTransition(async () => {
      const newActive = !user.isActive;
      await updateUser(user.id, { isActive: newActive });
      const refreshed = await getUsers();
      setUsers(refreshed as User[]);
      notifications.show({
        title: newActive ? 'User Activated' : 'User Deactivated',
        message: `${user.fullName} has been ${newActive ? 'activated' : 'deactivated'}.`,
        color: newActive ? 'green' : 'yellow',
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
        const role = cell.getValue<string>();
        return (
          <Badge color={ROLE_COLORS[role] ?? 'gray'}>
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
        <Switch
          checked={row.original.isActive}
          onChange={() => handleToggleActive(row.original)}
          disabled={isPending}
          size="sm"
        />
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
          disabled={isPending}
          size="sm"
          label={row.original.flsaExempt ? 'Exempt' : 'Non-Exempt'}
        />
      ),
      size: 140,
    },
  ];

  const table = useMantineReactTable({
    columns,
    data: users,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
      <Group gap="xs" wrap="nowrap">
        <ActionIcon
          variant="subtle"
          onClick={() => openEditModal(row.original)}
          title="Edit User"
        >
          <IconEdit size={16} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="orange"
          onClick={() => openResetModal(row.original)}
          title="Reset Password"
        >
          <IconKey size={16} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="green"
          onClick={() => handleUnlockAccount(row.original)}
          title="Unlock Account"
          disabled={isPending}
        >
          <IconLockOpen size={16} />
        </ActionIcon>
      </Group>
    ),
    renderTopToolbarCustomActions: () => (
      <Button leftSection={<IconPlus size={16} />} onClick={openCreateModal}>
        Add User
      </Button>
    ),
    enableColumnActions: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
      className: classes.tableHeaderCell,
      style: {
        fontWeight: 600,
        fontSize: '0.85rem',
        padding: '12px 16px',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        fontSize: '0.875rem',
        padding: '12px 16px',
      },
    },
    mantineTopToolbarProps: {
      style: {
        padding: '12px 16px',
      },
    },
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 120,
        mantineTableHeadCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
        mantineTableBodyCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
      },
    },
  });

  return (
    <>
      <Title order={2} mb="md">User Management</Title>
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
            <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
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
              color="orange"
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
            data={ROLE_OPTIONS}
            value={form.role}
            onChange={(val) => setForm((f) => ({ ...f, role: val ?? 'employee' }))}
            required
          />
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
            <Badge color="red" variant="light" size="lg" style={{ whiteSpace: 'normal', height: 'auto', padding: '8px' }}>
              {formError}
            </Badge>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} loading={isPending}>
              {editingUser ? 'Save Changes' : 'Create User'}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
