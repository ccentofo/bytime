# Blueprint: Server-Side RBAC Enforcement — CLIN Authorization & Admin Action Protection

> **This ticket contains TWO phases. Complete Phase A fully before starting Phase B.**

## 1. Architectural Overview & DCAA Impact

### The Problem

The application has two critical RBAC enforcement gaps:

**Gap A — Timesheet Save Bypass:**
`saveTimesheetBatch()` and `saveTimesheetEntry()` in `src/server/actions/timesheet.ts` accept a `clinId` from the client and insert into `timesheetEntries` **without verifying that the user is assigned to that CLIN**. The UI only shows assigned charge codes, but the server action has no guard. A tampered request could submit hours to any CLIN.

**Gap B — Admin Action Bypass:**
Admin server actions (`createContract`, `updateContract`, `assignUserToClin`, `createLaborCategory`, `createUserWithPassword`, `updateUser`, etc.) perform database mutations without checking the caller's role. While admin pages have session/role checks in their `page.tsx` files, the server actions themselves are exposed as HTTP endpoints and can be called by any authenticated user — including employees.

### DCAA Compliance Requirements

| Requirement | Reference | Gap |
|---|---|---|
| Employees can ONLY log time against authorized CLINs | FAR 31.201-1, CONTEXT.md | Gap A |
| Only authorized personnel can manage WBS data | Access Control best practices | Gap B |
| Audit trail integrity | CAS 418 | Both — unauthorized changes undermine the entire audit trail |

### Design Decisions

1. **CLIN validation on every save** — Before inserting a timesheet entry, query `user_assignments` to confirm the user has an active assignment. This is a simple SELECT + existence check.

2. **`requireAdmin()` on every admin action** — Use the existing `requireAdmin()` helper from `src/lib/session.ts` which throws if the session user is not admin/supervisor.

3. **No performance concern** — The CLIN check is a single indexed query (`user_clin_unique_idx`). The admin check uses the existing `auth()` session lookup which is already happening on the page level.

4. **Fail-secure** — If the check fails, throw an error. The client will show the error via the existing notification system.

---

## 2. File Topology

```
Files to MODIFY:
├── src/server/actions/timesheet.ts                  ← Add CLIN assignment validation to saveTimesheetBatch + saveTimesheetEntry
├── src/server/actions/contracts.ts                   ← Add requireAdmin() to all mutations
├── src/server/actions/clins.ts                       ← Add requireAdmin() to all mutations
├── src/server/actions/slins.ts                       ← Add requireAdmin() to all mutations
├── src/server/actions/assignments.ts                 ← Add requireAdmin() to all mutations
├── src/server/actions/labor-categories.ts            ← Add requireAdmin() to all mutations
├── src/server/actions/users.ts                       ← Add requireAdmin() to mutations (not reads)

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                                 ← ❌ DO NOT MODIFY
├── src/auth.ts                                      ← ❌ DO NOT MODIFY
├── src/middleware.ts                                ← ❌ DO NOT MODIFY
├── src/lib/session.ts                               ← ❌ DO NOT MODIFY (requireAdmin already exists)
├── src/components/**                                ← ❌ DO NOT MODIFY
├── src/app/**                                       ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                    ← ❌ DO NOT MODIFY (already has scope checks)
├── src/server/actions/password.ts                   ← ❌ DO NOT MODIFY (already has role checks)
├── src/server/actions/dashboard.ts                  ← ❌ DO NOT MODIFY (read-only)
├── src/server/actions/audit.ts                      ← ❌ DO NOT MODIFY (read-only)
├── src/server/actions/reports.ts                    ← ❌ DO NOT MODIFY (read-only, has auth checks in API routes)
├── src/server/actions/notifications.ts              ← ❌ DO NOT MODIFY (per-user preferences only)
├── src/server/actions/supervisor-scope.ts            ← ❌ DO NOT MODIFY (read-only)
├── src/server/actions/login-attempts.ts              ← ❌ DO NOT MODIFY
├── src/lib/offline/**                               ← ❌ DO NOT MODIFY
├── src/lib/email/**                                 ← ❌ DO NOT MODIFY
├── src/lib/reports/**                               ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify any files listed in the "DO NOT MODIFY" section above.
> - Use the existing `requireAdmin()` from `src/lib/session.ts` — do NOT create a new auth helper.
> - Use **Drizzle ORM** for all database queries.
> - Follow the step order exactly.
> - **After completing each phase, run `npm run build` to verify zero errors.**
> - **Key principle:** Every server action that mutates data must verify authorization server-side. Read-only actions (getContracts, getUsers, etc.) used for populating dropdowns are acceptable without role checks since the data is not sensitive and is needed for the UI.

---

## Phase A: CLIN Assignment Validation on Timesheet Save

### Problem

`saveTimesheetBatch()` and `saveTimesheetEntry()` accept any `clinId` without verifying the user is assigned to it.

### Execution Steps

---

**A1.** Modify `src/server/actions/timesheet.ts` — Add CLIN assignment validation to `saveTimesheetBatch()`.

**A1a.** Add the `userAssignments` import to the existing schema import. Find:

```typescript
import { timesheetEntries, userAssignments, clins, contracts, slins } from '@/db/schema';
```

This already includes `userAssignments` — no change needed.

**A1b.** Add a validation function at the top of the file (after imports, before the first exported function):

```typescript
/**
 * Validate that a user has an active assignment to a specific CLIN.
 * Throws an error if the assignment does not exist.
 * This enforces DCAA RBAC: employees can only charge to authorized CLINs.
 */
async function validateClinAssignment(userId: string, clinId: string): Promise<void> {
  const assignment = await db
    .select({ id: userAssignments.id })
    .from(userAssignments)
    .where(
      and(
        eq(userAssignments.userId, userId),
        eq(userAssignments.clinId, clinId),
        eq(userAssignments.isActive, true),
      )
    )
    .limit(1);

  if (assignment.length === 0) {
    throw new Error(`Unauthorized: You are not assigned to CLIN ${clinId}. Cannot save timesheet entry.`);
  }
}
```

**A1c.** Add the validation call inside `saveTimesheetBatch()`, after the future-date guard and before the per-cell loop. Find:

```typescript
  // Server-side guard: reject any entries for future dates
  for (const cell of data.cells) {
    const entryDate = start.add(cell.dayIndex, 'day');
    if (entryDate.isAfter(today, 'day')) {
      throw new Error(`Cannot save hours for future date: ${entryDate.format('MMM D, YYYY')}`);
    }
  }

  for (const cell of data.cells) {
```

Insert BETWEEN the future-date guard and the per-cell loop:

```typescript
  // Server-side guard: validate CLIN assignments for all cells
  const uniqueClinIds = [...new Set(data.cells.map((c) => c.clinId))];
  for (const clinId of uniqueClinIds) {
    await validateClinAssignment(data.userId, clinId);
  }

```

**A1d.** Add the same validation to `saveTimesheetEntry()`. Find the beginning of the function body:

```typescript
export async function saveTimesheetEntry(data: {
  userId: string;
  clinId: string;
  slinId?: string;
  entryDate: Date;
  hours: number;
  changeReasonCode?: string;
  comment?: string;
}): Promise<void> {
  // Find the current max revision for this (userId, clinId, entryDate)
```

Add the validation call as the FIRST line inside the function body:

```typescript
  // Validate CLIN assignment (DCAA RBAC enforcement)
  await validateClinAssignment(data.userId, data.clinId);

```

### Phase A Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected Result |
|---|---|
| **Normal save (assigned CLIN)** | Saves successfully — no change in behavior |
| **Tampered save (unassigned CLIN)** | Error: "Unauthorized: You are not assigned to CLIN..." |
| **Batch save with mixed CLINs (one unauthorized)** | Entire batch rejected before any inserts |
| **Offline sync with valid CLINs** | Syncs normally — offline store only has assigned CLINs |

**⚠️ Do NOT proceed to Phase B until Phase A builds and verifies correctly.**

---

## Phase B: Admin Role Enforcement on Server Actions

### Problem

Admin server actions can be called by any authenticated user. The `requireAdmin()` helper exists in `src/lib/session.ts` but is only used in `page.tsx` files, not in server actions.

### Important Note on `requireAdmin()`

The existing `requireAdmin()` function in `src/lib/session.ts` works as follows:
- Calls `auth()` to get the current session
- Checks if the user has `admin` or `supervisor` role
- **Throws an error** if not authorized
- Returns the session user if authorized

This function uses `auth()` from Auth.js, which reads the session from the request cookies. It works correctly in Server Actions because Server Actions have access to the request context.

### Execution Steps

---

**B1.** Modify `src/server/actions/contracts.ts` — Add `requireAdmin()` to mutation functions.

**B1a.** Add the import at the top of the file:

```typescript
import { requireAdmin } from '@/lib/session';
```

**B1b.** Add `await requireAdmin();` as the FIRST line inside each mutation function:

- `createContract()` — add `await requireAdmin();` as the first line
- `updateContract()` — add `await requireAdmin();` as the first line

**Do NOT add it to `getContracts()` or `getContractById()`** — these are read-only and used by non-admin pages (e.g., timesheet charge code dropdowns use contract data indirectly).

---

**B2.** Modify `src/server/actions/clins.ts` — Add `requireAdmin()` to mutation functions.

**B2a.** Add the import:

```typescript
import { requireAdmin } from '@/lib/session';
```

**B2b.** Add `await requireAdmin();` to:
- `createClin()`
- `updateClin()`

**Do NOT add to `getClinsByContract()`** — read-only, used in dropdowns.

---

**B3.** Modify `src/server/actions/slins.ts` — Add `requireAdmin()` to mutation functions.

**B3a.** Add the import:

```typescript
import { requireAdmin } from '@/lib/session';
```

**B3b.** Add `await requireAdmin();` to:
- `createSlin()`
- `updateSlin()`

**Do NOT add to `getSlinsByClin()`** — read-only.

---

**B4.** Modify `src/server/actions/assignments.ts` — Add `requireAdmin()` to mutation functions.

**B4a.** Add the import:

```typescript
import { requireAdmin } from '@/lib/session';
```

**B4b.** Add `await requireAdmin();` to:
- `assignUserToClin()`
- `unassignUserFromClin()`

**Do NOT add to `getAssignments()`, `getAssignmentsForUser()`** — read-only.

---

**B5.** Modify `src/server/actions/labor-categories.ts` — Add `requireAdmin()` to mutation functions.

**B5a.** Add the import:

```typescript
import { requireAdmin } from '@/lib/session';
```

**B5b.** Add `await requireAdmin();` to:
- `createLaborCategory()`
- `updateLaborCategory()`
- `assignUserToLaborCategory()`
- `endUserLaborCategoryAssignment()`

**Do NOT add to `getAllLaborCategories()`, `getLaborCategoriesByClin()`, `getUserLaborCategoryAssignments()`, `getAssignableLaborCategories()`** — read-only.

---

**B6.** Modify `src/server/actions/users.ts` — Add `requireAdmin()` to admin-only mutation functions.

**B6a.** Add the import:

```typescript
import { requireAdmin } from '@/lib/session';
```

**B6b.** Add `await requireAdmin();` to:
- `createUser()`
- `updateUser()`
- `createUserWithPassword()`
- `unlockUserAccount()`
- `seedUsers()`

**Do NOT add to `getUsers()`, `getUserByEmail()`** — read-only. `getUsers()` is used by the approvals page and other admin UIs that already have page-level checks, but the data itself (user list) is not sensitive enough to warrant blocking server-action-level reads.

### Phase B Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected Result |
|---|---|
| **Admin creates a contract** | Works normally — no change |
| **Admin assigns user to CLIN** | Works normally — no change |
| **Admin creates labor category** | Works normally — no change |
| **Employee calls createContract (tampered request)** | Error: "Forbidden: Admin or Supervisor role required" |
| **Employee calls assignUserToClin (tampered request)** | Error: "Forbidden: Admin or Supervisor role required" |
| **Employee calls updateUser (tampered request)** | Error: "Forbidden: Admin or Supervisor role required" |
| **Supervisor creates user** | Works — supervisors have admin access |
| **Unauthenticated call to any mutation** | Error: "Unauthorized: No active session" |

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**.

### 4b. Regression Checks

| Check | Expected Result |
|---|---|
| **Timesheet page loads** | Charge codes load from user assignments (unchanged) |
| **Timesheet save (normal flow)** | Saves normally for assigned CLINs |
| **Period navigation** | Loads entries correctly (unchanged) |
| **Admin pages** | All CRUD operations work for admin/supervisor users |
| **Approval workflow** | Submit/approve/reject all work (periods.ts not modified) |
| **Offline sync** | Sync works for valid CLINs (sync service calls saveTimesheetBatch) |
| **Password change** | Works (password.ts already has its own checks) |
| **Login** | Works (auth.ts not modified) |

### 4c. Security Verification

| Attack Vector | Expected Defense |
|---|---|
| Employee sends POST to createContract server action | `requireAdmin()` throws "Forbidden" |
| Employee tampers clinId in saveTimesheetBatch | `validateClinAssignment()` throws "Unauthorized" |
| Unauthenticated user calls any mutation | `requireAdmin()` → `auth()` returns null → "No active session" |
| Employee calls updateUser to elevate own role | `requireAdmin()` blocks the call |
| Employee calls assignUserToClin to self-assign | `requireAdmin()` blocks the call |

### 4d. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `requireAdmin is not a function` | Import missing or wrong path | Verify `import { requireAdmin } from '@/lib/session'` |
| `requireAdmin` throws in read-only functions | Added to GET functions by mistake | Only add to mutation functions (create/update/delete) |
| Build error: unused import | `requireAdmin` imported but not used | Only import in files where it's called |
| Timesheet save fails for valid user | `validateClinAssignment` query wrong | Verify the WHERE clause checks `userId`, `clinId`, and `isActive` |
| Admin pages break | `requireAdmin()` conflicts with existing checks | `requireAdmin()` is additive — it doesn't conflict with page-level checks |
| Offline sync fails | `saveTimesheetBatch` rejects valid CLINs | The sync service passes the user's own CLINs — validation should pass |
