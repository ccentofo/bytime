# Blueprint: First-Class Charge Codes (Direct Charging Model)

> **Role for the executing developer: Senior full-stack engineer with DCAA/GovCon domain awareness.**
> This introduces a real **charge code** entity for *direct* charging — the granular thing an employee
> picks (a QuickBooks Service Item, e.g. `G0490.ID.IaaS.OY7.SWE3`) that rolls up to a CLIN → contract.
> Today the **CLIN doubles as the charge code**; this replaces that with a proper entity while keeping
> the append-only timesheet model and all CLIN-based reporting intact. **QuickBooks import is a
> separate, dependent blueprint** (`feature-plan-charge-code-qbo-import.md`) — build this first.

## 1. Domain Overview & Decisions (locked)

**The gap:** a direct timesheet entry is currently just `timesheet_entries.clinId`
(`src/server/actions/timesheet.ts` → `getChargeCodesForUser` builds the pick-list from
`user_assignments → clins`). There is no granular direct charge code. The only real "code" entity is
`indirect_charge_codes` (overhead/G&A/leave). Real DCAA timekeeping (HourTimesheet) charges to a
**Service Item** that rolls up to a Customer:Job and carries a Class.

**Decisions (confirmed with the product owner):**
1. **A charge code = one code string → one CLIN.** Many charge codes can share a CLIN (contract + CLIN
   are inferred from `clin_id`). Example: the same CLIN has `…SWE3.ONSITE` and `…SWE3.TELEWORK`.
2. **Onsite/telework split is first-class:** charge codes carry an optional `work_location` attribute
   (so the split is reportable, not just encoded in the string).
3. **Class is in v1:** a charge code carries an optional **Class** (QBO Class, e.g. "Government
   Services") via a small `cost_classes` lookup.
4. **No legacy data** (pre-production). Every new tenant starts charge-code-empty and fills them via
   **auto-bridge from CLINs** (a one-click "generate a code per CLIN") or **QBO import** (blueprint 2).
   So there is **no historical backfill** — but the timesheet model must still work cleanly.

**Mapping to QuickBooks (for blueprint 2's benefit):** charge code → QBO **Service Item** (`ItemRef`);
its CLIN's contract → QBO **Customer:Job** (`CustomerRef`); its class → QBO **Class** (`ClassRef`).

## 2. Data Model

```
contract ──< clin ──< charge_code >── (rollup: contract + CLIN inferred via clin_id)
                          ├── cost_class?      (QBO Class dimension)
                          ├── labor_category?  (optional rate)
                          └── work_location?   (onsite | telework | other)

user_charge_codes:  user ──< charge_code         (employee's pickable direct codes)
timesheet_entries.charge_code_id  ← NEW: set for direct entries
   (clin_id / slin_id kept, DENORMALIZED from the charge code on insert, so every existing
    CLIN-based query, report, and the perf index keep working unchanged)
```

### New tables + column (in `src/db/schema.ts`)
```ts
// Work-location split (onsite vs telework charge to different codes under the same CLIN)
export const workLocationEnum = pgEnum('work_location', ['onsite', 'telework', 'other']);

// QBO "Class" dimension (e.g. "Government Services"). Mapped to a QBO Class via integration mappings.
export const costClasses = pgTable('cost_classes', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull().unique(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// The first-class DIRECT charge code (the thing employees pick). Rolls up to exactly one CLIN.
export const chargeCodes = pgTable('charge_codes', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: varchar('code', { length: 100 }).notNull().unique(),         // "G0490.ID.IaaS.OY7.SWE3"
  name: varchar('name', { length: 255 }).notNull(),                  // human label
  description: text('description'),
  clinId: uuid('clin_id').notNull().references(() => clins.id, { onDelete: 'cascade' }),
  slinId: uuid('slin_id').references(() => slins.id, { onDelete: 'set null' }),
  laborCategoryId: uuid('labor_category_id').references(() => laborCategories.id, { onDelete: 'set null' }),
  classId: uuid('class_id').references(() => costClasses.id, { onDelete: 'set null' }),
  workLocation: workLocationEnum('work_location'),                    // nullable
  billable: boolean('billable').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_charge_codes_clin').on(table.clinId),
]);

// Assignment: which charge codes an employee may charge to (their direct pick-list).
export const userChargeCodes = pgTable('user_charge_codes', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  chargeCodeId: uuid('charge_code_id').notNull().references(() => chargeCodes.id, { onDelete: 'cascade' }),
  isActive: boolean('is_active').notNull().default(true),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  assignedBy: uuid('assigned_by').references(() => users.id),
}, (table) => [
  uniqueIndex('user_charge_code_unique_idx').on(table.userId, table.chargeCodeId),
]);
```
Add to `timesheetEntries`:
```ts
  chargeCodeId: uuid('charge_code_id').references(() => chargeCodes.id), // nullable — set for DIRECT entries
```
…and a matching perf index (mirror the existing CLIN one):
```ts
  index('idx_entries_user_chargecode_date_rev').on(table.userId, table.chargeCodeId, table.entryDate, table.revisionNumber),
```

Generate the migration with `npm run db:generate` (drizzle-kit) — **do not hand-write SQL**; review the
generated file for idempotency before committing.

## 3. File Topology

```
SCHEMA & MIGRATION:
├── src/db/schema.ts                         ← add costClasses, chargeCodes, userChargeCodes, workLocationEnum; add chargeCodeId + index to timesheetEntries
└── drizzle/<generated>.sql                  ← via `npm run db:generate` (review)

SERVER (the core rework):
├── src/server/actions/timesheet.ts          ← getChargeCodesForUser (source from charge codes), entry keying by chargeCodeId for direct, save/validate, getTimesheetEntries/getRevisionMap
├── src/server/actions/charge-codes.ts       ← CREATE: CRUD + assignment + auto-bridge actions
└── src/server/actions/assignments.ts (or wherever assignment lives) ← assigning a charge code must ALSO ensure the user has the CLIN assignment (supervisor scope + LCAT depend on user_assignments)

ADMIN UI:
├── src/app/(app)/admin/charge-codes/page.tsx + ChargeCodesClient.tsx   ← CREATE (mirror indirect-codes page)
├── src/app/(app)/admin/assignments/AssignmentsClient.tsx               ← extend: assign charge codes (grouped by contract→CLIN; "assign all under CLIN")
└── src/components/shell/AppNavbar.tsx                                   ← add "Charge Codes" nav item (ADMIN_ITEMS)

TIMESHEET UI:
├── src/components/timesheet/TimesheetContext.tsx                       ← chargeCodes now charge-code rows; direct row key = chargeCodeId
├── src/components/timesheet/cells/ChargeCodeCell.tsx                   ← show code + name (+ work-location badge, contract/CLIN context)
└── src/components/timesheet/BiWeeklyTable.tsx                          ← row identity uses chargeCodeId for direct (verify)

REPORTS & SEED:
├── src/lib/reports/timesheet-pdf.tsx, src/lib/reports/cost-report-excel.ts  ← group by charge code → CLIN → contract; include class
└── scripts/seed-full.ts (seedRichData)                                ← seed charge codes (incl. an onsite/telework pair) + cost_classes + user_charge_codes; entries reference chargeCodeId

DO NOT MODIFY:
├── append-only invariant — NEVER update/delete timesheet_entries rows (new revisions only)
├── indirect_charge_codes flow — indirect entries still key by indirectCodeId (unchanged)
└── the QBO connector — that's blueprint 2
```

## 4. Step-by-Step

> **⚠️ GUARDRAILS:**
> - Next.js 16 + Drizzle — read the migration/query docs in `node_modules` before relying on APIs.
> - **Append-only is sacred:** edits create new revisions; never mutate/delete existing entries.
> - **Denormalize, don't drop:** every DIRECT entry sets BOTH `chargeCodeId` AND `clinId`/`slinId`
>   (copied from the charge code) so existing CLIN-based reads/reports/indexes keep working.
> - **Supervisor scope + LCAT depend on `user_assignments` (user↔CLIN).** When you assign a charge
>   code to a user, also upsert their `user_assignments` row for that code's CLIN, or supervisor
>   approval routing and labor-category rates break.
> - `npm run build`, `npm run test`, `npm run test:integration`, `npm run lint` must pass.

**Step 1 — Schema + migration.** Add the tables/enum/column from §2 to `schema.ts`. Run
`npm run db:generate`; review the SQL (additive only — new tables, one nullable column, two indexes).

**Step 2 — `getChargeCodesForUser` rework** (`timesheet.ts:55`). Source the **direct** pick-list from
`user_charge_codes → charge_codes → clins → contracts` (left-join `cost_classes`, `labor_categories`,
`slins`), keeping the **indirect** half (`indirect_charge_codes WHERE available_to_all`) unchanged.
Extend the `ChargeCode` type so each direct row carries `chargeCodeId`, `code`, `name`,
`workLocation`, `clinId`, `clinNumber`, `contractName`, `contractNumber`, optional `className`/`lcat`.
The row **identity** for a direct charge code becomes `chargeCodeId` (was `clinId`).

**Step 3 — Entry keying + read paths.** In `getTimesheetEntries` (:130) and `getRevisionMap` (:186),
key DIRECT entries by `chargeCodeId` (currently `clinId`); indirect still by `indirectCodeId`. The
"entry id" used as the map key (`row.clinId ?? row.indirectCodeId`) becomes
`row.chargeCodeId ?? row.indirectCodeId`. Select `chargeCodeId` in these queries and use the new
index.

**Step 4 — Save + validate** (`saveTimesheetBatch` :227, `saveTimesheetEntry` :389,
`validateClinAssignment` :17). Cells now carry `chargeCodeId` for direct (instead of `clinId`):
- Replace `validateClinAssignment(userId, clinId)` with `validateChargeCodeAssignment(userId,
  chargeCodeId)` (check `user_charge_codes` active). Keep an indirect path as-is.
- On insert, look up the charge code once, and write `chargeCodeId` **plus the denormalized
  `clinId`/`slinId`** from it. Preserve the revision-increment logic and the period-lock /
  late-entry / reason-code enforcement exactly (don't regress the write-path blueprint's guards).

**Step 5 — `charge-codes.ts` server actions** (CREATE). `requireAdmin` on writes:
- `listChargeCodes()`, `createChargeCode(...)`, `updateChargeCode(...)`, `deactivateChargeCode(id)`
  (soft-delete via `isActive` — never hard-delete a code that has entries).
- `listCostClasses()`, `createCostClass(name)`.
- `assignChargeCodeToUser(userId, chargeCodeId)` / `unassign...` — **and upsert the CLIN
  `user_assignments` row** (see guardrail). `assignAllUnderClin(userId, clinId)` convenience.
- `autobridgeChargeCodesFromClins()` — for each active CLIN with no charge code, create one
  (`code` defaulting to e.g. `${contractNumber}-${clinNumber}`, `name` from the CLIN description).
  Idempotent. This is onboarding path A.

**Step 6 — Admin Charge Codes page** (CREATE; mirror `indirect-codes/IndirectCodesClient.tsx` for the
table/modal pattern). Columns: Code, Name, Contract→CLIN, Class, Work Location, LCAT, Active.
Create/Edit modal: code, name, contract+CLIN picker (CLIN list filtered by contract), optional SLIN,
optional LCAT, optional Class (select from `cost_classes` + "add new"), optional Work Location
(onsite/telework/other), billable, active. Add an **"Auto-generate from CLINs"** button
(`autobridgeChargeCodesFromClins`). Add the nav entry in `AppNavbar.tsx` (use `component={Link}` like
the rest, e.g. icon `IconHash` or `IconTag`).

**Step 7 — Assignment UI** (`AssignmentsClient.tsx`). Add charge-code assignment: per user, show charge
codes grouped by contract→CLIN with checkboxes, plus "assign all under CLIN." Calls the Step-5 actions
(which keep `user_assignments` in sync).

**Step 8 — Timesheet wiring.** `TimesheetContext.tsx` already threads `state.chargeCodes` and uses a
charge-code id per row — confirm the direct row id is now the `chargeCodeId` from Step 2, and that
save sends `chargeCodeId`. Update `ChargeCodeCell.tsx` to render the **code + name**, a small
work-location badge (Onsite/Telework) when set, and the contract/CLIN as secondary context. Keep the
density tiers from the fit-to-width work.

**Step 9 — Reports.** In `timesheet-pdf.tsx` and `cost-report-excel.ts`, group/label by **charge code
→ CLIN → contract** and add the **Class** column. Direct rows show the charge code; indirect rows
unchanged. (CLIN totals still work because `clinId` is denormalized on entries.)

**Step 10 — Seed.** In `seedRichData` (`scripts/seed-full.ts`), create a few `cost_classes` (e.g.
"Government Services"), create charge codes per CLIN **including one onsite/telework pair** to
demonstrate the split, populate `user_charge_codes` for the active employees (and ensure their
`user_assignments` still exist), and make the generated timesheet entries set `chargeCodeId` (+ the
denormalized `clinId`). The demo must visibly show real charge codes in the picker.

## 5. Verification

### 5a. Build, tests, lint
```bash
npm run db:generate && npm run build
npm run test && npm run test:integration
npm run lint
```

### 5b. Functional
| Check | Expected |
|---|---|
| Auto-generate from CLINs | one active charge code per CLIN; idempotent on re-run |
| Create a charge code (onsite) + (telework) under the SAME CLIN | both exist, same contract/CLIN, distinct codes + work-location badges |
| Assign codes to an employee | they appear in that employee's timesheet picker; unassigned codes do not |
| Assigning a code | the user's `user_assignments` row for that CLIN exists (supervisor scope intact) |
| Enter direct hours, save | entry has `chargeCodeId` AND denormalized `clinId`; revisions still increment append-only |
| Edit an entry late | reason-code/period-lock guards still enforced (no regression) |
| Indirect charging (OH/leave) | unchanged — keys by `indirectCodeId` |
| Supervisor approval | supervisor sees/approves employees on their assigned CLINs (via denormalized clinId) |
| Cost report / PDF | grouped by charge code → CLIN → contract; Class column present; CLIN totals correct |

### 5c. DCAA integrity
| Check | Expected |
|---|---|
| No row is ever updated/deleted | edits add revisions only |
| Deactivating a charge code with history | soft-delete (isActive=false); historical entries + reports intact |
| Physical isolation | charge codes live in the tenant DB (no cross-tenant leakage) |

### 5d. Common errors
| Symptom | Cause | Fix |
|---|---|---|
| Supervisor can't see an employee's hours | charge-code assignment didn't upsert `user_assignments` | Step 5 must sync the CLIN assignment |
| Old CLIN-based report empty | entries set `chargeCodeId` but not denormalized `clinId` | always copy `clinId`/`slinId` from the charge code on insert |
| Duplicate-key on entry save | revision keying still on `clinId` not `chargeCodeId` | update getRevisionMap/save keying (Steps 3–4) |
| Picker empty after migrate | employee has no `user_charge_codes` | assign codes (or run auto-bridge + assign) |

## 6. Definition of Done
A direct charge is a first-class charge code (code → CLIN → contract, with optional Class, LCAT, and
onsite/telework), employees charge to **assigned charge codes**, the append-only model + supervisor
scope + CLIN reporting all still work, and a tenant can populate codes via **auto-bridge** today (QBO
import lands in `feature-plan-charge-code-qbo-import.md`).
```
