# Blueprint: Session Invalidation — Immediate Revocation on Role/Password/Status Changes

## 1. Architectural Overview & Security Impact

### The Problem

The application uses JWT-based sessions with a 24-hour expiry (`src/auth.ts` → `session.maxAge: 24 * 60 * 60`). JWTs are stateless — once issued, they cannot be revoked. This creates three security gaps:

1. **Deactivated users retain access** — When an admin sets `isActive = false` on a user, their existing JWT session remains valid for up to 24 hours. The deactivated user can continue entering time, accessing admin pages, etc.

2. **Role changes are not reflected** — When an admin changes a user's role (e.g., employee → supervisor), the user's JWT still contains the old role. They must log out and back in for the new role to take effect. Worse, if a supervisor is downgraded to employee, they retain admin access until JWT expires.

3. **Password resets don't invalidate sessions** — After an admin resets a user's password (possibly due to a compromised account), existing sessions remain valid. The compromised session continues to work.

### Design: Session Version Token

The solution adds a lightweight **session version** mechanism:

1. A `sessionVersion` integer column is added to the `users` table (default: `1`)
2. When a user's role, password, or active status changes, `sessionVersion` is incremented
3. The JWT includes the `sessionVersion` at sign-in time
4. On every request, the middleware (or JWT callback) compares the JWT's `sessionVersion` with the database's current value
5. If they don't match, the session is invalidated — the user is forced to re-authenticate

### Why This Approach

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| **Session version (chosen)** | Simple, 1 DB query per request, no new tables | Adds ~5ms per request (DB lookup) | ✅ Chosen |
| **Token blacklist table** | Precise per-token revocation | Requires tracking every token, grows indefinitely | ❌ Overkill |
| **Short JWT expiry (5 min)** | Quick invalidation | Poor UX — frequent re-auth, breaks offline | ❌ Too aggressive |
| **Server-side sessions (DB)** | Full control | Eliminates JWT benefits, requires session store | ❌ Architectural change |

The session version approach is the **minimum viable change** — one new column, one check per request, zero new tables.

### Performance Consideration

The JWT callback runs on every request. Adding a DB query per request is the main cost. To mitigate:
- The query is a simple `SELECT sessionVersion FROM users WHERE id = $1` (indexed by primary key)
- This is ~2-5ms per request on a local PostgreSQL instance
- For production, this could be cached in Redis with a short TTL (future optimization)

---

## 2. File Topology

```
Files to MODIFY:
├── src/db/schema.ts                                 ← Add sessionVersion column to users table
├── src/auth.ts                                      ← Check sessionVersion in JWT callback; include in token
├── src/server/actions/users.ts                      ← Increment sessionVersion on role/status changes
├── src/server/actions/password.ts                   ← Increment sessionVersion on password change/reset

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/middleware.ts                                ← ❌ DO NOT MODIFY
├── src/components/timesheet/*                       ← ❌ DO NOT MODIFY
├── src/components/shell/*                           ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                    ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/clins.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/assignments.ts                ← ❌ DO NOT MODIFY
├── src/server/actions/notifications.ts              ← ❌ DO NOT MODIFY
├── src/server/actions/supervisor-scope.ts            ← ❌ DO NOT MODIFY
├── src/server/actions/dashboard.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/audit.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/reports.ts                    ← ❌ DO NOT MODIFY
├── src/server/actions/login-attempts.ts              ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/*                             ← ❌ DO NOT MODIFY
├── src/app/(app)/timesheet/*                         ← ❌ DO NOT MODIFY
├── src/app/(app)/profile/*                           ← ❌ DO NOT MODIFY
├── src/app/login/*                                   ← ❌ DO NOT MODIFY
├── src/lib/*                                         ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify any files listed in the "DO NOT MODIFY" section above.
> - Use **Drizzle ORM** for all database operations.
> - Follow the step order exactly. Each step builds on the previous one.
> - **After completing each phase, run `npm run build` to verify zero errors.**
> - **Key principle:** The JWT callback's `sessionVersion` check must NOT break existing sessions during deployment. The default value of `1` ensures existing JWTs (which won't have `sessionVersion`) gracefully initialize.
> - **Critical:** The `jwt` callback in Auth.js runs on EVERY request. The DB query must be fast and handle errors gracefully (never crash the request pipeline).

---

### Phase A: Schema Update (A1)

#### A1. Modify `src/db/schema.ts` — Add `sessionVersion` column to users table

Add this column after the `flsaExempt` column (or after `passwordChangedAt` if the overtime blueprint hasn't been implemented yet) and before `createdAt`:

```typescript
sessionVersion: integer('session_version').notNull().default(1),
```

**Important:** Use `integer` (already imported at the top of the schema file). The default value of `1` ensures existing users get version 1 without a data migration.

Push the schema change:

```bash
npx drizzle-kit push
```

---

### Phase B: Update Auth.js JWT Callback (B1)

#### B1. Modify `src/auth.ts` — Add sessionVersion to JWT and validate on every request

**B1a.** Add the database import at the top of the file. Find the existing imports and add:

```typescript
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
```

**B1b.** Update the `jwt` callback to include `sessionVersion` on sign-in AND validate it on subsequent requests.

Find the existing `jwt` callback:

```typescript
async jwt({ token, user }) {
  if (user) {
    token.id = user.id;
    token.role = (user as any).role;
    token.fullName = (user as any).name;
  }
  return token;
},
```

Replace with:

```typescript
async jwt({ token, user }) {
  // On initial sign-in, copy user fields to the JWT
  if (user) {
    token.id = user.id;
    token.role = (user as any).role;
    token.fullName = (user as any).name;

    // Fetch and store the current sessionVersion
    try {
      const [dbUser] = await db
        .select({ sessionVersion: users.sessionVersion })
        .from(users)
        .where(eq(users.id, user.id as string));
      token.sessionVersion = dbUser?.sessionVersion ?? 1;
    } catch {
      token.sessionVersion = 1;
    }
  }

  // On every subsequent request, validate the sessionVersion
  if (token.id && !user) {
    try {
      const [dbUser] = await db
        .select({
          sessionVersion: users.sessionVersion,
          isActive: users.isActive,
          role: users.role,
          fullName: users.fullName,
        })
        .from(users)
        .where(eq(users.id, token.id as string));

      if (!dbUser) {
        // User deleted — invalidate
        return { ...token, invalidated: true };
      }

      if (!dbUser.isActive) {
        // User deactivated — invalidate
        return { ...token, invalidated: true };
      }

      if (dbUser.sessionVersion !== (token.sessionVersion ?? 1)) {
        // Session version mismatch — invalidate
        return { ...token, invalidated: true };
      }

      // Keep role and name in sync with database (handles role changes gracefully)
      token.role = dbUser.role;
      token.fullName = dbUser.fullName;
    } catch (error) {
      // On DB error, allow the request to proceed (don't lock out users due to transient DB issues)
      console.error('Session validation error:', error);
    }
  }

  return token;
},
```

**B1c.** Update the `session` callback to handle invalidated sessions.

Find the existing `session` callback:

```typescript
async session({ session, token }) {
  if (session.user) {
    session.user.id = token.id as string;
    (session.user as any).role = token.role as string;
    (session.user as any).fullName = token.fullName as string;
  }
  return session;
},
```

Replace with:

```typescript
async session({ session, token }) {
  // If the session was invalidated, return a null-like session
  // that will trigger re-authentication
  if ((token as any).invalidated) {
    // Setting the user to a minimal object signals the client to re-authenticate
    // The middleware will redirect to login
    session.user = undefined as any;
    return session;
  }

  if (session.user) {
    session.user.id = token.id as string;
    (session.user as any).role = token.role as string;
    (session.user as any).fullName = token.fullName as string;
  }
  return session;
},
```

**Key design notes:**
- On initial sign-in (`if (user)`), the current `sessionVersion` is fetched from DB and stored in the JWT
- On every subsequent request (`if (token.id && !user)`), the DB version is checked against the JWT version
- If versions don't match, the token is flagged as `invalidated: true`
- The `session` callback detects the flag and nullifies the user, causing middleware to redirect to login
- DB errors are caught and logged — they don't lock out users (fail-open on transient errors)
- Role and fullName are refreshed from DB on every request, so admin changes take effect immediately

---

### Phase C: Increment Session Version on Changes (C1–C2)

#### C1. Modify `src/server/actions/users.ts` — Increment `sessionVersion` on role/status changes

**C1a.** Update the `updateUser` function to increment `sessionVersion` when role or isActive changes.

Find the existing `updateUser` function:

```typescript
export async function updateUser(id: string, data: {
  fullName?: string;
  email?: string;
  role?: 'admin' | 'supervisor' | 'employee';
  isActive?: boolean;
  flsaExempt?: boolean;
}) {
  const rows = await db.update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return rows[0];
}
```

Replace with:

```typescript
export async function updateUser(id: string, data: {
  fullName?: string;
  email?: string;
  role?: 'admin' | 'supervisor' | 'employee';
  isActive?: boolean;
  flsaExempt?: boolean;
}) {
  // Determine if this change should invalidate existing sessions
  const shouldInvalidateSession = data.role !== undefined || data.isActive !== undefined;

  const updateData: Record<string, unknown> = {
    ...data,
    updatedAt: new Date(),
  };

  if (shouldInvalidateSession) {
    // Increment sessionVersion to force re-authentication
    // Use a raw SQL increment to avoid race conditions
    const [currentUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, id));

    if (currentUser) {
      updateData.sessionVersion = currentUser.sessionVersion + 1;
    }
  }

  const rows = await db.update(users)
    .set(updateData)
    .where(eq(users.id, id))
    .returning();
  return rows[0];
}
```

**Note:** The `sessionVersion` is only incremented when `role` or `isActive` changes — not for `fullName` or `email` changes, which don't affect authorization.

#### C2. Modify `src/server/actions/password.ts` — Increment `sessionVersion` on password changes

**C2a.** Add the `users` schema import if not already complete. The file already imports `users` from `@/db/schema`.

**C2b.** In the `changePassword` function, after the successful password update, also increment `sessionVersion`.

Find the password update block:

```typescript
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
```

Replace with:

```typescript
// Hash and save new password + increment session version
const newHash = await bcrypt.hash(data.newPassword, 12);

// Get current session version
const [currentUser] = await db
  .select({ sessionVersion: users.sessionVersion })
  .from(users)
  .where(eq(users.id, data.userId));

await db.update(users)
  .set({
    passwordHash: newHash,
    passwordChangedAt: new Date(),
    updatedAt: new Date(),
    sessionVersion: (currentUser?.sessionVersion ?? 1) + 1,
  })
  .where(eq(users.id, data.userId));

return { success: true };
```

**C2c.** In the `adminResetPassword` function, do the same. Find the password update block:

```typescript
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
```

Replace with:

```typescript
// Hash and save new password + increment session version (invalidates all existing sessions)
const newHash = await bcrypt.hash(data.newPassword, 12);

// Get current session version
const [targetUser] = await db
  .select({ sessionVersion: users.sessionVersion })
  .from(users)
  .where(eq(users.id, data.targetUserId));

await db.update(users)
  .set({
    passwordHash: newHash,
    passwordChangedAt: new Date(),
    updatedAt: new Date(),
    sessionVersion: (targetUser?.sessionVersion ?? 1) + 1,
  })
  .where(eq(users.id, data.targetUserId));

return { success: true };
```

---

## 4. Verification

### 4a. Build & Schema Check

```bash
npx drizzle-kit push
npm run build
```

Must complete with **zero errors**.

### 4b. Session Invalidation Checks

**Setup:** Open two browser windows — one as admin, one as the test user.

| Check | Steps | Expected Result |
|---|---|---|
| **Deactivate user** | Admin toggles `isActive` off for Jane. Jane refreshes her page. | Jane is redirected to `/login` |
| **Change role (downgrade)** | Admin changes Sarah from supervisor to employee. Sarah navigates to `/admin/contracts`. | Sarah is redirected to `/login`. After re-login, admin links are hidden. |
| **Change role (upgrade)** | Admin changes John from employee to supervisor. John refreshes. | John is redirected to `/login`. After re-login, admin links appear. |
| **Admin password reset** | Admin resets Jane's password. Jane (still logged in) refreshes. | Jane is redirected to `/login`. Old password no longer works. |
| **Self password change** | Jane changes her own password via `/profile`. | Jane is redirected to `/login`. Must use new password. |
| **No-op changes** | Admin changes Jane's `fullName` only (no role/status/password change). | Jane's session continues working — NOT invalidated. Name updates on next request. |

### 4c. Graceful Degradation Checks

| Check | Expected Result |
|---|---|
| **Database temporarily down** | Users with existing valid sessions continue working (fail-open). Error logged to console. |
| **New user logs in for first time** | `sessionVersion = 1` is set in JWT. Works normally. |
| **Existing users (before migration)** | `sessionVersion` defaults to `1` in DB. JWT without `sessionVersion` defaults to `1`. No disruption. |

### 4d. Performance Verification

| Metric | Expected |
|---|---|
| **Added query per request** | `SELECT session_version, is_active, role, full_name FROM users WHERE id = $1` — ~2-5ms (PK index) |
| **Total added latency** | Negligible for most requests. Acceptable trade-off for security. |
| **No N+1 queries** | Single query per request, not per component/action. |

### 4e. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `column "session_version" does not exist` | Schema not pushed | Run `npx drizzle-kit push` |
| All users logged out after deployment | `sessionVersion` default doesn't match JWT | Both default to `1` — this should NOT happen. If it does, check that the `token.sessionVersion ?? 1` fallback is in place. |
| Infinite redirect loop | Session callback returns invalid session → middleware redirects → session callback runs again | The `session` callback sets `session.user = undefined` which causes middleware to redirect to `/login`. The `/login` route is NOT matched by middleware (verified in `src/middleware.ts` matcher). |
| `db` not defined in `auth.ts` | Import missing | Add `import { db } from '@/db'` and `import { users } from '@/db/schema'` |
| `integer` not imported in schema | Missing import | Already imported: `import { ..., integer } from 'drizzle-orm/pg-core'` (used by `timesheetEntries.revisionNumber`) |
| JWT grows too large | Adding sessionVersion (integer) | Only adds ~20 bytes to the JWT. Not a concern. |
| DB query fails on edge runtime | Drizzle not edge-compatible | The app uses Node.js runtime (not edge). Verify `next.config.ts` doesn't set edge runtime for middleware. The current `middleware.ts` uses `export { auth as middleware }` from Auth.js which runs in Node. |
| Race condition on sessionVersion increment | Two admin changes at the same time | Both increment — the second change will result in `version + 2`, which is fine. Both old sessions are invalidated. |
