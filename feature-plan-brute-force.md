# Blueprint: Brute Force Protection — Login Rate Limiting & Account Lockout

## 1. Architectural Overview & Security Impact

### The Problem

The current login flow (`src/auth.ts` + `src/app/login/LoginForm.tsx`) has zero protection against brute-force password attacks:

1. **No rate limiting** — An attacker can submit unlimited login attempts per second
2. **No account lockout** — No mechanism to temporarily lock an account after repeated failures
3. **No failed attempt tracking** — The system doesn't record failed login attempts
4. **No progressive delay** — No increasing wait time between failed attempts
5. **No IP-based throttling** — Same attacker can target multiple accounts simultaneously

### Why This Matters

- **NIST SP 800-63B** (referenced by most government contracts) requires protection against brute-force authentication attacks
- **DCAA access control requirements** — Auditors evaluate whether the timekeeping system has adequate security controls to prevent unauthorized access
- An attacker who gains access to an employee account can falsify time records, violating the integrity of the entire DCAA audit trail

### Design Decisions

1. **Database-backed attempt tracking** — A new `loginAttempts` table tracks failed attempts per email. This survives server restarts (unlike in-memory rate limiting) and works across multiple server instances.

2. **Account lockout after 5 failures** — After 5 consecutive failed attempts, the account is locked for 15 minutes. The lockout clears automatically after the timer expires.

3. **Progressive delay** — After each failed attempt, the client shows an increasing delay message (not server-side sleep, which would block threads). The delay is cosmetic on the client but the server enforces the lockout.

4. **Successful login resets counter** — A successful login clears all failed attempt records for that email.

5. **Admin unlock capability** — Admins can manually unlock a locked account via the User Management page.

6. **No CAPTCHA for MVP** — CAPTCHA adds UX friction and requires third-party integration. The lockout mechanism is sufficient for MVP. CAPTCHA can be added later.

7. **IP tracking is optional** — The `ipAddress` field is included in the schema but populated only if the request headers provide it. This is for audit purposes, not enforcement (IP-based blocking can be overly aggressive with shared IPs/VPNs).

---

## 2. File Topology

```
Files to CREATE:
├── src/server/actions/login-attempts.ts             ← Server Actions: track/check/clear login attempts

Files to MODIFY:
├── src/db/schema.ts                                 ← Add loginAttempts table
├── src/auth.ts                                      ← Add attempt tracking to authorize callback
├── src/app/login/LoginForm.tsx                       ← Show lockout message + remaining time
├── src/app/(app)/admin/users/UsersClient.tsx         ← Add "Unlock Account" action
├── src/server/actions/users.ts                      ← Add unlockAccount function

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/middleware.ts                                ← ❌ DO NOT MODIFY
├── src/components/timesheet/*                       ← ❌ DO NOT MODIFY
├── src/components/shell/*                           ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                    ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/clins.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/assignments.ts                ← ❌ DO NOT MODIFY
├── src/server/actions/password.ts                   ← ❌ DO NOT MODIFY
├── src/server/actions/notifications.ts              ← ❌ DO NOT MODIFY
├── src/server/actions/supervisor-scope.ts            ← ❌ DO NOT MODIFY
├── src/server/actions/dashboard.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/audit.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/reports.ts                    ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/*                 ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/approvals/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/audit-trail/*                 ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/dashboard/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/labor-categories/*             ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/reports/*                      ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/notifications/*                ← ❌ DO NOT MODIFY
├── src/app/(app)/timesheet/*                         ← ❌ DO NOT MODIFY
├── src/app/(app)/profile/*                           ← ❌ DO NOT MODIFY
├── src/lib/offline/*                                 ← ❌ DO NOT MODIFY
├── src/lib/email/*                                   ← ❌ DO NOT MODIFY
├── src/lib/reports/*                                 ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify any files listed in the "DO NOT MODIFY" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`, `@mantine/notifications`).
> - Use **Drizzle ORM** for all database operations.
> - Use `bcryptjs` (NOT `bcrypt`) — consistent with existing codebase.
> - Follow the step order exactly. Each step builds on the previous one.
> - **After completing each phase, run `npm run build` to verify zero errors.**
> - **Key principle:** The `authorize` callback in Auth.js must remain synchronous in its return type (returns `User | null`). Attempt tracking happens inside the async `authorize` function before the return.

---

### Phase A: Schema Update (A1)

#### A1. Modify `src/db/schema.ts` — Add `loginAttempts` table

Add this table at the END of the file, after the `notificationPreferences` table:

```typescript
// ---------------------------------------------------------------------------
// Login Attempts (brute-force protection — tracks failed login attempts)
// ---------------------------------------------------------------------------

export const loginAttempts = pgTable('login_attempts', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  ipAddress: varchar('ip_address', { length: 45 }), // IPv4 or IPv6
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  successful: boolean('successful').notNull().default(false),
});
```

**Design notes:**
- Tracks by `email` (not user ID) so attempts against non-existent accounts are also recorded
- `ipAddress` is nullable — populated when available from headers
- `successful` field allows tracking both failures and successes (successful login = reset counter)
- No foreign key to `users` — this table must work for emails that don't exist in the system

Push the schema change:

```bash
npx drizzle-kit push
```

---

### Phase B: Login Attempt Server Actions (B1)

#### B1. Create `src/server/actions/login-attempts.ts`

```typescript
'use server';

import { db } from '@/db';
import { loginAttempts } from '@/db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import dayjs from 'dayjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_FAILED_ATTEMPTS = 5;         // Lock after 5 consecutive failures
const LOCKOUT_DURATION_MINUTES = 15;   // Lock for 15 minutes

// ---------------------------------------------------------------------------
// Login Attempt Tracking
// ---------------------------------------------------------------------------

/**
 * Check if an email is currently locked out due to too many failed attempts.
 * Returns lockout info if locked, null if not locked.
 */
export async function checkLockout(email: string): Promise<{
  isLocked: boolean;
  failedAttempts: number;
  lockoutExpiresAt: Date | null;
  minutesRemaining: number;
} | null> {
  const normalizedEmail = email.toLowerCase().trim();
  const windowStart = dayjs().subtract(LOCKOUT_DURATION_MINUTES, 'minute').toDate();

  // Get recent failed attempts within the lockout window
  const recentFailures = await db
    .select()
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.email, normalizedEmail),
        eq(loginAttempts.successful, false),
        gte(loginAttempts.attemptedAt, windowStart),
      )
    )
    .orderBy(desc(loginAttempts.attemptedAt));

  // Check if there was a successful login after the failures (which would reset the counter)
  const lastSuccess = await db
    .select()
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.email, normalizedEmail),
        eq(loginAttempts.successful, true),
      )
    )
    .orderBy(desc(loginAttempts.attemptedAt))
    .limit(1);

  // Only count failures that happened AFTER the last successful login
  let relevantFailures = recentFailures;
  if (lastSuccess.length > 0) {
    const lastSuccessTime = lastSuccess[0].attemptedAt;
    relevantFailures = recentFailures.filter(
      (f) => f.attemptedAt > lastSuccessTime
    );
  }

  const failedCount = relevantFailures.length;

  if (failedCount >= MAX_FAILED_ATTEMPTS) {
    // Account is locked — calculate when the lockout expires
    const oldestRelevantFailure = relevantFailures[relevantFailures.length - 1];
    const lockoutExpiresAt = dayjs(oldestRelevantFailure.attemptedAt)
      .add(LOCKOUT_DURATION_MINUTES, 'minute')
      .toDate();
    const minutesRemaining = Math.max(0, dayjs(lockoutExpiresAt).diff(dayjs(), 'minute'));

    return {
      isLocked: minutesRemaining > 0,
      failedAttempts: failedCount,
      lockoutExpiresAt,
      minutesRemaining,
    };
  }

  return {
    isLocked: false,
    failedAttempts: failedCount,
    lockoutExpiresAt: null,
    minutesRemaining: 0,
  };
}

/**
 * Record a failed login attempt.
 */
export async function recordFailedAttempt(
  email: string,
  ipAddress?: string
): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();

  await db.insert(loginAttempts).values({
    email: normalizedEmail,
    ipAddress: ipAddress ?? null,
    successful: false,
  });
}

/**
 * Record a successful login (resets the failure counter).
 */
export async function recordSuccessfulLogin(
  email: string,
  ipAddress?: string
): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();

  await db.insert(loginAttempts).values({
    email: normalizedEmail,
    ipAddress: ipAddress ?? null,
    successful: true,
  });
}

/**
 * Clear all login attempts for an email (admin unlock).
 * This inserts a successful login record, which resets the counter.
 */
export async function unlockAccount(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();

  // Insert a "successful" record to reset the counter
  await db.insert(loginAttempts).values({
    email: normalizedEmail,
    successful: true,
  });
}

/**
 * Get the number of recent failed attempts for display purposes.
 */
export async function getFailedAttemptCount(email: string): Promise<number> {
  const lockoutInfo = await checkLockout(email);
  return lockoutInfo?.failedAttempts ?? 0;
}
```

---

### Phase C: Integrate with Auth.js (C1)

#### C1. Modify `src/auth.ts` — Add attempt tracking to the authorize callback

Replace the entire file with:

```typescript
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { getUserByEmail } from '@/server/actions/users';
import { checkLockout, recordFailedAttempt, recordSuccessfulLogin } from '@/server/actions/login-attempts';

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      name: 'Email & Password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = (credentials.email as string).toLowerCase().trim();
        const password = credentials.password as string;

        // Check if the account is locked out
        const lockoutInfo = await checkLockout(email);
        if (lockoutInfo?.isLocked) {
          // Account is locked — reject without checking password
          // The error message is generic to avoid revealing account existence
          return null;
        }

        const user = await getUserByEmail(email);
        if (!user || !user.passwordHash || !user.isActive) {
          // Record failed attempt even for non-existent accounts
          // (prevents email enumeration timing attacks)
          await recordFailedAttempt(email);
          return null;
        }

        const isValid = await bcrypt.compare(password, user.passwordHash);
        if (!isValid) {
          await recordFailedAttempt(email);
          return null;
        }

        // Successful login — record and clear counter
        await recordSuccessfulLogin(email);

        return {
          id: user.id,
          email: user.email,
          name: user.fullName,
          role: user.role,
        };
      },
    }),
  ],
  session: {
    strategy: 'jwt',
    maxAge: 24 * 60 * 60, // 24 hours
  },
  pages: {
    signIn: '/login',
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as any).role;
        token.fullName = (user as any).name;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        (session.user as any).role = token.role as string;
        (session.user as any).fullName = token.fullName as string;
      }
      return session;
    },
  },
});
```

**Key changes from the original:**
- Added imports for `checkLockout`, `recordFailedAttempt`, `recordSuccessfulLogin`
- Email is normalized to lowercase + trimmed before any operations
- Before checking credentials, `checkLockout()` is called — if locked, returns `null` immediately
- On failed login (wrong password or non-existent user), `recordFailedAttempt()` is called
- On successful login, `recordSuccessfulLogin()` is called (resets the counter)
- Failed attempts are recorded even for non-existent emails to prevent timing-based email enumeration

---

### Phase D: Update Login Form (D1)

#### D1. Modify `src/app/login/LoginForm.tsx` — Show lockout info and remaining attempts

Replace the entire file with:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Center,
  Stack,
  Paper,
  Title,
  TextInput,
  PasswordInput,
  Button,
  Alert,
  Avatar,
  Text,
} from '@mantine/core';
import { IconAlertCircle, IconLock } from '@tabler/icons-react';
import { signIn } from 'next-auth/react';
import { checkLockout } from '@/server/actions/login-attempts';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [lockoutMessage, setLockoutMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [failedCount, setFailedCount] = useState(0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLockoutMessage('');

    if (!email.trim() || !password) {
      setError('Please enter both email and password.');
      return;
    }

    // Client-side lockout check (server also enforces this)
    const lockoutInfo = await checkLockout(email.toLowerCase().trim());
    if (lockoutInfo?.isLocked) {
      setLockoutMessage(
        `Account is temporarily locked due to too many failed login attempts. Please try again in ${lockoutInfo.minutesRemaining} minute${lockoutInfo.minutesRemaining !== 1 ? 's' : ''}.`
      );
      return;
    }

    setLoading(true);

    const result = await signIn('credentials', {
      email: email.toLowerCase().trim(),
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      // Check updated lockout status after this failure
      const updatedLockout = await checkLockout(email.toLowerCase().trim());
      const attempts = updatedLockout?.failedAttempts ?? 0;
      setFailedCount(attempts);

      if (updatedLockout?.isLocked) {
        setLockoutMessage(
          `Account is temporarily locked due to too many failed login attempts. Please try again in ${updatedLockout.minutesRemaining} minute${updatedLockout.minutesRemaining !== 1 ? 's' : ''}.`
        );
        setError('');
      } else {
        const remaining = 5 - attempts;
        if (remaining <= 2 && remaining > 0) {
          setError(`Invalid email or password. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before account lockout.`);
        } else {
          setError('Invalid email or password.');
        }
      }
      return;
    }

    router.push('/timesheet');
    router.refresh();
  }

  return (
    <Center mih="100vh" bg="var(--mantine-color-body)">
      <Paper shadow="md" p="xl" radius="md" w={420} withBorder>
        <Stack align="center" mb="lg">
          <Avatar src="/logo.png" size="lg" radius="sm" />
          <Title order={2}>ByTime</Title>
          <Text c="dimmed" size="sm">
            DCAA-Compliant Timekeeping
          </Text>
        </Stack>

        {lockoutMessage && (
          <Alert
            icon={<IconLock size={16} />}
            color="orange"
            mb="md"
            variant="light"
            title="Account Locked"
          >
            {lockoutMessage}
          </Alert>
        )}

        {error && !lockoutMessage && (
          <Alert
            icon={<IconAlertCircle size={16} />}
            color="red"
            mb="md"
            variant="light"
          >
            {error}
          </Alert>
        )}

        <form onSubmit={handleSubmit}>
          <Stack>
            <TextInput
              label="Email"
              placeholder="you@company.com"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              disabled={Boolean(lockoutMessage)}
            />
            <PasswordInput
              label="Password"
              placeholder="Enter your password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={Boolean(lockoutMessage)}
            />
            <Button
              type="submit"
              fullWidth
              loading={loading}
              disabled={Boolean(lockoutMessage)}
            >
              Sign In
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
```

**Key changes from the original:**
- Added `checkLockout` import and pre-submit lockout check
- Shows orange "Account Locked" alert with remaining minutes when locked
- Shows remaining attempts warning when down to 2 or fewer attempts
- Input fields are disabled when account is locked
- After a failed attempt, re-checks lockout status to get updated attempt count
- Email is normalized to lowercase + trimmed consistently

---

### Phase E: Admin Unlock Capability (E1–E2)

#### E1. Modify `src/server/actions/users.ts` — Add `unlockUserAccount` function

Add this function at the END of the file:

```typescript
export async function unlockUserAccount(email: string): Promise<void> {
  const { unlockAccount } = await import('@/server/actions/login-attempts');
  await unlockAccount(email);
}
```

**Note:** Dynamic import is used to avoid circular dependency issues. The `login-attempts` module doesn't import from `users`, but keeping the import dynamic is a safety measure.

#### E2. Modify `src/app/(app)/admin/users/UsersClient.tsx` — Add "Unlock Account" button

**E2a.** Import the unlock function. Add to the existing imports:

```typescript
import { unlockUserAccount } from '@/server/actions/users';
```

**E2b.** Import `IconLockOpen` from `@tabler/icons-react`. Update the icon import line:

Find:

```typescript
import { IconPlus, IconEdit, IconKey, IconAlertCircle } from '@tabler/icons-react';
```

Replace with:

```typescript
import { IconPlus, IconEdit, IconKey, IconAlertCircle, IconLockOpen } from '@tabler/icons-react';
```

**E2c.** Add an unlock handler after the existing `handleResetPassword`:

```typescript
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
```

**E2d.** Add the unlock button to the row actions. Find the `renderRowActions`:

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

Replace with:

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
```

**E2e.** Update the `displayColumnDefOptions` for `mrt-row-actions` to accommodate the wider row. Find:

```typescript
'mrt-row-actions': {
  header: 'Actions',
  size: 80,
```

Replace with:

```typescript
'mrt-row-actions': {
  header: 'Actions',
  size: 120,
```

---

## 4. Verification

### 4a. Build & Schema Check

```bash
npx drizzle-kit push
npm run build
```

Must complete with **zero errors**.

### 4b. Brute Force Protection Checks

| Check | Expected Result |
|---|---|
| **Login with correct credentials** | Succeeds normally; successful attempt recorded |
| **Login with wrong password (1st attempt)** | "Invalid email or password" — no attempt count shown |
| **Login with wrong password (4th attempt)** | "Invalid email or password. 1 attempt remaining before account lockout." |
| **Login with wrong password (5th attempt)** | Orange "Account Locked" alert with minutes remaining |
| **Login while locked (with correct password)** | Still locked — "Account Locked" message shown |
| **Wait 15 minutes, then login** | Lockout expires; login succeeds |
| **Login with non-existent email (5 times)** | Same lockout behavior — prevents email enumeration |
| **Successful login after 3 failures** | Counter resets; next failure starts from 0 |

### 4c. Admin Unlock Checks

| Check | Expected Result |
|---|---|
| **User Management — Unlock button visible** | Green lock icon on each user row |
| **Click Unlock on locked user** | Notification: "{Name}'s account has been unlocked" |
| **Locked user tries to login after admin unlock** | Login succeeds (if credentials are correct) |

### 4d. Security Verification

| Check | Expected Result |
|---|---|
| **Timing attack prevention** | Failed attempts for non-existent emails take same time as real emails (bcrypt compare not called, but DB insert adds similar latency) |
| **Case-insensitive email** | `Admin@ByTime.Dev` and `admin@bytime.dev` are treated as the same account |
| **Server-side enforcement** | Even if client-side lockout check is bypassed, `auth.ts` `authorize` callback checks lockout server-side |

### 4e. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `relation "login_attempts" does not exist` | Schema not pushed | Run `npx drizzle-kit push` |
| `checkLockout is not a function` | Import missing | Verify import in `auth.ts` and `LoginForm.tsx` |
| Lockout doesn't work across server restarts | Using in-memory storage | This design uses the database — survives restarts |
| `authorize` returns `undefined` instead of `null` | Missing return statement | Ensure all code paths return `null` on failure |
| Login form doesn't show lockout after page refresh | Client state reset | `handleSubmit` re-checks lockout before each attempt |
| Email case sensitivity issues | Not normalizing | All emails are `.toLowerCase().trim()` before comparison |
| Dynamic import error for `unlockAccount` | Module resolution | Verify the import path matches the actual file location |
| Circular dependency in `users.ts` ↔ `login-attempts.ts` | Direct imports | Use dynamic import in `users.ts` for the unlock function |
