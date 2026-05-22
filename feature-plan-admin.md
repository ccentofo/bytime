# Blueprint: Admin Architecture & WBS Management

## 1. Architectural Overview & DCAA Impact

### The Relational Mapping

The Admin Architecture introduces four core database tables that model the Government Contracting Work Breakdown Structure (WBS):

```
Users ──┐
        ├──► UserAssignments ◄──┐
CLINs ──┘                       │
  │                             │
  └── belongs to ──► Contracts ─┘ (indirect via CLIN)
```

**Table Relationships:**
- **`users`** — Every person in the system (employees, supervisors, admins). Minimal for MVP: `id`, `email`, `full_name`, `role`.
- **`contracts`** — Top-level government contracts. Each has a `contract_number`, `name`, `status` (active/inactive), and metadata like `start_date`/`end_date`.
- **`clins`** — Contract Line Item Numbers. Each CLIN belongs to exactly one Contract (FK → `contracts.id`). Stores `clin_number`, `description`, and `status`. This is the "charge code" employees log time against.
- **`user_assignments`** — The **DCAA enforcement table**. A junction/mapping table with FKs to both `users.id` and `clins.id`. If a row does NOT exist for a given user+CLIN pair, that user **cannot** see or charge time to that CLIN. This is the strict RBAC gatekeeper.

### How This Enforces DCAA Compliance

Per DCAA requirements (FAR 31.201-1, CAS 418), employees must only charge to contracts/CLINs they are explicitly authorized to work on. The `user_assignments` table provides:

1. **Positive Authorization** — A user can only see charge codes where an explicit `user_assignments` row exists. There is no "allow all" default.
2. **Audit Trail** — The `assigned_at` and `assigned_by` columns record exactly when and by whom the assignment was made.
3. **Revocability** — Setting `is_active = false` immediately removes access without modifying historical timesheet data.

When the timesheet UI eventually queries for a user's available charge codes, the query will be:
```sql
SELECT c.contract_number, cl.clin_number, cl.description
FROM user_assignments ua
JOIN clins cl ON ua.clin_id = cl.id
JOIN contracts c ON cl.contract_id = c.id
WHERE ua.user_id = $1 AND ua.is_active = true AND cl.status = 'active' AND c.status = 'active';
```

This will replace the current `MOCK_CHARGE_CODES` array with real, permission-scoped data in a future phase.

---

## 2. File Topology

```
Files to CREATE (new):
├── docker-compose.yml                              ← PostgreSQL dev container
├── .env.local                                      ← DATABASE_URL env var
├── drizzle.config.ts                               ← Drizzle Kit configuration
│
├── src/db/
│   ├── index.ts                                    ← Drizzle client (db connection singleton)
│   └── schema.ts                                   ← All table definitions (users, contracts, clins, user_assignments)
│
├── src/app/admin/
│   ├── layout.tsx                                  ← Admin layout wrapper (sidebar nav for admin pages)
│   ├── contracts/
│   │   ├── page.tsx                                ← Server Component: Contracts list page
│   │   └── ContractsClient.tsx                     ← Client Component: Mantine React Table + CLIN drawer
│   ├── assignments/
│   │   ├── page.tsx                                ← Server Component: User Assignments page
│   │   └── AssignmentsClient.tsx                   ← Client Component: Assignment management UI
│
├── src/server/
│   ├── actions/
│   │   ├── contracts.ts                            ← Server Actions: CRUD for contracts
│   │   ├── clins.ts                                ← Server Actions: CRUD for CLINs
│   │   ├── users.ts                                ← Server Actions: fetch/seed users
│   │   └── assignments.ts                          ← Server Actions: assign/unassign users ↔ CLINs

Files to MODIFY:
├── package.json                                    ← Add drizzle-orm, drizzle-kit, postgres (pg driver)

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/components/timesheet/*                      ← ❌ DO NOT MODIFY
├── src/app/timesheet/*                             ← ❌ DO NOT MODIFY
├── src/data/mock-timesheet.ts                      ← ❌ DO NOT MODIFY
├── src/types/timesheet.ts                          ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** touch, modify, or import from any file under `src/components/timesheet/`, `src/app/timesheet/`, `src/data/`, or `src/types/timesheet.ts`.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`).
> - Use **Mantine React Table v2** (`mantine-react-table`) for data grids.
> - Use **Drizzle ORM** with the `postgres` driver (the `postgres` npm package, not `pg` or `@vercel/postgres`).
> - Do **NOT** search or read files inside `node_modules/`, `.next/`, or `dist/`.
> - Follow the step order exactly. Each step builds on the previous one.

---

### Step 0: Install Dependencies & Bootstrap PostgreSQL

**0a.** Install Drizzle ORM, Drizzle Kit, and the PostgreSQL driver:

```bash
npm install drizzle-orm postgres
npm install -D drizzle-kit
```

**0b.** Create `docker-compose.yml` at the project root to run a local PostgreSQL instance:

```yaml
version: '3.8'
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    ports:
      - '5432:5432'
    environment:
      POSTGRES_USER: bytime
      POSTGRES_PASSWORD: bytime_dev
      POSTGRES_DB: bytime
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

**0c.** Create `.env.local` at the project root:

```env
DATABASE_URL=postgresql://bytime:bytime_dev@localhost:5432/bytime
```

**0d.** Start the database:

```bash
docker-compose up -d
```

**0e.** Create `drizzle.config.ts` at the project root:

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

**0f.** Add convenience scripts to `package.json` under `"scripts"`:

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate",
"db:push": "drizzle-kit push",
"db:studio": "drizzle-kit studio"
```

---

### Step 1: Drizzle Schema Definition

**1a.** Create `src/db/schema.ts` with all four tables. Use strict types, foreign keys, and sensible defaults:

```typescript
import { pgTable, uuid, varchar, text, timestamp, boolean, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRoleEnum = pgEnum('user_role', ['admin', 'supervisor', 'employee']);
export const statusEnum = pgEnum('record_status', ['active', 'inactive', 'closed']);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  fullName: varchar('full_name', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull().default('employee'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export const contracts = pgTable('contracts', {
  id: uuid('id').defaultRandom().primaryKey(),
  contractNumber: varchar('contract_number', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  status: statusEnum('status').notNull().default('active'),
  startDate: timestamp('start_date', { withTimezone: true }),
  endDate: timestamp('end_date', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// CLINs (Contract Line Item Numbers)
// ---------------------------------------------------------------------------

export const clins = pgTable('clins', {
  id: uuid('id').defaultRandom().primaryKey(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  clinNumber: varchar('clin_number', { length: 50 }).notNull(),
  description: text('description'),
  status: statusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// User Assignments (DCAA RBAC enforcement)
// ---------------------------------------------------------------------------

export const userAssignments = pgTable('user_assignments', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clinId: uuid('clin_id').notNull().references(() => clins.id, { onDelete: 'cascade' }),
  isActive: boolean('is_active').notNull().default(true),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  assignedBy: uuid('assigned_by').references(() => users.id),
}, (table) => [
  uniqueIndex('user_clin_unique_idx').on(table.userId, table.clinId),
]);
```

**1b.** Create `src/db/index.ts` — the database client singleton:

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

// Use max 1 connection for Next.js serverless compatibility
const client = postgres(connectionString);
export const db = drizzle(client, { schema });
```

**1c.** Push the schema to the database:

```bash
npx drizzle-kit push
```

Verify all four tables are created by running:

```bash
npx drizzle-kit studio
```

Navigate to `https://local.drizzle.studio` and confirm all four tables exist with the correct columns and foreign key relationships.

---

### Step 2: Server Actions (CRUD Operations)

All server actions use the `'use server'` directive and import `db` from `@/db`. They should be simple, focused functions.

**2a.** Create `src/server/actions/contracts.ts`:

```typescript
'use server';

import { db } from '@/db';
import { contracts } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function getContracts() {
  return db.select().from(contracts).orderBy(contracts.name);
}

export async function getContractById(id: string) {
  const rows = await db.select().from(contracts).where(eq(contracts.id, id));
  return rows[0] ?? null;
}

export async function createContract(data: {
  contractNumber: string;
  name: string;
  description?: string;
  startDate?: Date;
  endDate?: Date;
}) {
  const rows = await db.insert(contracts).values(data).returning();
  return rows[0];
}

export async function updateContract(id: string, data: {
  contractNumber?: string;
  name?: string;
  description?: string;
  status?: 'active' | 'inactive' | 'closed';
  startDate?: Date;
  endDate?: Date;
}) {
  const rows = await db.update(contracts)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(contracts.id, id))
    .returning();
  return rows[0];
}
```

**2b.** Create `src/server/actions/clins.ts`:

```typescript
'use server';

import { db } from '@/db';
import { clins } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function getClinsByContract(contractId: string) {
  return db.select().from(clins).where(eq(clins.contractId, contractId)).orderBy(clins.clinNumber);
}

export async function createClin(data: {
  contractId: string;
  clinNumber: string;
  description?: string;
}) {
  const rows = await db.insert(clins).values(data).returning();
  return rows[0];
}

export async function updateClin(id: string, data: {
  clinNumber?: string;
  description?: string;
  status?: 'active' | 'inactive' | 'closed';
}) {
  const rows = await db.update(clins)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(clins.id, id))
    .returning();
  return rows[0];
}
```

**2c.** Create `src/server/actions/users.ts`:

```typescript
'use server';

import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function getUsers() {
  return db.select().from(users).orderBy(users.fullName);
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
  // Only seed if the table is empty
  const existing = await db.select().from(users);
  if (existing.length > 0) return existing;

  const seedData = [
    { email: 'admin@bytime.dev', fullName: 'Admin User', role: 'admin' as const },
    { email: 'jane.smith@bytime.dev', fullName: 'Jane Smith', role: 'employee' as const },
    { email: 'john.doe@bytime.dev', fullName: 'John Doe', role: 'employee' as const },
    { email: 'sarah.wilson@bytime.dev', fullName: 'Sarah Wilson', role: 'supervisor' as const },
  ];

  return db.insert(users).values(seedData).returning();
}
```

**2d.** Create `src/server/actions/assignments.ts`:

```typescript
'use server';

import { db } from '@/db';
import { userAssignments, users, clins, contracts } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export async function getAssignments() {
  return db
    .select({
      id: userAssignments.id,
      userId: userAssignments.userId,
      clinId: userAssignments.clinId,
      isActive: userAssignments.isActive,
      assignedAt: userAssignments.assignedAt,
      userName: users.fullName,
      userEmail: users.email,
      clinNumber: clins.clinNumber,
      clinDescription: clins.description,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
    })
    .from(userAssignments)
    .innerJoin(users, eq(userAssignments.userId, users.id))
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .orderBy(users.fullName, contracts.name);
}

export async function getAssignmentsForUser(userId: string) {
  return db
    .select({
      id: userAssignments.id,
      clinId: userAssignments.clinId,
      isActive: userAssignments.isActive,
      clinNumber: clins.clinNumber,
      clinDescription: clins.description,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
    })
    .from(userAssignments)
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .where(eq(userAssignments.userId, userId))
    .orderBy(contracts.name);
}

export async function assignUserToClin(data: {
  userId: string;
  clinId: string;
  assignedBy?: string;
}) {
  const rows = await db
    .insert(userAssignments)
    .values(data)
    .onConflictDoUpdate({
      target: [userAssignments.userId, userAssignments.clinId],
      set: { isActive: true, assignedAt: new Date() },
    })
    .returning();
  return rows[0];
}

export async function unassignUserFromClin(userId: string, clinId: string) {
  const rows = await db
    .update(userAssignments)
    .set({ isActive: false })
    .where(and(eq(userAssignments.userId, userId), eq(userAssignments.clinId, clinId)))
    .returning();
  return rows[0];
}
```

---

### Step 3: Contracts & CLINs Admin UI

**3a.** Create `src/app/admin/layout.tsx` — a minimal admin layout wrapper:

```typescript
import { AppShell, NavLink, Title } from '@mantine/core';
import { IconFileText, IconUsers } from '@tabler/icons-react';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      navbar={{ width: 250, breakpoint: 'sm' }}
      padding="md"
    >
      <AppShell.Navbar p="md">
        <Title order={4} mb="md">Admin Panel</Title>
        <NavLink
          label="Contracts & CLINs"
          href="/admin/contracts"
          leftSection={<IconFileText size={18} />}
        />
        <NavLink
          label="User Assignments"
          href="/admin/assignments"
          leftSection={<IconUsers size={18} />}
        />
      </AppShell.Navbar>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}
```

**3b.** Create `src/app/admin/contracts/page.tsx` — Server Component that fetches data and passes it to the client:

```typescript
import { getContracts } from '@/server/actions/contracts';
import { ContractsClient } from './ContractsClient';

export default async function ContractsPage() {
  const contracts = await getContracts();
  return <ContractsClient initialContracts={contracts} />;
}
```

**3c.** Create `src/app/admin/contracts/ContractsClient.tsx` — the main Contracts CRUD UI.

This is a `'use client'` component that must implement:

**Contracts Table (Mantine React Table):**
- Columns: `Contract Number`, `Name`, `Status`, `Start Date`, `End Date`.
- Use `useMantineReactTable` with `enableEditing: false` (editing is done via modal, not inline).
- Enable row actions: `enableRowActions: true`.
- Use `renderRowActionMenuItems` to provide:
  - **"Edit"** — opens a Mantine `Modal` with the contract form pre-filled for editing.
  - **"Manage CLINs"** — opens a Mantine `Drawer` on the right side.
- Use `renderTopToolbarCustomActions` for an **"Add Contract"** `Button`.

**Add/Edit Contract Modal:**
- Mantine `Modal` with form fields:
  - `TextInput` for `contractNumber` (required)
  - `TextInput` for `name` (required)
  - `Textarea` for `description`
  - `DateInput` (from `@mantine/dates`) for `startDate` and `endDate`
- On submit: call `createContract` or `updateContract` server action.

**CLINs Drawer:**
- Mantine `Drawer` positioned on the right (`position="right"`, `size="lg"`).
- Header shows the contract name and number.
- Contains:
  - An **"Add CLIN" form** at the top: `TextInput` for `clinNumber`, `TextInput` for `description`, `Button` to submit. Calls `createClin`.
  - A **CLINs list** below: either a simple Mantine `Table` or a small Mantine React Table showing `CLIN Number`, `Description`, `Status` for the selected contract. Fetched via `getClinsByContract` when the drawer opens.
  - Each CLIN row has an inline status toggle or edit action calling `updateClin`.

**State Management:**
- Use `useState` for local UI state (modal open/close, drawer open/close, selected contract, CLIN list, form values).
- After any mutation, refresh data by re-calling the server action and updating local state.
- Use `useTransition` for pending states on submit buttons.

---

### Step 4: User Assignment UI

**4a.** Create `src/app/admin/assignments/page.tsx` — Server Component:

```typescript
import { getAssignments } from '@/server/actions/assignments';
import { getUsers } from '@/server/actions/users';
import { getContracts } from '@/server/actions/contracts';
import { AssignmentsClient } from './AssignmentsClient';

export default async function AssignmentsPage() {
  const [assignments, allUsers, allContracts] = await Promise.all([
    getAssignments(),
    getUsers(),
    getContracts(),
  ]);
  return (
    <AssignmentsClient
      initialAssignments={assignments}
      users={allUsers}
      contracts={allContracts}
    />
  );
}
```

**4b.** Create `src/app/admin/assignments/AssignmentsClient.tsx` — the main assignment management UI.

This is a `'use client'` component with two sections:

**Section A — "Create Assignment" Form (top of page):**
- A Mantine `Select` dropdown for choosing a **User** (populated from `users` prop, `data` mapped to `{ value: user.id, label: user.fullName }`).
- A Mantine `Select` dropdown for choosing a **Contract** (populated from `contracts` prop).
- When a Contract is selected, fetch CLINs for that contract via `getClinsByContract` server action, then render a third `Select` (or `MultiSelect`) showing available CLINs.
- An **"Assign"** `Button` that calls `assignUserToClin`.

**Section B — Current Assignments Table (below the form):**
- A **Mantine React Table** showing all current assignments with columns:
  - `Employee` (user full name)
  - `Contract` (contract name + number)
  - `CLIN` (CLIN number)
  - `Status` (Mantine `Badge` — green for active, gray for inactive)
  - `Assigned Date`
- Each row has an action button/toggle to **deactivate** the assignment (calls `unassignUserFromClin`).
- Enable column filtering so the admin can filter by user or contract.

**State Management:**
- Use `useState` for local state (form values, CLIN options, assignments list).
- After any mutation (assign/unassign), either:
  - Re-fetch assignments via `getAssignments()` and update local state, OR
  - Call `router.refresh()` from `next/navigation` to re-run the server component.
- Use `useTransition` for pending states on action buttons.

---

## 4. Verification

### 4a. Database Migration Check

After completing Step 1, run:

```bash
npx drizzle-kit push
```

Then verify tables exist:

```bash
psql postgresql://bytime:bytime_dev@localhost:5432/bytime -c "\dt"
```

Expected output should show 4 tables: `users`, `contracts`, `clins`, `user_assignments`.

Alternatively, open Drizzle Studio:

```bash
npx drizzle-kit studio
```

Navigate to `https://local.drizzle.studio` and verify all four tables are visible with correct columns and foreign key relationships.

### 4b. Seed Data Verification

After completing Step 2, insert test data either via Drizzle Studio or by calling the `seedUsers()` action. Ensure the database has:

- **4 users** (1 admin, 1 supervisor, 2 employees)
- **2–3 contracts** (e.g., "NAVAIR Systems Support — W58RGZ-21-C-0001", "DISA Cyber Ops — HC1028-22-C-0015")
- **3–5 CLINs per contract**
- **5–8 user assignments** mapping users to various CLINs

### 4c. Build Check

```bash
npm run build
```

Must complete with **zero errors**. Pay special attention to:
- Server Action imports working correctly across the client/server boundary
- No client/server boundary violations (e.g., importing `db` in a `'use client'` file — this must never happen)
- Drizzle schema types resolving correctly

### 4d. Dev Server Visual Checks

```bash
npm run dev
```

Navigate to `http://localhost:3000/admin/contracts` and verify:

| Check | Expected Result |
|---|---|
| **Admin layout** | Left sidebar renders with "Contracts & CLINs" and "User Assignments" nav links |
| **Contracts table** | Mantine React Table renders with seeded contract data |
| **Add Contract** | Clicking button opens modal; form submits successfully; new row appears in table |
| **Edit Contract** | Row action opens modal pre-filled with contract data; saves update; table refreshes |
| **Manage CLINs** | Row action opens Drawer on the right; shows CLINs for the selected contract |
| **Add CLIN** | Form in drawer submits successfully; new CLIN appears in the CLIN list |

Navigate to `http://localhost:3000/admin/assignments` and verify:

| Check | Expected Result |
|---|---|
| **Assignment form** | User dropdown populates; Contract dropdown populates; CLIN dropdown cascades after contract selection |
| **Assign** | Submitting creates a new assignment row in the table below |
| **Assignments table** | Shows all assignments with Employee, Contract, CLIN, Status columns |
| **Deactivate** | Toggle/button sets assignment to inactive; badge turns gray |
| **No timesheet impact** | Navigate to `/timesheet` — existing mock-data timesheet still works identically with zero changes |

### 4e. Guardrail Verification

Run a quick git diff to confirm:

```bash
git diff --name-only
```

The output must **NOT** include any files under:
- `src/components/timesheet/`
- `src/app/timesheet/`
- `src/data/`
- `src/types/timesheet.ts`

If any of these files appear in the diff, the agent has violated the guardrail and the changes must be reverted immediately.

### 4f. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `Module not found: drizzle-orm` | Dependencies not installed | Run `npm install drizzle-orm postgres` and `npm install -D drizzle-kit` |
| `relation "users" does not exist` | Migration not run | Run `npx drizzle-kit push` |
| `"use server" functions cannot be imported in client components` | Importing `db` or schema directly in a `'use client'` file | Server actions must be in separate `'use server'` files; client components call them as async functions |
| `Cannot read properties of undefined (reading 'id')` | Empty database, no seed data | Run the `seedUsers()` action or insert data via Drizzle Studio |
| `uniqueIndex constraint violation` | Duplicate user+CLIN assignment | The `onConflictDoUpdate` in `assignUserToClin` handles this — verify it's implemented correctly |
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL not running | Run `docker-compose up -d` |
| `DateInput is not exported from @mantine/core` | Wrong import path | `DateInput` comes from `@mantine/dates`, not `@mantine/core` |
| Hydration mismatch on Date columns | Server renders date differently than client | Format dates to strings on the server before passing as props, or use `suppressHydrationWarning` |
