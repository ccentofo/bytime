# Blueprint: Admin Route Protection + User Management

> **This ticket contains TWO phases. Complete Phase A fully before starting Phase B.**

---

## Phase A: Server-Side Admin Route Protection

### Problem

Admin pages (`/admin/contracts`, `/admin/assignments`, `/admin/approvals`) are only hidden via navbar — an employee can type the URL directly and access them. We need server-side role checks.

### Execution Steps

**A1.** Modify `src/app/(app)/admin/contracts/page.tsx` — add role check at the top of the async function, before any data fetching:

```typescript
import { requireAdmin } from '@/lib/session';
```

Add as the first line inside the default export function:

```typescript
await requireAdmin();
```

The `requireAdmin()` function (already exists in `src/lib/session.ts`) throws `'Forbidden: Admin or Supervisor role required'` if the user is not admin/supervisor. Next.js will show an error page.

For a better UX, wrap the call and redirect instead:

```typescript
import { auth } from '@/auth';
import { redirect } from 'next/navigation';

// Add at top of the function body, BEFORE existing code:
const session = await auth();
if (!session?.user) redirect('/login');
const role = (session.user as any).role;
if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');
```

**A2.** Apply the same pattern to `src/app/(app)/admin/assignments/page.tsx`:

```typescript
import { auth } from '@/auth';
import { redirect } from 'next/navigation';

// Add at top of the function body:
const session = await auth();
if (!session?.user) redirect('/login');
const role = (session.user as any).role;
if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');
```

**A3.** Apply the same pattern to `src/app/(app)/admin/approvals/page.tsx`:

```typescript
import { auth } from '@/auth';
import { redirect } from 'next/navigation';

// Add at top of the function body:
const session = await auth();
if (!session?.user) redirect('/login');
const role = (session.user as any).role;
if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');
```

### Phase A Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected |
|---|---|
| Login as `jane.smith@bytime.dev` (employee) | No admin links in navbar |
| Type `/admin/contracts` in URL bar | Redirected to `/timesheet` |
| Type `/admin/assignments` in URL bar | Redirected to `/timesheet` |
| Type `/admin/approvals` in URL bar | Redirected to `/timesheet` |
| Login as `admin@bytime.dev` | Admin links visible; all admin pages load normally |
| Login as `sarah.wilson@bytime.dev` (supervisor) | Admin links visible; all admin pages load normally |

**⚠️ Do NOT proceed to Phase B until Phase A builds and verifies correctly.**

---

## Phase B: User Management Admin Page

### Problem

There is no UI to create users, change roles, or manage accounts. The `seedUsers()` function was a dev workaround. Admins need a proper management page.

### File Topology

```
Files to CREATE:
├── src/app/(app)/admin/users/
│   ├── page.tsx                    ← Server Component: fetch users, role-check
│   └── UsersClient.tsx             ← Client Component: MRT table + create/edit modal

Files to MODIFY:
├── src/server/actions/users.ts     ← Add updateUser(), deactivateUser()
├── src/components/shell/AppNavbar.tsx ← Add "User Management" nav link

Files NOT TOUCHED:
├── src/db/schema.ts                ← ❌ DO NOT MODIFY (users table already has all needed columns)
├── src/auth.ts                     ← ❌ DO NOT MODIFY
├── src/middleware.ts               ← ❌ DO NOT MODIFY
├── src/components/timesheet/*      ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/* ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/* ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/approvals/* ← ❌ DO NOT MODIFY
```

### Execution Steps

> **⚠️ GUARDRAILS:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** read documentation files or search for library docs.
> - **DO NOT** modify any files listed in "NOT TOUCHED".
> - Use **Mantine v9** and **Mantine React Table v2**.
> - Use `bcryptjs` (NOT `bcrypt`) for password hashing.

---

**B1.** Modify `src/server/actions/users.ts` — add `updateUser` and `deactivateUser` functions at the END of the file. Do NOT modify existing functions:

```typescript
export async function updateUser(id: string, data: {
  fullName?: string;
  email?: string;
  role?: 'admin' | 'supervisor' | 'employee';
  isActive?: boolean;
}) {
  const rows = await db.update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return rows[0];
}

export async function createUserWithPassword(data: {
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  password: string;
}) {
  const hash = await bcrypt.hash(data.password, 12);
  const rows = await db.insert(users).values({
    email: data.email,
    fullName: data.fullName,
    role: data.role,
    passwordHash: hash,
  }).returning();
  return rows[0];
}
```

Ensure the `eq` import from `drizzle-orm` is present (it should already be imported from the `seedUsers` function). Ensure `bcrypt` is imported as `bcryptjs` (should already be `import bcrypt from 'bcryptjs'`).

---

**B2.** Add "User Management" nav link to `src/components/shell/AppNavbar.tsx`:

Import `IconUserCog` from `@tabler/icons-react`.

Add this NavLink inside the `{isAdmin && (...)}` block, after the "Timesheet Approvals" link:

```tsx
<NavLink
  label="User Management"
  href="/admin/users"
  leftSection={<IconUserCog size={18} />}
  active={pathname === '/admin/users'}
/>
```

---

**B3.** Create `src/app/(app)/admin/users/page.tsx`:

```tsx
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getUsers } from '@/server/actions/users';
import { UsersClient } from './UsersClient';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');

  const users = await getUsers();
  return <UsersClient initialUsers={users} />;
}
```

---

**B4.** Create `src/app/(app)/admin/users/UsersClient.tsx`:

```tsx
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
import { IconPlus, IconEdit } from '@tabler/icons-react';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { createUserWithPassword, updateUser, getUsers } from '@/server/actions/users';

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
        }

        // Refresh user list
        const refreshed = await getUsers();
        setUsers(refreshed as User[]);
        setModalOpen(false);
      } catch (error) {
        setFormError(String(error));
      }
    });
  }

  function handleToggleActive(user: User) {
    startTransition(async () => {
      await updateUser(user.id, { isActive: !user.isActive });
      const refreshed = await getUsers();
      setUsers(refreshed as User[]);
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
```

---

### Phase B Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected |
|---|---|
| **Navbar** | "User Management" link appears under ADMINISTRATION (admin/supervisor only) |
| **Visit `/admin/users`** | Mantine React Table shows all users with Name, Email, Role, Active columns |
| **Click "Add User"** | Modal opens with name, email, role, password fields |
| **Create user with short password** | Error: "Password must be at least 8 characters" |
| **Create valid user** | New row appears in table; user can log in with the password |
| **Click Edit (pencil icon)** | Modal opens pre-filled (no password field for existing users) |
| **Change role from employee to supervisor** | Saves; badge color changes |
| **Toggle Active switch** | User deactivated; they cannot log in (auth checks `isActive`) |
| **Employee visits `/admin/users`** | Redirected to `/timesheet` |

---

## Guardrail Verification (Both Phases)

```bash
git diff --name-only
```

Must **NOT** include:
- `src/components/timesheet/*` (any timesheet component)
- `src/db/schema.ts`
- `src/auth.ts`
- `src/middleware.ts`
- `src/app/(app)/admin/contracts/ContractsClient.tsx`
- `src/app/(app)/admin/assignments/AssignmentsClient.tsx`
- `src/app/(app)/admin/approvals/ApprovalsClient.tsx`

**SHOULD** include:
- `src/app/(app)/admin/contracts/page.tsx` (Phase A — role check added)
- `src/app/(app)/admin/assignments/page.tsx` (Phase A — role check added)
- `src/app/(app)/admin/approvals/page.tsx` (Phase A — role check added)
- `src/server/actions/users.ts` (Phase B — new functions)
- `src/components/shell/AppNavbar.tsx` (Phase B — new nav link)
- `src/app/(app)/admin/users/page.tsx` (Phase B — new)
- `src/app/(app)/admin/users/UsersClient.tsx` (Phase B — new)
