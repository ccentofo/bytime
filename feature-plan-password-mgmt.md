# Blueprint: Password Management — Self-Service Password Change & Reset Flow

## 1. Architectural Overview & DCAA Impact

### The Problem

The current authentication system (from `feature-plan-auth.md`) supports:
- ✅ Email + password login via Auth.js v5 Credentials provider
- ✅ bcrypt password hashing (cost factor 12)
- ✅ Admin user creation with password (via User Management page)

But it is missing:
- ❌ **Self-service password change** — Users cannot change their own password
- ❌ **Forgot password / reset flow** — No recovery mechanism if a user forgets their password
- ❌ **Admin password reset** — Admins cannot reset a user's password without knowing the current one
- ❌ **Password policy enforcement** — Only minimum length (8 chars) is enforced; no complexity rules
- ❌ **Password expiry** — No mechanism to force periodic password changes (common in GovCon environments)

### Why This Matters for DCAA

DCAA requires that timekeeping systems have adequate access controls. If a user is locked out of their account with no recovery path, they cannot log time daily (FAR 31.201-1 violation). Additionally, NIST SP 800-63B (which many government contracts reference) requires:
- Minimum 8-character passwords
- Breached password checking (future enhancement)
- No mandatory complexity rules (NIST reversed this in 2017)
- Support for password changes

### Design Decisions

1. **Self-service password change** — Available from the user profile menu in the header. Requires current password + new password.
2. **Admin password reset** — Available from the User Management page. Generates a temporary password or sets a new one directly (no email needed for MVP).
3. **No email-based reset for MVP** — Email infrastructure isn't set up yet (that's a separate blueprint). For MVP, password resets go through admins.
4. **Password policy** — Minimum 8 characters. No complexity rules (per NIST SP 800-63B). Max 128 characters.
5. **Last password change tracking** — New `passwordChangedAt` column for audit trail.

---

## 2. File Topology

```
Files to CREATE:
├── src/app/(app)/profile/
│   ├── page.tsx                                     ← Server Component: user profile page
│   └── ProfileClient.tsx                            ← Client Component: password change form
├── src/server/actions/password.ts                   ← Server Actions: change password, admin reset

Files to MODIFY:
├── src/db/schema.ts                                 ← Add passwordChangedAt column to users table
├── src/server/actions/users.ts                      ← Add resetUserPassword function
├── src/app/(app)/admin/users/UsersClient.tsx         ← Add "Reset Password" action to user table
├── src/components/shell/AppHeader.tsx                ← Add "Change Password" menu item

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/auth.ts                                      ← ❌ DO NOT MODIFY
├── src/middleware.ts                                ← ❌ DO NOT MODIFY
├── src/components/timesheet/*                       ← ❌ DO NOT MODIFY
├── src/components/shell/AppNavbar.tsx                ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                    ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/clins.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/assignments.ts                ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/*                 ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/approvals/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/audit-trail/*                 ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/dashboard/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/labor-categories/*             ← ❌ DO NOT MODIFY
├── src/app/(app)/timesheet/*                         ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify any files listed in the "DO NOT MODIFY" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`, `@mantine/notifications`).
> - Use `bcryptjs` (NOT `bcrypt`) for password hashing — check the existing import pattern in `src/server/actions/users.ts`.
> - Follow the step order exactly. Each step builds on the previous one.
> - **After completing each phase, run `npm run build` to verify zero errors.**

---

### Phase A: Schema Update (A1)

#### A1. Modify `src/db/schema.ts` — Add `passwordChangedAt` column to users table

Add this column after the `passwordHash` column:

```typescript
passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
```

The full `users` table should become:

```typescript
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  fullName: varchar('full_name', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull().default('employee'),
  isActive: boolean('is_active').notNull().default(true),
  passwordHash: varchar('password_hash', { length: 255 }),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Push the schema change:

```bash
npx drizzle-kit push
```

---

### Phase B: Password Server Actions (B1)

#### B1. Create `src/server/actions/password.ts`

```typescript
'use server';

import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

// ---------------------------------------------------------------------------
// Password Validation
// ---------------------------------------------------------------------------

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

function validatePassword(password: string): string | null {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must not exceed ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null; // Valid
}

// ---------------------------------------------------------------------------
// Self-Service Password Change
// ---------------------------------------------------------------------------

/**
 * Change the current user's password.
 * Requires the current password for verification.
 */
export async function changePassword(data: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<{ success: boolean; error?: string }> {
  // Validate new password
  const validationError = validatePassword(data.newPassword);
  if (validationError) {
    return { success: false, error: validationError };
  }

  // Get current user
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, data.userId));

  if (!user) {
    return { success: false, error: 'User not found.' };
  }

  if (!user.passwordHash) {
    return { success: false, error: 'Account has no password set. Contact your administrator.' };
  }

  // Verify current password
  const isValid = await bcrypt.compare(data.currentPassword, user.passwordHash);
  if (!isValid) {
    return { success: false, error: 'Current password is incorrect.' };
  }

  // Check new password is different from current
  const isSame = await bcrypt.compare(data.newPassword, user.passwordHash);
  if (isSame) {
    return { success: false, error: 'New password must be different from your current password.' };
  }

  // Hash and save new password
  const newHash = await bcrypt.hash(data.newPassword, 12);
  await db.update(users)
    .set({
      passwordHash: newHash,
      passwordChangedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, data.userId));

  return { success: true };
}

// ---------------------------------------------------------------------------
// Admin Password Reset
// ---------------------------------------------------------------------------

/**
 * Reset a user's password (admin action).
 * Does NOT require the current password — only admins can call this.
 */
export async function adminResetPassword(data: {
  targetUserId: string;
  newPassword: string;
  adminUserId: string;
}): Promise<{ success: boolean; error?: string }> {
  // Validate new password
  const validationError = validatePassword(data.newPassword);
  if (validationError) {
    return { success: false, error: validationError };
  }

  // Verify the admin exists and has the right role
  const [admin] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, data.adminUserId));

  if (!admin || (admin.role !== 'admin' && admin.role !== 'supervisor')) {
    return { success: false, error: 'Unauthorized: Only admins can reset passwords.' };
  }

  // Verify target user exists
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, data.targetUserId));

  if (!target) {
    return { success: false, error: 'User not found.' };
  }

  // Hash and save new password
  const newHash = await bcrypt.hash(data.newPassword, 12);
  await db.update(users)
    .set({
      passwordHash: newHash,
      passwordChangedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, data.targetUserId));

  return { success: true };
}

// ---------------------------------------------------------------------------
// Password Info Query
// ---------------------------------------------------------------------------

/**
 * Get password metadata for a user (last changed date).
 */
export async function getPasswordInfo(userId: string): Promise<{
  hasPassword: boolean;
  lastChangedAt: Date | null;
}> {
  const [user] = await db
    .select({
      passwordHash: users.passwordHash,
      passwordChangedAt: users.passwordChangedAt,
    })
    .from(users)
    .where(eq(users.id, userId));

  return {
    hasPassword: Boolean(user?.passwordHash),
    lastChangedAt: user?.passwordChangedAt ?? null,
  };
}
```

---

### Phase C: Self-Service Password Change Page (C1–C2)

#### C1. Create `src/app/(app)/profile/page.tsx`

```tsx
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getPasswordInfo } from '@/server/actions/password';
import { ProfileClient } from './ProfileClient';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const userId = session.user.id!;
  const fullName = (session.user as any).fullName ?? session.user.name ?? '';
  const email = session.user.email ?? '';
  const role = (session.user as any).role ?? 'employee';

  const passwordInfo = await getPasswordInfo(userId);

  return (
    <ProfileClient
      userId={userId}
      fullName={fullName}
      email={email}
      role={role}
      passwordInfo={passwordInfo}
    />
  );
}
```

#### C2. Create `src/app/(app)/profile/ProfileClient.tsx`

```tsx
'use client';

import { useState, useTransition } from 'react';
import {
  Title,
  Paper,
  Stack,
  Group,
  Text,
  Badge,
  PasswordInput,
  Button,
  Alert,
  Divider,
} from '@mantine/core';
import { IconKey, IconCheck, IconAlertCircle, IconUser } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { changePassword } from '@/server/actions/password';
import dayjs from 'dayjs';

type Props = {
  userId: string;
  fullName: string;
  email: string;
  role: string;
  passwordInfo: {
    hasPassword: boolean;
    lastChangedAt: Date | null;
  };
};

const ROLE_COLORS: Record<string, string> = {
  admin: 'red',
  supervisor: 'blue',
  employee: 'green',
};

export function ProfileClient({ userId, fullName, email, role, passwordInfo }: Props) {
  const [isPending, startTransition] = useTransition();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function handleChangePassword() {
    setError(null);
    setSuccess(false);

    // Client-side validation
    if (!currentPassword) {
      setError('Please enter your current password.');
      return;
    }
    if (!newPassword) {
      setError('Please enter a new password.');
      return;
    }
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }

    startTransition(async () => {
      const result = await changePassword({
        userId,
        currentPassword,
        newPassword,
      });

      if (result.success) {
        setSuccess(true);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        notifications.show({
          title: 'Password Changed',
          message: 'Your password has been updated successfully.',
          color: 'green',
          icon: <IconCheck size={16} />,
        });
      } else {
        setError(result.error ?? 'Failed to change password.');
      }
    });
  }

  return (
    <>
      <Title order={2} mb="lg">My Profile</Title>

      {/* User Info Card */}
      <Paper withBorder p="lg" radius="md" mb="xl">
        <Group>
          <IconUser size={24} />
          <div>
            <Text fw={600} size="lg">{fullName}</Text>
            <Text size="sm" c="dimmed">{email}</Text>
          </div>
          <Badge color={ROLE_COLORS[role] ?? 'gray'} variant="light" size="lg" ml="auto">
            {role.charAt(0).toUpperCase() + role.slice(1)}
          </Badge>
        </Group>
      </Paper>

      {/* Password Change Section */}
      <Paper withBorder p="lg" radius="md">
        <Group mb="md">
          <IconKey size={20} />
          <Title order={4}>Change Password</Title>
        </Group>

        {passwordInfo.lastChangedAt && (
          <Text size="xs" c="dimmed" mb="md">
            Last changed: {dayjs(passwordInfo.lastChangedAt).format('MMM D, YYYY h:mm A')}
          </Text>
        )}

        {!passwordInfo.hasPassword && (
          <Alert icon={<IconAlertCircle size={16} />} color="yellow" variant="light" mb="md">
            Your account does not have a password set. Contact your administrator.
          </Alert>
        )}

        {success && (
          <Alert icon={<IconCheck size={16} />} color="green" variant="light" mb="md">
            Your password has been changed successfully.
          </Alert>
        )}

        {error && (
          <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light" mb="md">
            {error}
          </Alert>
        )}

        {passwordInfo.hasPassword && (
          <Stack gap="sm" maw={400}>
            <PasswordInput
              label="Current Password"
              placeholder="Enter your current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.currentTarget.value)}
              required
            />
            <Divider label="New Password" labelPosition="left" />
            <PasswordInput
              label="New Password"
              placeholder="Minimum 8 characters"
              value={newPassword}
              onChange={(e) => setNewPassword(e.currentTarget.value)}
              required
            />
            <PasswordInput
              label="Confirm New Password"
              placeholder="Re-enter new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.currentTarget.value)}
              required
              error={confirmPassword && newPassword !== confirmPassword ? 'Passwords do not match' : undefined}
            />
            <Button
              onClick={handleChangePassword}
              loading={isPending}
              disabled={!currentPassword || !newPassword || !confirmPassword}
              leftSection={<IconKey size={16} />}
              mt="sm"
            >
              Change Password
            </Button>
          </Stack>
        )}
      </Paper>
    </>
  );
}
```

---

### Phase D: Admin Password Reset (D1–D2)

#### D1. Modify `src/app/(app)/admin/users/UsersClient.tsx` — Add "Reset Password" action

**D1a.** Import the password reset function and add a modal for resetting passwords:

Add these imports:

```typescript
import { adminResetPassword } from '@/server/actions/password';
```

**D1b.** Add state for the reset password modal:

```typescript
const [resetModalOpen, setResetModalOpen] = useState(false);
const [resetTarget, setResetTarget] = useState<User | null>(null);
const [resetPassword, setResetPassword] = useState('');
const [resetError, setResetError] = useState<string | null>(null);
```

**D1c.** Add a handler for the password reset:

```typescript
function openResetModal(user: User) {
  setResetTarget(user);
  setResetPassword('');
  setResetError(null);
  setResetModalOpen(true);
}

function handleResetPassword() {
  if (!resetTarget || !resetPassword) return;
  startTransition(async () => {
    try {
      setResetError(null);
      const result = await adminResetPassword({
        targetUserId: resetTarget.id,
        newPassword: resetPassword,
        adminUserId: '', // Will be passed from props — see D2
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
```

**D1d.** Add a "Reset Password" button to the row actions. Update the `renderRowActions` to include both Edit and Reset Password buttons:

```tsx
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
  </Group>
),
```

Import `IconKey` from `@tabler/icons-react`.

**D1e.** Add the reset password modal JSX after the existing edit modal:

```tsx
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
```

Import `Alert` and `IconAlertCircle` if not already imported.

#### D2. Pass `currentUserId` to UsersClient

**D2a.** Modify `src/app/(app)/admin/users/page.tsx` to pass the current user's ID:

Add `currentUserId={session.user.id!}` to the props passed to `UsersClient`.

**D2b.** Update `UsersClient` Props to accept `currentUserId`:

```typescript
type Props = {
  initialUsers: User[];
  currentUserId: string;
};
```

Then use `currentUserId` in the `handleResetPassword` function:

```typescript
const result = await adminResetPassword({
  targetUserId: resetTarget.id,
  newPassword: resetPassword,
  adminUserId: currentUserId,
});
```

---

### Phase E: Header Profile Link (E1)

#### E1. Modify `src/components/shell/AppHeader.tsx` — Add "Change Password" menu item

In the `Menu.Dropdown`, add a "Change Password" item before the "Sign Out" item:

```tsx
<Menu.Item
  leftSection={<IconKey size={14} />}
  component="a"
  href="/profile"
>
  Change Password
</Menu.Item>
```

Import `IconKey` from `@tabler/icons-react`.

---

## 4. Verification

### 4a. Build & Schema Check

```bash
npx drizzle-kit push
npm run build
```

Must complete with **zero errors**.

### 4b. Self-Service Password Change Checks

| Check | Expected Result |
|---|---|
| **Visit /profile** | Shows user info card + password change form |
| **Change password with wrong current** | Error: "Current password is incorrect." |
| **Change password with mismatched new passwords** | Error: "Passwords do not match" (client-side) |
| **Change password with too-short new password** | Error: "Password must be at least 8 characters." |
| **Change password with same as current** | Error: "New password must be different from your current password." |
| **Successful password change** | Green success alert + notification toast |
| **Login with old password after change** | Fails — "Invalid email or password" |
| **Login with new password after change** | Succeeds |
| **Header menu** | Shows "Change Password" item that links to /profile |

### 4c. Admin Password Reset Checks

| Check | Expected Result |
|---|---|
| **User Management table** | Each row has Edit (pencil) + Reset Password (key) icons |
| **Click Reset Password icon** | Modal opens with user name/email and password field |
| **Reset with short password** | Error: "Password must be at least 8 characters." |
| **Successful reset** | Modal closes; green notification |
| **User logs in with new password** | Succeeds |
| **Non-admin tries to call adminResetPassword** | Server error: "Unauthorized" |

### 4d. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `column "password_changed_at" does not exist` | Schema not pushed | Run `npx drizzle-kit push` |
| `bcryptjs is not a function` | Wrong import | Verify `import bcrypt from 'bcryptjs'` (not `bcrypt`) |
| Password change succeeds but login fails | JWT session cached old credentials | Session token is valid until expiry; this is expected behavior |
| `adminResetPassword` fails with empty adminUserId | Not passed from page | Ensure `currentUserId` prop is passed from page.tsx |
| Profile page not accessible | Route not in `(app)` group | Verify file is at `src/app/(app)/profile/page.tsx` |
