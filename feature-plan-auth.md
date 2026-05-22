# Blueprint: Authentication & Role-Based Access Control (RBAC)

## 1. Architectural Overview & DCAA Impact

### Why Authentication is Critical

Per DCAA requirements, employees can ONLY view, access, and log time against Contracts and CLINs they are explicitly assigned to. The `user_assignments` table already enforces this at the data layer — but without authentication, there is no way to identify *which* user is accessing the system. Auth closes this gap.

### Session Strategy: JWT (Option A — MVP)

We use **Auth.js v5** (next-auth) with the **Credentials Provider** (email + password):

- **JWT-only sessions** — No database session table. The JWT payload includes `id`, `email`, `role`, and `fullName`.
- **Token lifetime:** 24 hours. After expiry, the user must re-login.
- **Password hashing:** `bcrypt` with a cost factor of 12.
- **Route protection:** Next.js `middleware.ts` redirects unauthenticated users to `/login`.
- **Role-based UI:** The navbar conditionally renders admin links based on the user's `role` from the JWT.

### Auth Flow

```
User visits /timesheet
  → middleware.ts checks for valid session token
  → No token? Redirect to /login
  → User enters email + password
  → Server Action validates credentials against users.password_hash
  → Auth.js creates JWT with { id, email, role, fullName }
  → JWT stored as HTTP-only cookie
  → User redirected to /timesheet
  → AppHeader shows user name + logout button
  → AppNavbar shows/hides admin links based on role
```

### Role Hierarchy

| Role | Timesheet Access | Admin Access | Description |
|---|---|---|---|
| `employee` | ✅ Own timesheet only | ❌ No admin pages | Standard time entry user |
| `supervisor` | ✅ Own timesheet + review | ✅ Full admin access | Reviews/approves timesheets |
| `admin` | ✅ Own timesheet | ✅ Full admin access | System administrator |

---

## 2. File Topology

```
Files to CREATE:
├── src/auth.ts                                     ← Auth.js configuration (providers, callbacks, JWT)
├── src/middleware.ts                                ← Route protection (redirect unauthenticated to /login)
├── src/app/login/
│   ├── page.tsx                                    ← Login page (Server Component)
│   └── LoginForm.tsx                               ← Login form (Client Component — Mantine)
├── src/lib/
│   └── session.ts                                  ← Helper to get typed session in Server Components/Actions

Files to MODIFY:
├── src/db/schema.ts                                ← Add passwordHash column to users table
├── src/server/actions/users.ts                     ← Update seedUsers with password hashes
├── src/components/shell/AppHeader.tsx               ← Add user display + logout button
├── src/components/shell/AppNavbar.tsx               ← Conditionally render admin links based on role
├── src/app/(app)/layout.tsx                         ← Pass session data to shell components
├── package.json                                     ← Add next-auth, @auth/drizzle-adapter (unused for now but peer), bcrypt

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/components/timesheet/BiWeeklyTable.tsx       ← ❌ DO NOT MODIFY
├── src/components/timesheet/TimesheetContext.tsx     ← ❌ DO NOT MODIFY
├── src/components/timesheet/PayPeriodSelector.tsx    ← ❌ DO NOT MODIFY
├── src/components/timesheet/DailyNoteModal.tsx       ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/*                  ← ❌ DO NOT MODIFY
├── src/data/mock-timesheet.ts                        ← ❌ DO NOT MODIFY
├── src/types/timesheet.ts                            ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/ContractsClient.tsx ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/AssignmentsClient.tsx ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                   ← ❌ DO NOT MODIFY
├── src/server/actions/clins.ts                       ← ❌ DO NOT MODIFY
├── src/server/actions/assignments.ts                 ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** read documentation files or search for library docs.
> - **DO NOT** modify any files listed in the "NOT TOUCHED" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`).
> - Use `@tabler/icons-react` for all icons.
> - Follow the step order exactly. Each step builds on the previous one.
> - After completing each step, pause and confirm with the user before continuing.

---

### Step 0: Install Dependencies

**0a.** Install Auth.js (next-auth v5) and bcrypt:

```bash
npm install next-auth@beta bcrypt
npm install -D @types/bcrypt
```

> **Note:** `next-auth@beta` is the v5 release line for Auth.js. It is the correct version for Next.js App Router.

---

### Step 1: Add Password Column to Users Schema

**1a.** Modify `src/db/schema.ts` — add a `passwordHash` column to the `users` table:

Add this column after the `isActive` column:

```typescript
passwordHash: varchar('password_hash', { length: 255 }),
```

The column is **nullable** because existing users in the database don't have passwords yet. The seed function will populate them.

The full `users` table definition should become:

```typescript
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  fullName: varchar('full_name', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull().default('employee'),
  isActive: boolean('is_active').notNull().default(true),
  passwordHash: varchar('password_hash', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

**1b.** Push the schema change to the database:

```bash
export DATABASE_URL=postgresql://bytime:bytime_dev@localhost:5432/bytime
npx drizzle-kit push
```

---

### Step 2: Update Seed Function with Password Hashes

**2a.** Modify `src/server/actions/users.ts` — update the `seedUsers` function to hash passwords and populate the `passwordHash` column:

Replace the entire file content with:

```typescript
'use server';

import { db } from '@/db';
import { users } from '@/db/schema';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';

export async function getUsers() {
  return db.select().from(users).orderBy(users.fullName);
}

export async function getUserByEmail(email: string) {
  const rows = await db.select().from(users).where(eq(users.email, email));
  return rows[0] ?? null;
}

export async function createUser(data: {
  email: string;
  fullName: string;
  role?: 'admin' | 'supervisor' | 'employee';
}) {
  const rows = await db.insert(users).values(data).returning();
  return rows[0];
}

export async function seedUsers() {
  // Hash the default dev password for all seed users
  const defaultPassword = 'Password123!';
  const hash = await bcrypt.hash(defaultPassword, 12);

  const seedData = [
    { email: 'admin@bytime.dev', fullName: 'Admin User', role: 'admin' as const, passwordHash: hash },
    { email: 'jane.smith@bytime.dev', fullName: 'Jane Smith', role: 'employee' as const, passwordHash: hash },
    { email: 'john.doe@bytime.dev', fullName: 'John Doe', role: 'employee' as const, passwordHash: hash },
    { email: 'sarah.wilson@bytime.dev', fullName: 'Sarah Wilson', role: 'supervisor' as const, passwordHash: hash },
  ];

  // Upsert: update password_hash for existing users, insert new ones
  const results = [];
  for (const user of seedData) {
    const existing = await db.select().from(users).where(eq(users.email, user.email));
    if (existing.length > 0) {
      const updated = await db.update(users)
        .set({ passwordHash: user.passwordHash })
        .where(eq(users.email, user.email))
        .returning();
      results.push(updated[0]);
    } else {
      const inserted = await db.insert(users).values(user).returning();
      results.push(inserted[0]);
    }
  }

  return results;
}
```

**Key changes:**
- Added `getUserByEmail` — needed by the auth layer to look up users during login.
- Added `bcrypt` import for password hashing.
- Added `eq` import from `drizzle-orm` for WHERE clauses.
- `seedUsers` now upserts: updates `passwordHash` for existing users, inserts new ones.
- Default dev password: `Password123!`

**2b.** After modifying the file, the seed must be re-run to populate password hashes for existing users. This will be done via a temporary API route in Step 6 or by the user directly.

---

### Step 3: Configure Auth.js

**3a.** Create `src/auth.ts` — the Auth.js configuration:

```typescript
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcrypt';
import { getUserByEmail } from '@/server/actions/users';

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

        const email = credentials.email as string;
        const password = credentials.password as string;

        const user = await getUserByEmail(email);
        if (!user || !user.passwordHash || !user.isActive) return null;

        const isValid = await bcrypt.compare(password, user.passwordHash);
        if (!isValid) return null;

        // Return the user object — this becomes the JWT payload via callbacks
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
      // On initial sign-in, copy user fields to the JWT
      if (user) {
        token.id = user.id;
        token.role = (user as any).role;
        token.fullName = (user as any).name;
      }
      return token;
    },
    async session({ session, token }) {
      // Expose custom fields on the session object
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

**Key details:**
- `Credentials` provider with email + password.
- `authorize` looks up the user by email, compares bcrypt hash, returns user object.
- JWT callbacks inject `id`, `role`, and `fullName` into the token and session.
- Custom sign-in page at `/login`.
- 24-hour JWT expiry.

**3b.** Create `src/app/api/auth/[...nextauth]/route.ts` — the Auth.js API route handler:

```typescript
import { handlers } from '@/auth';

export const { GET, POST } = handlers;
```

**3c.** Add the `AUTH_SECRET` environment variable to `.env.local`:

```bash
# Generate a random secret
npx auth secret
```

Or manually add to `.env.local`:

```env
AUTH_SECRET=your-random-secret-here-at-least-32-characters-long
```

The `AUTH_SECRET` must be set or Auth.js will throw an error at runtime.

---

### Step 4: Create the Session Helper

**4a.** Create `src/lib/session.ts` — a typed helper to get the current session in Server Components and Server Actions:

```typescript
import { auth } from '@/auth';

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
};

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user) return null;

  return {
    id: session.user.id as string,
    email: session.user.email as string,
    fullName: (session.user as any).fullName as string,
    role: (session.user as any).role as 'admin' | 'supervisor' | 'employee',
  };
}

export async function requireSession(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    throw new Error('Unauthorized: No active session');
  }
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireSession();
  if (user.role !== 'admin' && user.role !== 'supervisor') {
    throw new Error('Forbidden: Admin or Supervisor role required');
  }
  return user;
}
```

**Key details:**
- `getSessionUser()` — Returns typed user or null. Safe for conditional checks.
- `requireSession()` — Throws if not authenticated. Use in Server Actions.
- `requireAdmin()` — Throws if not admin/supervisor. Use in admin Server Actions.

---

### Step 5: Create Route Protection Middleware

**5a.** Create `src/middleware.ts` at the project root (NOT inside `src/app/`):

```typescript
export { auth as middleware } from '@/auth';

export const config = {
  matcher: [
    // Protect all (app) routes — timesheet and admin
    '/timesheet/:path*',
    '/admin/:path*',
  ],
};
```

**Key details:**
- Auth.js v5 exports `auth` as middleware-compatible. When no session exists, it automatically redirects to the `signIn` page configured in `src/auth.ts` (which is `/login`).
- The matcher protects `/timesheet/*` and `/admin/*`. The `/login` page is NOT matched, so it remains publicly accessible.
- The root `/` page (which redirects to `/timesheet`) will trigger the middleware check on `/timesheet`.

---

### Step 6: Create the Login Page

**6a.** Create `src/app/login/page.tsx` — Server Component wrapper:

```tsx
import { LoginForm } from './LoginForm';

export default function LoginPage() {
  return <LoginForm />;
}
```

**6b.** Create `src/app/login/LoginForm.tsx` — Client Component with Mantine form:

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
  Group,
  Text,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { signIn } from 'next-auth/react';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError('Invalid email or password');
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

        {error && (
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
            />
            <PasswordInput
              label="Password"
              placeholder="Enter your password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <Button type="submit" fullWidth loading={loading}>
              Sign In
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
```

**Key details:**
- Uses `signIn('credentials', { redirect: false })` from `next-auth/react` for client-side login.
- On success, redirects to `/timesheet` and calls `router.refresh()` to re-fetch session.
- Error state shows a red Alert for invalid credentials.
- Logo + branding centered above the form.
- Full Mantine styling — no custom CSS needed.

---

### Step 7: Update AppHeader with User Info & Logout

**7a.** Modify `src/components/shell/AppHeader.tsx` to accept the session user as a prop and display their name + a logout button:

Replace the entire file content with:

```tsx
'use client';

import { Group, Title, Avatar, ActionIcon, Text, Menu, UnstyledButton, useMantineColorScheme } from '@mantine/core';
import { IconSun, IconMoon, IconLogout, IconUser } from '@tabler/icons-react';
import { signOut } from 'next-auth/react';

type AppHeaderProps = {
  user?: {
    fullName: string;
    email: string;
    role: string;
  } | null;
};

export function AppHeader({ user }: AppHeaderProps) {
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();

  return (
    <Group h="100%" px="md" justify="space-between">
      <Group gap="sm">
        <Avatar src="/logo.png" size="md" radius="sm" />
        <Title order={3}>ByTime</Title>
      </Group>
      <Group gap="sm">
        <ActionIcon
          variant="subtle"
          size="lg"
          onClick={toggleColorScheme}
          aria-label="Toggle color scheme"
        >
          {colorScheme === 'dark' ? <IconSun size={20} /> : <IconMoon size={20} />}
        </ActionIcon>
        {user && (
          <Menu shadow="md" width={200} position="bottom-end">
            <Menu.Target>
              <UnstyledButton>
                <Group gap="xs">
                  <Avatar radius="xl" size="sm" color="blue">
                    {user.fullName.charAt(0)}
                  </Avatar>
                  <Text size="sm" fw={500}>
                    {user.fullName}
                  </Text>
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{user.email}</Menu.Label>
              <Menu.Label>Role: {user.role}</Menu.Label>
              <Menu.Divider />
              <Menu.Item
                color="red"
                leftSection={<IconLogout size={14} />}
                onClick={() => signOut({ callbackUrl: '/login' })}
              >
                Sign Out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
    </Group>
  );
}
```

**Key details:**
- Accepts `user` prop with `fullName`, `email`, `role`.
- User avatar shows first initial.
- Dropdown menu shows email, role, and a "Sign Out" button.
- `signOut({ callbackUrl: '/login' })` redirects to login after logout.

---

### Step 8: Update AppNavbar with Role-Based Links

**8a.** Modify `src/components/shell/AppNavbar.tsx` to accept the user's role and conditionally render admin links:

Replace the entire file content with:

```tsx
'use client';

import { Stack, NavLink, Divider, Text } from '@mantine/core';
import { IconClock, IconFileText, IconUsers } from '@tabler/icons-react';
import { usePathname } from 'next/navigation';

type AppNavbarProps = {
  userRole?: string | null;
};

export function AppNavbar({ userRole }: AppNavbarProps) {
  const pathname = usePathname();
  const isAdmin = userRole === 'admin' || userRole === 'supervisor';

  return (
    <Stack gap={0} pt="sm">
      {/* Employee Section */}
      <Text size="xs" fw={700} c="dimmed" px="md" mb={4}>
        TIMEKEEPING
      </Text>
      <NavLink
        label="My Timesheet"
        href="/timesheet"
        leftSection={<IconClock size={18} />}
        active={pathname === '/timesheet'}
      />

      {isAdmin && (
        <>
          <Divider my="sm" />

          {/* Admin Section */}
          <Text size="xs" fw={700} c="dimmed" px="md" mb={4}>
            ADMINISTRATION
          </Text>
          <NavLink
            label="Contracts & CLINs"
            href="/admin/contracts"
            leftSection={<IconFileText size={18} />}
            active={pathname === '/admin/contracts'}
          />
          <NavLink
            label="User Assignments"
            href="/admin/assignments"
            leftSection={<IconUsers size={18} />}
            active={pathname === '/admin/assignments'}
          />
        </>
      )}
    </Stack>
  );
}
```

**Key details:**
- Accepts `userRole` prop.
- Admin/supervisor users see the ADMINISTRATION section.
- Employees only see "My Timesheet".

---

### Step 9: Update AppShell Layout to Pass Session

**9a.** Modify `src/app/(app)/layout.tsx` to read the session and pass user data to the shell components.

Since this layout needs to read the session (a server-side operation) but also render the client-side `AppShell`, we need to split it. The layout itself becomes a **Server Component** that fetches the session, and the AppShell rendering moves into a client component.

Replace the entire file content of `src/app/(app)/layout.tsx` with:

```tsx
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { AppShellWrapper } from './AppShellWrapper';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session?.user) {
    redirect('/login');
  }

  const user = {
    fullName: (session.user as any).fullName ?? session.user.name ?? '',
    email: session.user.email ?? '',
    role: (session.user as any).role ?? 'employee',
  };

  return (
    <AppShellWrapper user={user}>
      {children}
    </AppShellWrapper>
  );
}
```

**9b.** Create `src/app/(app)/AppShellWrapper.tsx` — the client component that renders the AppShell:

```tsx
'use client';

import { AppShell } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { SessionProvider } from 'next-auth/react';
import { AppHeader } from '@/components/shell/AppHeader';
import { AppNavbar } from '@/components/shell/AppNavbar';

type Props = {
  user: {
    fullName: string;
    email: string;
    role: string;
  };
  children: React.ReactNode;
};

export function AppShellWrapper({ user, children }: Props) {
  const [opened, { toggle }] = useDisclosure();

  return (
    <SessionProvider>
      <AppShell
        header={{ height: 60 }}
        navbar={{ width: 250, breakpoint: 'sm', collapsed: { mobile: !opened } }}
        padding="md"
      >
        <AppShell.Header>
          <AppHeader user={user} />
        </AppShell.Header>
        <AppShell.Navbar p="xs">
          <AppNavbar userRole={user.role} />
        </AppShell.Navbar>
        <AppShell.Main>{children}</AppShell.Main>
      </AppShell>
    </SessionProvider>
  );
}
```

**Key details:**
- The layout is now a Server Component that fetches the session.
- If no session, it redirects to `/login`.
- The `AppShellWrapper` is a Client Component that wraps children with `SessionProvider` (needed for `signOut` to work in the header).
- User data is passed as props to `AppHeader` and `AppNavbar`.

---

### Step 10: Seed Passwords for Existing Users

After all code changes are in place, the existing users in the database need password hashes.

**10a.** Create a temporary API route at `src/app/api/seed/route.ts`:

```typescript
import { seedUsers } from '@/server/actions/users';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const result = await seedUsers();
    return NextResponse.json({ success: true, users: result.map(u => ({ email: u.email, fullName: u.fullName, role: u.role })) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
```

**10b.** Start the dev server and hit the seed endpoint:

```bash
npm run dev
# In another terminal or browser:
curl http://localhost:3000/api/seed
```

**10c.** Verify the response shows all 4 users with their roles.

**10d.** **DELETE** `src/app/api/seed/route.ts` after seeding. Do not leave public seed endpoints in the codebase.

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**.

### 4b. Auth Flow Checks

```bash
npm run dev
```

| Check | Expected Result |
|---|---|
| **Visit `/timesheet` while logged out** | Redirected to `/login` |
| **Visit `/admin/contracts` while logged out** | Redirected to `/login` |
| **Login page renders** | Centered card with logo, email/password fields, sign-in button |
| **Login with wrong password** | Red alert: "Invalid email or password" |
| **Login with `admin@bytime.dev` / `Password123!`** | Redirected to `/timesheet`; header shows "Admin User" with dropdown |
| **Admin user navbar** | Shows TIMEKEEPING section + ADMINISTRATION section |
| **Click "Sign Out"** | Redirected to `/login`; session cleared |
| **Login with `jane.smith@bytime.dev` / `Password123!`** | Redirected to `/timesheet`; header shows "Jane Smith" |
| **Employee user navbar** | Shows TIMEKEEPING section ONLY — no ADMINISTRATION links |
| **Employee visits `/admin/contracts` directly (type URL)** | Middleware redirects or page renders but admin nav is hidden (server-side role check is a future hardening step) |

### 4c. Regression Checks

| Check | Expected Result |
|---|---|
| **Timesheet renders** | Semi-monthly table with mock data still works after login |
| **Period navigation** | Left/right arrows still navigate periods |
| **Color scheme toggle** | Still works in the header |
| **Contracts page** | MRT table loads, add/edit/CLINs drawer all work (when logged in as admin) |
| **Assignments page** | Cascading selects, assign, deactivate all work (when logged in as admin) |

### 4d. Guardrail Verification

```bash
git diff --name-only
```

Must **NOT** include:
- `src/components/timesheet/BiWeeklyTable.tsx`
- `src/components/timesheet/TimesheetContext.tsx`
- `src/components/timesheet/PayPeriodSelector.tsx`
- `src/components/timesheet/DailyNoteModal.tsx`
- `src/components/timesheet/cells/*`
- `src/data/mock-timesheet.ts`
- `src/types/timesheet.ts`
- `src/server/actions/contracts.ts`
- `src/server/actions/clins.ts`
- `src/server/actions/assignments.ts`

### 4e. Test Credentials

| Email | Password | Role | Expected Nav |
|---|---|---|---|
| `admin@bytime.dev` | `Password123!` | admin | Timesheet + Admin |
| `sarah.wilson@bytime.dev` | `Password123!` | supervisor | Timesheet + Admin |
| `jane.smith@bytime.dev` | `Password123!` | employee | Timesheet only |
| `john.doe@bytime.dev` | `Password123!` | employee | Timesheet only |

### 4f. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `AUTH_SECRET is missing` | Environment variable not set | Add `AUTH_SECRET=...` to `.env.local` |
| `Module not found: next-auth` | Package not installed | Run `npm install next-auth@beta` |
| `bcrypt` build errors | Native module compilation | Ensure build tools are installed: `sudo apt-get install build-essential` |
| `Cannot read properties of undefined (reading 'user')` | Session is null | Check middleware is redirecting; verify `auth()` returns session |
| `NEXT_REDIRECT` error in console | Normal behavior | `redirect()` throws internally in Next.js — this is expected, not a bug |
| `signOut is not a function` | Missing `SessionProvider` | Verify `AppShellWrapper` wraps children with `<SessionProvider>` |
| Infinite redirect loop | Middleware matching `/login` | Verify middleware matcher does NOT include `/login` |
| `relation "users" has no column "password_hash"` | Schema not pushed | Run `npx drizzle-kit push` |
