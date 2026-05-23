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
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconEdit } from '@tabler/icons-react';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { createUserWithPassword, updateUser, getUsers } from '@/server/actions/users';
import classes from "./Users.module.css";

type User = {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type Props = {
  initialUsers: User[];
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

export function UsersClient({ initialUsers }: Props) {
  const [users, setUsers] = useState<User[]>(initialUsers);
  const [isPending, startTransition] = useTransition();

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [form, setForm] = useState<UserForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

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
  ];

  const table = useMantineReactTable({
    columns,
    data: users,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
      <ActionIcon
        variant="subtle"
        onClick={() => openEditModal(row.original)}
        title="Edit User"
      >
        <IconEdit size={16} />
      </ActionIcon>
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
        size: 80,
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
