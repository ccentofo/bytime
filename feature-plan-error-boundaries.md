# Blueprint: Error Boundaries — Graceful Crash Recovery for All Routes

## 1. Architectural Overview

### The Problem

If any React component throws an error during rendering (e.g., undefined property access, bad data shape from server, MRT column mismatch), the entire page goes blank. Next.js App Router supports `error.tsx` files that act as error boundaries for route segments, but none are implemented.

### The Solution

Add `error.tsx` files at strategic route levels:

1. **`src/app/(app)/error.tsx`** — Catches errors in all authenticated routes (timesheet + admin)
2. **`src/app/(app)/timesheet/error.tsx`** — Timesheet-specific error with "try refreshing" guidance
3. **`src/app/(app)/admin/error.tsx`** — Admin-specific error boundary
4. **`src/app/error.tsx`** — Root-level catch-all (catches errors in login page, etc.)
5. **`src/app/global-error.tsx`** — Global error boundary (catches errors in root layout itself)

Each error boundary shows a friendly UI with:
- What went wrong (generic message — no stack traces)
- A "Try Again" button that calls `reset()` (Next.js retry mechanism)
- A "Go Home" link as fallback
- The error is logged to console for developer debugging

### Key Next.js Rules

- `error.tsx` must be a **Client Component** (`'use client'`)
- It receives `{ error, reset }` props
- `error` is the Error object (with `message` and optional `digest`)
- `reset()` re-renders the route segment
- `global-error.tsx` wraps the **entire** app including the root layout — it must render its own `<html>` and `<body>`

---

## 2. File Topology

```
Files to CREATE:
├── src/app/error.tsx                                ← Root-level error boundary
├── src/app/global-error.tsx                         ← Global error boundary (root layout failures)
├── src/app/(app)/error.tsx                          ← App shell error boundary
├── src/app/(app)/timesheet/error.tsx                ← Timesheet-specific error boundary
├── src/app/(app)/admin/error.tsx                    ← Admin-specific error boundary

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── All existing files                               ← ❌ DO NOT MODIFY any existing files
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** modify any existing files.
> - All error boundary files must have `'use client'` directive.
> - Use **Mantine v9** components only for the error UI.
> - **DO NOT** expose error stack traces or internal details to users.
> - **After each phase, run `npm run build` to verify zero errors.**

---

### Phase A: Create Error Boundaries (A1–A5)

#### A1. Create `src/app/global-error.tsx` — Global fallback (root layout failures)

```tsx
'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error:', error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          fontFamily: 'system-ui, sans-serif',
          padding: '20px',
          textAlign: 'center',
        }}>
          <h1 style={{ fontSize: '24px', marginBottom: '8px' }}>Something went wrong</h1>
          <p style={{ color: '#666', marginBottom: '24px', maxWidth: '400px' }}>
            An unexpected error occurred. Please try again or contact your administrator if the problem persists.
          </p>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={reset}
              style={{
                padding: '10px 20px',
                backgroundColor: '#228be6',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              Try Again
            </button>
            <a
              href="/"
              style={{
                padding: '10px 20px',
                backgroundColor: '#e9ecef',
                color: '#333',
                borderRadius: '6px',
                textDecoration: 'none',
                fontSize: '14px',
              }}
            >
              Go Home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
```

**Note:** `global-error.tsx` cannot use Mantine components because it replaces the root layout (which provides MantineProvider). Use plain HTML/inline styles.

#### A2. Create `src/app/error.tsx` — Root-level error boundary

```tsx
'use client';

import { useEffect } from 'react';
import { Center, Stack, Title, Text, Button, Group, Paper } from '@mantine/core';
import { IconAlertTriangle, IconRefresh, IconHome } from '@tabler/icons-react';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Root error:', error);
  }, [error]);

  return (
    <Center mih="100vh" p="xl">
      <Paper shadow="md" p="xl" radius="md" w={480} withBorder>
        <Stack align="center" gap="md">
          <IconAlertTriangle size={48} color="var(--mantine-color-red-6)" />
          <Title order={2} ta="center">Something Went Wrong</Title>
          <Text c="dimmed" ta="center" size="sm">
            An unexpected error occurred. This has been logged for review.
            Please try again or return to the home page.
          </Text>
          <Group mt="md">
            <Button
              leftSection={<IconRefresh size={16} />}
              onClick={reset}
              variant="filled"
            >
              Try Again
            </Button>
            <Button
              leftSection={<IconHome size={16} />}
              component="a"
              href="/"
              variant="default"
            >
              Go Home
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Center>
  );
}
```

#### A3. Create `src/app/(app)/error.tsx` — App shell error boundary

```tsx
'use client';

import { useEffect } from 'react';
import { Container, Stack, Title, Text, Button, Group, Alert } from '@mantine/core';
import { IconAlertTriangle, IconRefresh, IconClock } from '@tabler/icons-react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('App error:', error);
  }, [error]);

  return (
    <Container size="sm" py="xl">
      <Stack align="center" gap="lg">
        <Alert
          icon={<IconAlertTriangle size={24} />}
          title="Something went wrong"
          color="red"
          variant="light"
          w="100%"
        >
          <Text size="sm">
            An error occurred while loading this page. This may be a temporary issue.
            Try refreshing the page, or navigate back to your timesheet.
          </Text>
        </Alert>
        <Group>
          <Button
            leftSection={<IconRefresh size={16} />}
            onClick={reset}
          >
            Try Again
          </Button>
          <Button
            leftSection={<IconClock size={16} />}
            component="a"
            href="/timesheet"
            variant="default"
          >
            Go to Timesheet
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}
```

#### A4. Create `src/app/(app)/timesheet/error.tsx` — Timesheet-specific

```tsx
'use client';

import { useEffect } from 'react';
import { Container, Stack, Title, Text, Button, Group, Alert, Paper } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';

export default function TimesheetError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Timesheet error:', error);
  }, [error]);

  // Check for common timesheet-specific errors
  const isNetworkError = error.message?.includes('fetch') || error.message?.includes('network');
  const isAuthError = error.message?.includes('Unauthorized') || error.message?.includes('session');

  return (
    <Container size="sm" py="xl">
      <Paper shadow="sm" p="xl" radius="md" withBorder>
        <Stack align="center" gap="md">
          <IconAlertTriangle size={48} color="var(--mantine-color-orange-6)" />
          <Title order={3} ta="center">Timesheet Error</Title>
          <Text c="dimmed" ta="center" size="sm">
            {isNetworkError
              ? 'Unable to connect to the server. Check your internet connection and try again. Your offline data is preserved.'
              : isAuthError
              ? 'Your session may have expired. Please try again or sign in.'
              : 'An error occurred while loading your timesheet. Your data is safe — please try refreshing.'}
          </Text>
          <Alert color="blue" variant="light" w="100%">
            <Text size="xs">
              💡 If you were working offline, your unsaved entries are stored locally
              and will sync when the connection is restored.
            </Text>
          </Alert>
          <Group mt="sm">
            <Button
              leftSection={<IconRefresh size={16} />}
              onClick={reset}
            >
              Reload Timesheet
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Container>
  );
}
```

#### A5. Create `src/app/(app)/admin/error.tsx` — Admin-specific

```tsx
'use client';

import { useEffect } from 'react';
import { Container, Stack, Title, Text, Button, Group, Alert } from '@mantine/core';
import { IconAlertTriangle, IconRefresh, IconClock } from '@tabler/icons-react';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Admin error:', error);
  }, [error]);

  const isForbidden = error.message?.includes('Forbidden') || error.message?.includes('Admin or Supervisor');

  return (
    <Container size="sm" py="xl">
      <Stack align="center" gap="lg">
        <Alert
          icon={<IconAlertTriangle size={24} />}
          title={isForbidden ? 'Access Denied' : 'Admin Page Error'}
          color={isForbidden ? 'orange' : 'red'}
          variant="light"
          w="100%"
        >
          <Text size="sm">
            {isForbidden
              ? 'You do not have permission to access this page. Only administrators and supervisors can view admin pages.'
              : 'An error occurred while loading this admin page. Please try again.'}
          </Text>
        </Alert>
        <Group>
          <Button
            leftSection={<IconRefresh size={16} />}
            onClick={reset}
          >
            Try Again
          </Button>
          <Button
            leftSection={<IconClock size={16} />}
            component="a"
            href="/timesheet"
            variant="default"
          >
            Go to Timesheet
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}
```

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

### 4b. Error Boundary Checks

To test, temporarily add `throw new Error('Test error')` to a component:

| Check | Expected Result |
|---|---|
| Error in timesheet page component | Timesheet error boundary shows with offline data reassurance |
| Error in admin page component | Admin error boundary shows with "Try Again" |
| Error in login page | Root error boundary shows with "Go Home" |
| Network error on timesheet load | Timesheet error boundary shows network-specific message |
| Forbidden error on admin page | Admin error boundary shows "Access Denied" |

### 4c. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| Error boundary not catching | Error thrown in event handler (not render) | Error boundaries only catch render errors. Event handler errors need try/catch. |
| Mantine components unstyled in `global-error` | MantineProvider not available | `global-error.tsx` uses inline styles (no Mantine) |
| `reset()` doesn't work | Server component data stale | `reset()` re-renders the client tree but doesn't re-fetch server data. Users may need to navigate away and back. |
