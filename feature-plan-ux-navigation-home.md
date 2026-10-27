# Blueprint UX-2: navigation, Home, Settings area, Approvals to-do, Setup and SLIN fixes

> **Role for the executing developer:** senior full-stack engineer (Next.js App Router, Mantine, Drizzle).
> **Follows:** `BLUEPRINT-STANDARD.md`. **Builds on:** UX-1 (merged), which provides `icons.ts`, `RowActions`, `PageHeader`, theme tokens and the a11y lint + axe helper.
> **Sources:** `UX-AUDIT.md` (B1, B3, B5, §2, §6), the approved mockups `ux-mockups/index.html` (Admin home, Supervisor approvals, Settings area, Navigation before/after).
> **Status:** v3 (FINAL), 2026-10-27, lead architect. Pre-mortem rounds 1 and 2 fixed (§13). **Branch:** cut `ux-navigation` from an up-to-date `main`.

**What this phase delivers:**
1. **New sidebar.** A short main menu by role, with collapsible groups, prefix-based active state, a collapsed-rail flyout and a closing mobile menu.
2. **A separate Settings area** at `/settings/*` with its own sidebar.
3. **A role-aware Home page** at `/home`, where admins and supervisors land.
4. **Approvals as a to-do list,** with the waiting count in the sidebar (fixes B3).
5. **A Setup Wizard that tells the truth** (fixes B1).
6. **Deactivated SLINs block new time** (B5).
7. **A user-menu cleanup,** with Notifications moved under Profile.

**Out of scope:**

| Phase | Scope |
|---|---|
| UX-3 | Timesheet layout and keyboard grid; the employee "Past timesheets" page and `?period=` deep links |
| UX-4 | Merging Direct/Indirect codes into tabs; merging the Import and Migration pages; consolidating assignments; the page-by-page pass and copy |
| Backlog | Post-login `callbackUrl` deep links; paginating `getScopedPeriods`' all-history payload; request-caching `auth()` |

---

## 0. Decisions

| # | Decision | Ruling / default |
|---|---|---|
| UX-D3 | Where people land | Admins and supervisors → `/home`; employees → `/timesheet` (product owner, 2026-10-27) |
| B5 | Deactivated SLIN | Blocks **new** hours like a CLIN; existing hours stay correctable (product owner, 2026-10-27) |
| UX2-Q1 | Who is "expected to submit" for Home's team status | **Default (pending product owner):** active users with role `employee` or `supervisor`, plus any admin who has latest-revision hours or a period row in that period. People created after the period ended don't count; mid-period hires do; deactivated users drop out. A supervisor's team is the people they can approve (not themselves or peers). Lives in one constant (`EXPECTED_SUBMITTER_ROLES`) and one function, so a change is one line. |
| UX2-Q2 | Contract burn labels | **Default:** reuse today's dashboard tiers (rounded %, as today), moved into one shared module. Labels: < 75% "On track", ≥ 75% "Watch", ≥ 90% "Near limit", remaining < 0 "Over funding", no funded value "No funding set". Home lists active contracts at Watch or above. |
| L1 (lead) | URL strategy | **Narrow move.** Only the Settings-area pages move to `/settings/*`; Notifications moves to `/profile/notifications`; Payroll export moves to `/admin/payroll-export`. Every other URL stays, and nav labels are decoupled from URLs. All old URLs redirect. |
| L2 (lead) | Setup banner | Removed. Home's "Finish setting up" item replaces it, so the layout stops computing setup status on every page. |
| L3 (lead) | Waiting count | A new lean `approvalQueue` / `getWaitingCount` (`src/server/internal/approval-queue.ts`), never `getScopedPeriods`, which loads all history. |

## 1. Verified current state (file:line, `main` after UX-1)

**Shell**
- `src/app/(app)/layout.tsx`:
  - Tenant state gates: `:16-49`.
  - Logged-out users → `redirect('/login')`, with no `callbackUrl`: `:52-54`.
  - **`getSetupStatusInternal()` for admins on every render:** `:62-72`.
  - Collapse cookie: `:77-78`. Read-only reason: `:80-82`.
  - Renders `AppShellWrapper`: `:85-93`.
- `AppShellWrapper.tsx`:
  - Collapse cookie `cadenzpoint-navbar-collapsed` (`:33,69-79`); the rail only shows on desktop (`:54-55`); width 72/250 (`:85`).
  - Mobile `useDisclosure` (`:41`). **The menu never closes on navigation:** there's no pathname effect, and the layout doesn't remount.
  - Setup banner with sessionStorage dismissal (`:32,57-67,157-159`).
  - Read-only banner (`:123-145`).
  - Skip link and `#main-content` from UX-1.
- `AppNavbar.tsx:17-44`: three flat lists (TIMEKEEPING, APPROVALS, ADMINISTRATION with 14 items). **Exact-match active state** (`:58`), so sub-pages highlight nothing.
- `AppHeader.tsx`: user menu with raw "Role: admin", "Change Password" → `/profile` (`:74-80`), "Notification Settings" → `/admin/notifications` (`:81-87`), Sign out (`.danger`).

**Routes and guards**
- Guards are page-level: `requirePageRole` (`src/lib/session.ts:149-155`) sends a missing session to `/login` and a wrong role to `/timesheet`. `src/proxy.ts` has no path rules (`:14`). `next.config.ts` has only `headers()` (`:51-58`), no `redirects()`.
- Route → guard (page.tsx line):

  | Route | Guard |
  |---|---|
  | `/timesheet` | `auth()` (19-22) |
  | `/profile` | `auth()` |
  | `/admin/notifications` | `auth()` only |
  | approvals, audit-trail, reports | approver |
  | dashboard, contracts, charge-codes, indirect-codes, labor-categories, users, assignments, setup, settings, billing, integrations (+ quickbooks, gusto, payroll-export), api-keys, import, migration | admin |

- `/` on a workspace host → `/timesheet`, with no session check (`src/app/page.tsx:22`). Login pushes `/timesheet` (`LoginForm.tsx:110`).
- **Links to moving routes:**

  | Route | Linked from |
  |---|---|
  | `/admin/billing` | AppNavbar:43; AppShellWrapper:138; Stripe `src/server/actions/billing.ts:55-56` (success/cancel), `:74` (portal return); emails `suspension-warning`, `suspended`, `payment-failed`, `trial-ending`, `trial-ended` (line 8 each); `billing-ui.test.tsx:72-78` |
  | `/admin/settings` | AppNavbar:42; `PayrollExportClient.tsx:251`; emails `subscription-ended.tsx:8`, `deletion-scheduled.tsx:11` |
  | `/admin/integrations/*` | AppNavbar:40; `IntegrationsClient.tsx:113,125,194,231,242`; `QBOConfigClient.tsx:208,219`; `GustoConfigClient.tsx:222,230`; `quickbooks/page.tsx:33,41`; `gusto/page.tsx:28,35`; `PayrollExportClient.tsx:127`; OAuth `api/integrations/callback/[provider]/route.ts:39`, `complete/[provider]/route.ts:55,67,71,87,90`, `gusto-connect:26,45`, `qbo-connect:31,51`; `integration/oauth-connect.test.ts:305` |
  | `/admin/api-keys`, `/admin/import`, `/admin/migration` | AppNavbar; `MigrationClient.tsx:246`; `SetupWizardClient.tsx:111` |
  | `/admin/notifications` | `AppHeader.tsx:84` |

  26 test files read `src/app/(app)/admin/...` by path, and 12 import from it (e.g. `page-metadata.test.ts:54`, `icon-registry.test.ts:21-36`).

**Data for Home**
- **`getEmployeeDashboardData()`** (`src/server/actions/employee-dashboard.ts:60`, action, `requireSession`):
  - about 11 queries;
  - aggregates only, no per-day hours (`:85-107`);
  - `COUNT(DISTINCT entry_date)` counts zero-hour cleared cells as days with entries;
  - Mon–Fri workdays hard-coded (`:130`).
- **`getScopedPeriods()`** (`src/server/actions/periods.ts:447-484`): loads **every period ever**, with a per-row length query and approval labels. ≥ 6 queries, plus an unbounded payload.
- **`canApprove(facts, actorId, empId)`** (`src/server/internal/approval-rules.ts:95-105`, pure). Facts come from `loadApprovalFacts` (`:53`, 2 queries).
- **`getApprovalNotices()`** (`src/server/actions/users.ts:278`, `requireAdmin`, 5 sequential queries): `{ selfApprovalBackOn, recommendDesignee }`.
- **`getSetupStatusInternal()`** (`src/server/internal/setup.ts:22`): 6 COUNTs (B1: wrong table, counts inactive users).
- **`getContractSummaries()`** (`src/server/actions/dashboard.ts:93`, `requireAdmin`): 7 queries; per contract funded / ceiling / totalHours / priced `totalCost` / `unpricedHours`, plus CLIN and SLIN breakdowns.
- **Burn tiers are client-only** (`DashboardClient.tsx:47-51,141,152-158`): ≥ 90 red, ≥ 75 warning; remaining < 0 red, < $10k warning.
- **Workweek and pending config:** `getWorkweekStartDaySetting()` (`workspace-settings.ts:49`), `getPendingConfigChange()` (`pay-period-config.ts:109`).
- **Unpriced hours:** `getUnpricedHoursReport()` is a list (`LIMIT 501`). The contract summaries' `unpricedHours` covers the same CLIN entries.
- **Pay periods:** `configAt(db, day)` (`src/server/internal/pay-period-config.ts:33`), `getCurrentPeriodStart`, `resolvePeriod(start)` (`src/server/internal/periods.ts:130`).
- **Period rows exist only from first submission** (`periods.ts:176`) or a migration import. "Draft" is synthetic (`internal/periods.ts:46`). Statuses: `draft | submitted | approved | rejected`.
- **Supervisor scope:** `getEmployeeScope` (`src/lib/session.ts:127`), which doesn't filter `is_active`. `LATEST_REVISION` is at `src/server/internal/cost-basis.ts:117`.
- **DB pool:** `max: 10` per tenant URL, `prepare: false` (`src/db/index.ts:32-37`).

**B1 (Setup)**
- Completion = contracts, CLINs, non-admin users (including inactive ones) and **`user_assignments`** rows each > 0 (`setup.ts:31-55`).
- Direct timesheet rows come only from active `user_charge_codes` → active code, CLIN and contract (`src/server/actions/timesheet.ts:483-497`; save rule `:252-259,304-312`).
- Indirect rows: active and `available_to_all` (`:517-526`).
- Wrong copy: `SetupWizardClient.tsx:84,106,111-112,118-119,124,191-192`. There's no charge-codes step.
- Data Import's Assignments tab creates only `user_assignments` (`src/server/actions/import.ts:287-343`; `ImportClient.tsx:447`).

**B3 (Approvals)**
- `reviewScopeFrom` (`approval-rules.ts:107-121`) for a supervisor: self, anyone sharing an active CLIN (any role), and anyone who designated them.
- `canApprove`:
  - own timesheet → only an admin with self-approval available (`:80-84`);
  - others → admin always; a supervisor if effective designee, or if the other person is an employee sharing an active CLIN.
- `ApprovalsClient.tsx`:
  - Review is disabled only for drafts (`:216-227`) and ignores `canApprove`;
  - no filter; sorted by period (`:228-230`);
  - the drawer explains afterwards (`:387-407`);
  - admin filler banner at `:321-330`.
- Decision path refusals: `periods.ts:328-390`.

**B5 (SLIN)**
- `updateSlin` writes `slins.status` (`src/server/actions/slins.ts:36-55`), and nothing reads it.
- **The CLIN rule:**
  - save loads code, CLIN and contract status (`timesheet.ts:256-259`);
  - `newCellRefusal({ clinActive, … })` (`src/lib/timesheet/cell-rules.ts:23-31`) only for cells with no prior revision (`timesheet.ts:303-312`);
  - message at `:321`;
  - row sourcing filters inactive parents (`:489-496`) and re-adds codes with hours as `assignable: false` (`:555-576`);
  - grid copy "No longer assigned — you can correct existing hours, not add new ones" (`ChargeCodeCell.tsx:37`, `HourCell.tsx:106`, `ApprovalsClient.tsx:264`).
- Migration import and offline sync go through `saveTimesheetBatch` or need no SLIN check; API v1 is read-only.

## 2. Verified external facts

| Fact | Source |
|---|---|
| `next.config` `redirects()`: `permanent: true` → 308 (cached by browsers indefinitely), `false` → 307. Path-only, so the tenant host is kept; query strings pass through. Runs **before** the proxy. | `node_modules/next/dist/docs/…/redirects.md:30`; `proxy.md:202-206` |
| **Layouts don't re-render on client navigation**; `router.refresh()` re-renders the server tree, including layouts. | `layout.md:154`; `layouts-and-pages.md:43` |
| React `cache()` memoizes per request; the repo already uses it in `src/server/internal/workspace-settings.ts:2,16,31`. | repo |
| Mantine 9.3.1 `NavLink` supports nested children with `opened` / `defaultOpened` / `onChange` / `childrenOffset`. **It doesn't set `aria-expanded` or `aria-current`.** Those must be passed explicitly (verify they reach the root element). | `node_modules/@mantine/core/lib/components/NavLink/NavLink.d.ts:18-34`; `NavLink.mjs` (no aria-expanded) |
| A `'use server'` action called from a server component still runs its guard. A `requireAdmin` action called for a supervisor **throws**, so Home must branch on role before calling admin-only functions. | `src/lib/session.ts` |
| Guard-first: the guard is the first `await`, never inside `Promise.all`. | `src/__tests__/unit/server-action-guards.test.ts:465-476` |

## 3. Invariants
1. **Guards don't weaken.**
   - Every moved page keeps its own `requirePageRole(...)` as the first await.
   - `/home` requires approver.
   - Settings pages require admin.
   - Nav visibility is UX only.
2. **DCAA.** B5 only adds a refusal for **new** hours. Corrections, reason codes, the period lock, revisions and denormalization are unchanged. No existing hours are altered.
3. **Old URLs keep working** through redirects, including links in emails already sent and Stripe sessions created before deploy. Query strings (`?status=`, `?connectionId=`, `?error=`) survive.
4. **Nothing on Home reveals more than the user can already see:**
   - supervisor numbers and names are limited to their review scope. **Team status** counts active users only. The **waiting queue** includes inactive submitters, matching `canApprove` and the Approvals "Waiting" view, so the sidebar count and the list always agree;
   - money only for admins.
5. **One rule each.** The "chargeable code" predicate is shared by the timesheet and Setup, and burn tiers are shared by the Dashboard and Home.
6. Tenancy, calendar-date model (`'YYYY-MM-DD'`, workspace "today") and the UX-1 contrast rules are unchanged.

## 4. Design

### 4.1 Routes and redirects (L1)

| Old URL | New URL | Notes |
|---|---|---|
| — | `/home` | new; approver |
| `/admin/settings` | `/settings/workspace` | timezone, workweek, export (§4.4) |
| — | `/settings/pay-schedule` | pay-period configuration (§4.4) |
| `/admin/billing` | `/settings/billing` | |
| `/admin/integrations` | `/settings/integrations` | |
| `/admin/integrations/quickbooks` | `/settings/integrations/quickbooks` | |
| `/admin/integrations/gusto` | `/settings/integrations/gusto` | |
| `/admin/integrations/payroll-export` | `/admin/payroll-export` | Reports group, not Settings |
| `/admin/api-keys` | `/settings/api-keys` | |
| `/admin/import` | `/settings/import` | nav label "Data import" |
| `/admin/migration` | `/settings/migration` | nav label "Timesheet history import" (merge is UX-4) |
| `/admin/notifications` | `/profile/notifications` | |
| `/settings` | `/settings/workspace` | **config redirect only**; no `settings/page.tsx` (config redirects run before the filesystem, `redirects.md:39`) |

**Moving the pages:**
- `git mv` each page directory (page, client, CSS). Lead-verified: moved folders use only `./` sibling imports.
- **No `settings/layout.tsx`.** Add `settings/loading.tsx` copied from `admin/`, and `settings/error.tsx` as a one-line re-export: `'use client'; export { default } from '../admin/error';`. That keeps the icon ratchet unchanged. **Don't** add it to `page-metadata.test.ts`'s error-boundary list: that test asserts a `<title>` string in the file (`:52-55`). Instead, add an assertion that `settings/error.tsx` is exactly the `'use client'` re-export of `../admin/error`.
- **`BillingWall.tsx:4`** imports `./admin/billing/BillingClient`. Update it to the new path (tsc would catch it).
- **Page guards and `metadata` move with the page.** Title changes:
  - the Workspace page is titled **"Workspace"**;
  - the pay schedule page is **"Pay schedule"**;
  - Home is **"Home"**.
- `page-metadata.test.ts:34` expects `pages.length` **32** (adds `home` and `pay-schedule`).

**Redirects.** `next.config.ts` gets `async redirects()` with one entry per row, all `permanent: false` (307). The payroll-export rule comes **before** `/admin/integrations/:path*` → `/settings/integrations/:path*`. `:path*` also matches the bare `/admin/integrations` (`redirects.md:77`). Query strings pass through (`:43`).

**Internal references to update.** Do a full substring search; T1 enforces it. Lead-verified list:

| Group | References |
|---|---|
| Nav, layout, setup | AppNavbar; AppShellWrapper `:138`; `SetupWizardClient.tsx:111` |
| Billing | Stripe `billing.ts:55-56,74`; the 7 lifecycle email templates (`suspension-warning`, `suspended`, `payment-failed`, `trial-ending`, `trial-ended`, `subscription-ended`, `deletion-scheduled`) |
| Integrations | `IntegrationsClient.tsx:113,125,194,231,242`; `QBOConfigClient.tsx:208,219`; `GustoConfigClient.tsx:222,230`; `quickbooks/page.tsx:33,41`; `gusto/page.tsx:28,35` |
| Payroll export and migration | `PayrollExportClient.tsx:127` ("Back to Integrations" → "Back to reports", `/admin/reports`) and `:251`; `MigrationClient.tsx:246` |
| OAuth routes | `callback/[provider]:39`, `complete/[provider]:55,67,71,87,90`, `gusto-connect:26,45`, `qbo-connect:31,51` |
| Header and billing wall | `AppHeader.tsx:84`; `BillingWall.tsx:4` |

**Tests that reference moved paths** (lead-verified):
- `billing-ui.test.tsx:37,72-78`: **rewrite**, because Billing leaves the main nav for `SETTINGS_NAV`;
- `icon-registry.test.ts:21-31`: repoint moved allowlist paths, and **remove** the `SettingsClient.tsx` entry (`:31`). The new clients use `Icons`, and a deleted file can't be read;
- `payroll-export-client.test.tsx:22`;
- `gusto-auto-match.test.tsx:21`;
- `charge-code-cost-rules.test.ts:148`;
- `rate-schedule-ui.test.tsx:293`;
- `fix-round-1-small.test.ts:69`;
- `payroll-export-actions.test.ts:186` (repoint at the new workweek client file, §4.4);
- `integration/oauth-connect.test.ts:305`;
- `routing.test.tsx:26-38,66-70` (now mocks `@/lib/session`, §4.3).

### 4.2 Shell: navigation config, sidebar, rail, mobile, user menu

**`src/components/shell/nav-config.ts`** (pure):

```ts
export type NavRole = 'admin' | 'supervisor' | 'employee';
export type NavLeaf = { label: string; href: string; icon: keyof typeof Icons; match?: string[] };  // icon REQUIRED (rail mode)
export type NavGroup = { key: string; label: string; icon: keyof typeof Icons; children: Omit<NavLeaf, 'icon'>[] };
export type NavEntry = NavLeaf | NavGroup;
export function mainNav(role: NavRole): NavEntry[];
export const SETTINGS_NAV: NavLeaf[];
export const SETTINGS_BACK: (role: NavRole) => NavLeaf;   // "Back to the app" → landingPath(role), icon 'back'
export function activeHref(pathname: string, leaves: { href: string; match?: string[] }[]): string | null;   // longest prefix on SEGMENT boundaries: /a/b matches /a/b and /a/b/c, not /a/bc
export function isSettingsPath(pathname: string): boolean;
export function landingPath(role: NavRole): '/home' | '/timesheet';
```

**Icon keys** (`icons.ts`):
- **Reuse** existing keys: `contracts`, `users` (for the People group) and `timeEntry` (for timesheet).
- **Add** new keys: `home`, `approvals`, `reports`, `settings`, `back`, plus one per Settings leaf: `workspace`, `paySchedule`, `billing`, `integrations`, `apiKeys` (may alias the existing key icon via `ICON_ALIASES`), `dataImport`, `historyImport`.
- Any key that maps to an icon already used needs an `ICON_ALIASES` entry with a reason.
- **`AppNavbar.tsx` moves to the registry,** so remove it from `ICON_IMPORT_ALLOWLIST`.

**Menus by role:**

| Role | Main menu |
|---|---|
| Admin | Home `/home` · My timesheet `/timesheet` · Approvals `/admin/approvals` · **Contracts** ▸ Overview `/admin/dashboard`, Contracts and CLINs `/admin/contracts`, Charge codes `/admin/charge-codes`, Indirect codes `/admin/indirect-codes`, Labor categories `/admin/labor-categories` · **People** ▸ Users `/admin/users`, Assignments `/admin/assignments` · **Reports** ▸ Downloads `/admin/reports`, Payroll export `/admin/payroll-export`, Audit trail `/admin/audit-trail` · bottom: Settings `/settings/workspace` (match `/settings`) |
| Supervisor | Home · My timesheet · Approvals · **Reports** ▸ Downloads, Audit trail |
| Employee | Timesheet `/timesheet` |

`/admin/setup` isn't in any menu. `SETTINGS_NAV`: Workspace, Pay schedule, Billing, Integrations (match `/settings/integrations`), API keys, Data import, Timesheet history import.

**`AppNavbar.tsx` rewrite:**
- **Settings mode.** When `isSettingsPath(pathname)`, render `SETTINGS_BACK(role)`, a small "Settings" label (`Text`, **not a heading**, because the page has the h1), and `SETTINGS_NAV`. Otherwise render `mainNav(role)`.
- **Leaves:** `NavLink component={Link}`, `active` from `activeHref`, and `aria-current="page"` when active.
  - **`aria-label` only in rail mode,** where the label is hidden. In expanded mode the visible text is the name, so the waiting count is announced.
- **Groups:** a **childless** `NavLink component="button"` header with its own `onClick`, `aria-expanded={opened}`, `aria-controls={childrenId}` and a chevron in `rightSection`, followed by a **sibling** `<Collapse id={childrenId} expanded={opened}>` holding the child links.
  - Mantine's default root is an `<a>`, which isn't focusable without an `href`.
  - Don't use NavLink's built-in children: it toggles on Space **keydown**, and a native button also clicks on Space **keyup**, so it can toggle twice.
  - **The group containing the active href is forced open.** Its toggle does nothing and its chevron is hidden.
  - Other groups use controlled `opened` from state. The state **starts `{}`** (closed) on server and client, and `localStorage['cadenzpoint-nav-groups']` is read **in `useEffect`** after mount, so there's no hydration mismatch. It's written in the toggle handler, inside try/catch.
- **Waiting count** on Approvals:
  - expanded: a `Badge` with `aria-hidden`, plus `<VisuallyHidden>{n} waiting</VisuallyHidden>` inside the link;
  - rail: an `Indicator` on the icon, with tooltip and `aria-label` "Approvals, {n} waiting";
  - hidden when n is 0 or null.
- **Collapsed rail (desktop):**
  - leaves are icons with `Tooltip`, `events={{ hover: true, focus: true, touch: false }}`;
  - groups are a `Menu` trigger (`position="right-start"`, `aria-label` = group label), **marked active when the group contains the active href**, listing children as `Menu.Item component={Link}` with `aria-current` on the active one;
  - in Settings mode, the back link and every Settings leaf render with their (required) icons.
- **Mobile:** the Burger lives in **`AppHeader.tsx:31-37`**. Add `aria-expanded={opened}`, because Mantine's Burger doesn't set it. The label is "Open navigation" / "Close navigation".
  - `AppShellWrapper` closes the menu when `usePathname()` changes: a `useEffect` that skips the first render.

**`AppShellWrapper` and the layout:**
- **Remove the setup banner** (L2): the banner, its sessionStorage key, the `setupComplete` prop, the layout's `getSetupStatusInternal()` call, and any import left unused (`ROLE_COLOR` in `ApprovalsClient.tsx:26` after the banner goes).
- **Add `waitingCount: number | null`.** The layout adds the user's `id` to its user object and, for approvers only, computes `waitingCount = await getWaitingCount(user.id)` **inside try/catch → `null`**. An error thrown by `(app)/layout.tsx` isn't caught by `(app)/error.tsx` (same segment), so an uncaught DB error would take down every page (§6).

**`AppHeader` user menu:**
- shows full name, email and role as a word ("Admin" / "Supervisor" / "Employee");
- items: "Profile and security" → `/profile`, "Notifications" → `/profile/notifications`, divider, "Sign out" (`.danger`).

### 4.3 Landing (UX-D3)
- **`landingPath(role)`** (`nav-config.ts`) is the only source.
- **`src/app/page.tsx`:** on a workspace host, `getSessionUser()`. No user → `redirect('/login')`; otherwise `redirect(landingPath(role))`. **Call `redirect()` outside the existing `try` (`page.tsx:17-21`),** or `NEXT_REDIRECT` is swallowed and the marketing page renders. The apex branch is unchanged.
- **`LoginForm.tsx:110`:** `router.push('/')`.
- **`/home`:** `requirePageRole('approver')`, so employees fall back to `/timesheet`.
- **Setup done screen:** "Go to Home".
- **`routing.test.tsx`:** mock `@/lib/session` and update its expectations.

### 4.4 Settings area pages
- **Split `SettingsClient`** (its hooks all run regardless of what's rendered: `:73`, `:90-114` calls a server action):
  - **`WorkspaceSettingsClient`** (timezone, workweek, export). Props: `initialTimezone`, `initialWorkweekStartDay`. Page `/settings/workspace` fetches only those two and has title "Workspace", description "Applies to everyone in your workspace."
  - **`PayScheduleClient`** (current `:73-114`, `:153-190`, `:269-372`). Props: `initialConfig`, `pendingChange`. Page `/settings/pay-schedule` fetches only those, title "Pay schedule".
  - Behaviour and server actions are unchanged. New files use `Icons` (e.g. `Icons.statusSuccess`), not tabler. Delete the old `SettingsClient` once both are in place.
- **Billing, Integrations (+ QuickBooks, Gusto), API keys, Data import and Timesheet history import** move unchanged except for links.
- **Payroll export** moves to `/admin/payroll-export`. The Integrations catalog's payroll card links there.
- **Notifications** (`/profile/notifications`): the page passes the role; the "Timesheet submitted (supervisors)" switch is hidden for employees. UI only.

### 4.5 Home (`src/app/(app)/home/page.tsx`)

**Page:**
1. `await requirePageRole('approver')` first.
2. Then `getHomeData(user.id)` from **`src/server/internal/home.ts`** (`server-only`, no guard; the page authorizes).
3. Render per the mockup "Admin home". `metadata.title = 'Home'`.

**Role:** branch on **`facts.users.get(userId)`** (fresh DB facts), not the JWT role, which can be 60 s stale:
- admin → full data;
- supervisor → supervisor data;
- **anything else** (demoted to employee, or inactive, within the JWT window) → `redirect('/timesheet')` from the page before rendering. `getHomeData` returns `{ redirect: '/timesheet' }`, and the page calls `redirect()`.

A just-demoted admin sees no money.

**`getHomeData(userId)`:**
1. `facts = await loadApprovalFacts(db)`; today and the timezone (cached); `resolver = await loadScheduleResolver(db)`; **`cur = resolver.periodContaining(today)`** and `prev = resolver.neighbor(cur.start, 'prev')` (synchronous, `pay-period-config.ts:79-85`). My period and both team statuses use these same period objects.
2. `teamScope`:
   - admin → `'all'`;
   - supervisor → the people they can approve: `[...reviewScopeFrom(facts, userId)].filter(id => id !== userId && canApprove(facts, userId, id))`. `canApprove` is relational here, and status is checked elsewhere. This excludes the supervisor and peers who aren't theirs to approve.
3. One `Promise.all`:

   | Part | Role | Source |
   |---|---|---|
   | waiting | all approvers | `approvalQueue(db, userId, facts, { names: 4 })` (§4.6) |
   | myPeriod | all approvers | `currentPeriodSummary(db, userId, cur, today)` (§4.5.1) |
   | team | all approvers | `teamPeriodStatus(db, cur.start, cur.numDays, teamScope, tz)` |
   | lastTeam | all approvers | `teamPeriodStatus(db, prev.start, prev.numDays, teamScope, tz)`, **always** (any straggler is worth showing) |
   | notices | admin | `approvalNotices(db, userId, facts)` in **`src/server/internal/approval-notices.ts`**. Extract from `users.ts:278`, whose action becomes guard + call. Give `currentSelfApprovalOn` (`approval-rules.ts:219-222`) an optional `facts` parameter so the facts aren't loaded twice. |
   | contracts | admin | `contractBurnSummary(db)` in `src/server/internal/dashboard.ts`. Per contract: `fundedValue`, status, priced cost and unpriced hours, for **every** contract (any status). Cost is grouped **by `clin_id`**, rounded to the cent per CLIN, then summed and rounded, **exactly** as `getContractSummaries` does (`dashboard.ts:224-227,293-307`). Extract a shared helper used by both, so they can't drift. No SLIN breakdown. |
   | **unpricedTotal** | admin | Σ `unpricedHours` over **all** rows `contractBurnSummary` returns (any status). This equals the unpriced report the "Fix pricing" button opens. The **active-only** filter applies only to item 8 and the Contracts card, never to this total. |
   | workweekSet, pendingConfig | admin | extract internals from `workspace-settings.ts:49` and `pay-period-config.ts:109` (none exist today) |
   | overlaps | admin | `overlappingAssignments(db).length` (existing internal) |

4. Then, admin only, **after** the `Promise.all`: `setup = await getSetupStatusInternal()` (no `cache()`; the layout no longer calls it). It fires its own parallel COUNTs, so running it separately keeps the burst smaller.

**Internals must live in `src/server/internal/`.** Anything exported from a `'use server'` file becomes a public endpoint and fails `server-action-guards.test.ts:16-24`. Never add a guard to a function that takes a `userId`.

**"Needs your attention"** (ordered; each item has a title, one sentence and one button unless noted):

| # | When | Title / sentence | Button → |
|---|---|---|---|
| 1 | waiting.count > 0 | "{n} timesheet(s) waiting for your approval" + up to 4 names ("and {k} more") + oldest period label | Review → `/admin/approvals` |
| 2 | lastTeam: anyone in notStarted, inProgress or returned | "{n} people haven't submitted {last period label}" + up to 5 names | none (informational) |
| 3 | admin, unpricedTotal > 0 | "{hours} hours have no labor-category rate" / "None is set, or the assignments overlap, so contract costs leave them out." | Fix pricing → `UNPRICED_REPORT_HREF` |
| 4 | admin, notices.recommendDesignee or selfApprovalBackOn | "You approve your own timesheets" / existing notice wording | Choose a reviewer → `/admin/users` |
| 5 | admin, !setup.isComplete | "Finish setting up: {done} of {total} done" / next missing step's one-liner | Continue → `/admin/setup` |
| 6 | admin, workweek not set | "Payroll workweek isn't set" / "Payroll export stays off until you set it." | Set workweek → `/settings/workspace` |
| 7 | admin, pendingConfig | "Pay schedule changes on {date}" | View → `/settings/pay-schedule` |
| 8 | admin, active contracts at Watch or above (not `noFunding`) | "{n} contract(s) need a look" / names with tier words | Open overview → `/admin/dashboard` |
| 9 | admin, overlaps > 0 | "{n} overlapping labor-category assignments" | Review → `/admin/labor-categories` |

No items: "You're all caught up."

**Side column:**
- **"Your timesheet":**
  - period label, status word and due date;
  - a mini cadence (one cell per day; bar = min(hours / 8, 1); weekends blank; today outlined; `aria-hidden`);
  - a text summary "{hours} hours entered. {workdaysFilled} of {workdaysSoFar} workdays so far are filled in.";
  - "Open timesheet".
- **"This pay period":** Submitted / In progress / Not started counts for the current period. "Returned" is folded into In progress, with "(n returned)" when > 0.
- **Admin "Contracts"** (active contracts, excluding `noFunding`): the top 5 by burn %, showing name, funded, **"priced cost"**, burn bar plus tier word, and `unpricedHoursLabel(h)` per contract when h > 0. `CURRENT_RATES_NOTE` sits under the card. This follows the CO-D17/CO-D7 labelling rule (`src/lib/cost-labels.ts:1-5`). Add the Home files to the static checks in `cost-basis.test.ts:216-237`.

#### 4.5.1 My period (`src/server/internal/employee-dashboard.ts`, new)
- Move the period computation out of the action into **`currentPeriodSummary(db, userId, period, today)`**, where `period` is the resolved current period. The action resolves it itself; Home passes `cur`. The action (`employee-dashboard.ts`) becomes guard + call + recent periods.
- Change the hours query (`:85-107`) to `GROUP BY entry_date` over latest revisions, and return `dailyHours: Record<'YYYY-MM-DD', number>`. Derive:
  - `totalHoursEntered`;
  - `daysWithEntries`: days with hours > 0. This fixes the zero-hour bug;
  - **`workdaysFilled`**: Mon–Fri, ≤ today, hours > 0, so the sentence can't read "6 of 5".
- `TimesheetDashboard` output is unchanged except the corrected day count.

#### 4.5.2 `teamPeriodStatus(db, start, numDays, scope, tz)` (`src/server/internal/team-period-status.ts`)
One round trip with `db.select` (`ReadDb` has no `execute`, `db/index.ts:17`). `h` includes **all** hours (direct and indirect), because any recorded time means the person has started:
```ts
const endExcl = addDays(start, numDays);                    // 'YYYY-MM-DD' strings
const hrs = db.select({ userId: timesheetEntries.userId, h: sql<string>`SUM(CAST(${timesheetEntries.hours} AS NUMERIC))`.as('h') })
  .from(timesheetEntries)
  .where(and(gte(timesheetEntries.entryDate, start), lt(timesheetEntries.entryDate, endExcl), LATEST_REVISION))
  .groupBy(timesheetEntries.userId).as('tps_hrs');       // unique alias (dated-rates trap T16)
const rows = await db.select({ id: users.id, name: users.fullName, role: users.role, status: timesheetPeriods.status, h: hrs.h })
  .from(users)
  .leftJoin(timesheetPeriods, and(eq(timesheetPeriods.userId, users.id), eq(timesheetPeriods.periodStart, start)))
  .leftJoin(hrs, eq(hrs.userId, users.id))
  .where(and(eq(users.isActive, true),
    sql`(${users.createdAt} AT TIME ZONE ${tz})::date <= ${periodEnd}`,
    scope === 'all' ? undefined : inArray(users.id, scope)));
```
Details:
- The `created_at` rule means people created after the period ended aren't expected (`users.created_at` is timestamptz, `schema.ts:42`). `tz` is the workspace timezone string; `periodEnd` is a `'YYYY-MM-DD'` string (never a raw `Date` in `sql`).
- `scope === 'all' ? undefined : inArray(users.id, scope)`. `inArray` with `[]` renders `false` in drizzle 0.45.2 (lead-verified), giving zero rows.
- **Expected submitters (UX2-Q1):** role in `EXPECTED_SUBMITTER_ROLES` (`['employee', 'supervisor']`), or an admin with `h > 0` or a period row.
- **Buckets:**

  | Bucket | Rule |
  |---|---|
  | submitted | status `submitted` or `approved` |
  | returned | status `rejected` |
  | inProgress | no row or `draft`, and h > 0 |
  | notStarted | no row or `draft`, and h null or ≤ 0 |

- Returns counts and names per bucket, sorted by name.

#### 4.5.3 Shared burn tiers (`src/lib/ui/burn.ts`)
- **`burnPercent(cost, funded)`:** `Math.round(cost / funded * 100)` (rounded **before** tiering, as the dashboard does today, `DashboardClient.tsx:154`); 0 when funded ≤ 0 or null.
- **`burnTier(pct, funded, remaining)`:**

  | Condition | Tier | Label |
  |---|---|---|
  | funded null or ≤ 0 | `noFunding` | "No funding set" |
  | remaining < 0 | `overFunding` | "Over funding" |
  | pct ≥ 90 | `nearLimit` | "Near limit" |
  | pct ≥ 75 | `watch` | "Watch" |
  | otherwise | `onTrack` | "On track" |

- **`remainingWarning(remaining)`:** true when 0 ≤ remaining < 10,000. This keeps the dashboard's existing warning (`:141`).
- **Exports:** `BURN_TIER_LABEL` and `BURN_TIER_COLOR`.
- **`DashboardClient`** uses these, adding tier words next to the bar. Otherwise visuals are unchanged.

### 4.6 Approvals as a to-do list (B3) and the waiting count

**`src/server/internal/approval-queue.ts`:**

```ts
export async function approvalQueue(db, actorId: string, facts, opts?: { names?: number }): Promise<{ count: number; names: string[]; oldestPeriodLabel: string | null }>;
export const getWaitingCount: (actorId: string) => Promise<number>;   // React cache() keyed on the actorId STRING; loads db + facts inside
```

- **Query:** `SELECT tp.id, tp.user_id, tp.period_start, tp.period_num_days, tp.submitted_at, u.full_name … WHERE tp.status = 'submitted' ORDER BY tp.submitted_at ASC NULLS LAST`.
- **Filter** with `canApprove(facts, actorId, user_id)`.
- **`oldestPeriodLabel`** uses `period_num_days`, or `existingPeriodLength` when null.
- **`names`** are de-duplicated by person; "and {k} more" counts people.
- **No `is_active` filter,** so the count matches `canApprove` and the Approvals view (invariant 4).
- `cache()` compares arguments by identity, so key only on the string. Home calls `approvalQueue` with its own facts, and the layout calls `getWaitingCount`.

**`ApprovalsClient`:**
- **A `SegmentedControl`:**

  | Option | Shows |
  |---|---|
  | **"Waiting for you ({n})"** (default) | rows with `row.canApprove` |
  | "Decided" | `approved` or `rejected` |
  | "Everything" | every row except `draft` |

  - Use **controlled `state.sorting`**, reset on view change: Waiting → `submittedAt` asc; the others → `periodStart` desc. The current `initialState.sorting` (`:228-230`) would override any pre-sorted data.
  - Empty Waiting state: "Nothing is waiting for you."
- **Row action:**
  - `canApprove` → visible "Review" button;
  - otherwise "View" (the drawer opens read-only; existing decision gating still applies).
- **Reason chip** only when `status === 'submitted' && !canApprove` (§5):

  | Case | Chip |
  |---|---|
  | own period, non-admin | "Your own — needs another approver" |
  | own period, admin without self-approval | "Your own — another admin or designee approves" |
  | other people | "Approved by an admin or their designee" |

  Decided rows have no chip.
- **Remove** the admin filler banner (`:321-330`). `ApprovalNotices` on `page.tsx` stays.
- **Scope sentence** (supervisors only), plain text with correct plurals: "You review {n} {person/people} on {m} {CLIN/CLINs}", plus "and {k} {person/people} who designated you" when k > 0.
- **After a decision:** keep the existing local `getScopedPeriods()` refetch (updates the table) **and** call `router.refresh()` (updates the sidebar count). Paginating the double load is backlog.
- **"Worth a look"** (Waiting view): internal `periodFlags(db, rows)` in `src/server/internal/period-flags.ts`, one grouped query over `timesheet_entries` for the decidable rows' users and date ranges, `source = 'app'`:

  | Flag | Rule |
  |---|---|
  | `corrections` | revision > 1 |
  | `lateEntries` | revision = 1 and `change_reason_code IS NOT NULL`. Lead-verified: a reason is stored only when `edit || late`, `timesheet.ts:347-349,378`, so on revision 1 it means late. |
  | `resubmitted` | `submission_count > 1` |

  `getScopedPeriods` adds `submissionCount` to its select (not selected today, `periods.ts:455-466`), calls `periodFlags` only for `canApprove` rows, and adds `flags`. Chips: "{n} correction(s)", "{n} late entr(y/ies)", "Resubmitted", in `warning` tone; otherwise "Nothing unusual" (dimmed).

### 4.7 Setup Wizard (B1)
1. **`src/server/internal/chargeable.ts`** exports `CHARGEABLE_CODE`: the where-fragment over the already-joined `charge_codes`, `clins`, `contracts` and left-joined `slins`. Code active, CLIN active, contract active, and (§4.8) SLIN null or active.
   - **Row sourcing** (`timesheet.ts:489-496`) and the **Setup counts** use it.
   - **The save path keeps its `newCellRefusal` booleans** (`clinActive`, plus the new `slinActive`), which are computed per cell. T16 checks both.
2. **`getSetupStatusInternal()`** counts:

   | Count | Rule |
   |---|---|
   | indirect codes | active and `available_to_all` |
   | contracts | active |
   | CLINs | active |
   | chargeCodes | pass `CHARGEABLE_CODE` |
   | laborCategories | active |
   | employees | active, role ≠ admin |
   | employeesWithAccess | distinct active non-admin users with ≥ 1 active `user_charge_codes` row on a code passing `CHARGEABLE_CODE` (matches what makes a direct row appear; lead-verified) |

   - `isComplete = contracts > 0 && clins > 0 && chargeCodes > 0 && employeesWithAccess > 0`.
   - Returns `steps: { key, done, required }[]` (7 steps) and `done` / `total`.
   - **No `cache()` wrapper.** The existing guarded action `getSetupStatus` (`actions/setup.ts:10`, allowlisted in `server-action-guards.test.ts:178`) is unchanged except for its new return shape.
3. **`SetupWizardClient`**, steps in order:
   1. Indirect codes (recommended)
   2. Contracts
   3. CLINs
   4. **Charge codes:** "Charge codes are what employees log time against. Each one belongs to a CLIN." Buttons: Go to charge codes; Create one per CLIN (`autobridgeChargeCodesFromClins`).
   5. Labor categories (recommended)
   6. Employees (Users and Data import, people only)
   7. **Charge code access:** "Give each employee the charge codes they may use. {n} of {m} employees have at least one." → `/admin/assignments`.

   - Fix the copy at `:84,106,111-112,118-119,124,191-192`.
   - Done screen: "Setup complete", with "Go to Home" and "Open timesheet".
4. **Data Import Assignments tab:** relabel "CLIN assignments (approval scope)", with the note "This doesn't give anyone charge codes. Use Assignments → Charge code access for that." Behaviour is unchanged.

### 4.8 Deactivated SLIN blocks new time (B5)
1. `src/lib/timesheet/cell-rules.ts`: add `slinActive: boolean` to the charge variant, and refuse new hours unless it's true.
2. `timesheet.ts:256-259`: left-join `slins` on the code's `slin_id`; select `slinStatus`. Pass `slinActive: state.slinStatus == null || state.slinStatus === 'active'` (`:305-312`).
3. **Message** (`:321`): "This charge code is no longer active (or its CLIN, SLIN or contract isn't), so new hours can't be added on {date}. You can correct hours already recorded on it."
   - **The save stays all-or-nothing** (`:208-211`): one refusal rejects the whole batch and writes nothing, the same as CLINs today.
4. **Row sourcing** (`:489-496`) uses `CHARGEABLE_CODE`. `getChargeCodesForEmployee` already left-joins `slins` (lead-verified), so codes without a SLIN are unaffected. Codes with hours re-appear as `assignable: false` via `:555-576`.
5. **Grid copy:** "Closed to new hours — you can correct existing hours" (`ChargeCodeCell.tsx:37`, `HourCell.tsx:106`, `ApprovalsClient.tsx:264`).
6. **Admin:** reactivation info includes SLIN status (`charge-codes.ts:169-176`, copy `ChargeCodesClient.tsx:362`). The SLIN deactivate confirm (`ContractsClient.tsx:631`) uses the CLIN wording. Update `contracts-clin-deactivate.test.tsx:7`.
7. **Takes effect on deploy** for SLINs that are already `inactive` or `closed` (`schema.ts:15`; `updateSlin` has been writing the status with no effect). §10 adds a read-only pre-deploy query and a release note.

## 5. State tables

**Navigation group open state**

| State | Event | Next state |
|---|---|---|
| closed | user toggles | open; stored true |
| open | user toggles, and group doesn't contain the active route | closed; stored false |
| open, contains the active route | user toggles | stays open (can't close the active group); no store change |
| any | navigate into the group | open (forced while active) |
| any | navigate out | returns to the stored value |
| rail mode | click group icon | flyout menu opens; Esc / select → closes, focus returns to icon |

**Approvals row**

| Period status | canApprove | Waiting view | Everything view | Action |
|---|---|---|---|---|
| draft (rare) | false | hidden | hidden | — |
| submitted | true | shown | shown | Review (decide) |
| submitted | false | hidden | shown | View + reason chip |
| approved / rejected | false | hidden | shown (also in Decided) | View |

**Team-status buckets:** as in §4.5.2 (every combination of row status × hours is covered: `submitted`/`approved` → submitted; `rejected` → returned; none/`draft` × h > 0 → inProgress; none/`draft` × h ≤ 0 or null → notStarted).

**Setup completion:** `isComplete` true iff all four required counts are > 0. Removing the last access, or deactivating the last chargeable code, flips it back to false, and Home shows the item again.

## 6. Failure modes

| Case | Behaviour |
|---|---|
| Old bookmark or email link (`/admin/billing?status=success`) | 307 to `/settings/billing?status=success`, same host |
| Stripe session created before deploy returns to the old URL | redirect handles it |
| OAuth | Provider callback URLs (`/api/integrations/callback/...`) are unchanged. Post-connect UI redirects are updated in code; the rule covers stragglers. |
| Supervisor opens `/settings/*`; employee opens `/home` | page guard → `/timesheet` |
| `getWaitingCount` throws in the layout | caught → `null` (no badge); the page renders normally |
| Home query fails | `(app)/error.tsx` renders. Admin parts never run for supervisors (role from facts). |
| Team status on day 1 of a period | current-period counts are mostly "Not started" (expected); `lastTeam` shows the previous period's stragglers |
| A user created after the previous period ended (e.g. a newly onboarded workspace) | not counted for that period (`created_at` rule) |
| Pay-schedule change between periods | the previous period comes from `loadScheduleResolver().neighbor(..., 'prev')` |
| A save that mixes a new cell on a closed SLIN with a valid correction | **The whole save is refused** with the B5 message and nothing is written (all-or-nothing, `timesheet.ts:208-211`). The user removes the new cell and saves the correction. |
| **Deploy:** SLINs already `inactive` or `closed` with active assigned codes | Their codes immediately close to new hours, and Setup may flip back to incomplete. The pre-deploy query (§10) lists them per tenant; release note. |
| Contract with no funded value, or a closed contract | `noFunding` tier and excluded from Home (item 8 and card); closed contracts excluded from Home |
| `localStorage` unavailable | groups stay "closed unless active" (try/catch); no error |
| Waiting count stale after a decision in another tab | updates on the next refresh or hard load (accepted) |
| Two approvers decide the same period | unchanged (conditional update on `status = 'submitted'`) |

## 7. Platform limits
- **Home:** about 13–16 tenant queries per render. The main `Promise.all` holds about 12 small queries; the setup COUNTs run after it. The postgres-js pool (`max: 10`) **queues** beyond 10, so the cost is latency, not errors.
- **Layout:** for approvers, +3 small queries (`getWaitingCount`) and −6 (setup counts).
- **Redirects** are config-level.
- **`getScopedPeriods`** stays unbounded (backlog); `periodFlags` is bounded to decidable rows.

## 8. Blast radius

| Area | Files |
|---|---|
| Routes | `git mv` of `admin/{billing, integrations (+children), api-keys, import, migration, notifications}` and `integrations/payroll-export`; `admin/settings` → `settings/workspace` with **`SettingsClient` split** into `WorkspaceSettingsClient` + `settings/pay-schedule/PayScheduleClient`; new `home/`, `settings/{error (re-export), loading}`; `next.config.ts` |
| Links | everything in §1 "Links to moving routes": Stripe actions, 7 email templates, OAuth routes, integration clients, SetupWizard, MigrationClient, AppShellWrapper, AppHeader |
| Shell | `nav-config.ts` (new), `AppNavbar.tsx` (off the icon allowlist), `AppShellWrapper.tsx`, `AppHeader.tsx` (Burger `aria-expanded`), `(app)/layout.tsx`, `icons.ts` (new keys + aliases), `BillingWall.tsx:4` (import path) |
| Landing | `src/app/page.tsx`, `LoginForm.tsx` |
| Home | `home/page.tsx` (+ client), `src/server/internal/{home, team-period-status, approval-queue, approval-notices, employee-dashboard, dashboard, workspace-settings, pay-period-config}.ts` (internals only), `src/server/actions/{employee-dashboard, users, workspace-settings, pay-period-config}.ts` (become guard + internal call), `approval-rules.ts` (`currentSelfApprovalOn` optional facts), `src/lib/ui/burn.ts`, `DashboardClient.tsx`, `cost-basis.test.ts` (static label checks cover Home) |
| Approvals | `ApprovalsClient.tsx`, `periods.ts` (`getScopedPeriods` adds flags), `src/server/internal/period-flags.ts` |
| Setup | `setup.ts`, `SetupWizardClient.tsx`, `chargeable.ts` (new), `timesheet.ts` (use the predicate), `ImportClient.tsx` (label) |
| SLIN | `cell-rules.ts`, `timesheet.ts`, `ChargeCodeCell.tsx`, `HourCell.tsx`, `ApprovalsClient.tsx`, `charge-codes.ts`, `ChargeCodesClient.tsx` (reactivation copy), `ContractsClient.tsx` |
| Tests | the moved-path tests listed in §4.1; `page-metadata.test.ts` (32 pages, error-boundary list); `grid-corrections` (unit + integration); `certified-small-items.test.ts:49`; `contracts-clin-deactivate.test.tsx:7`; `routing.test.tsx` |
| Seeder | `scripts/seed-full.ts:84-93`: backdate demo users' `createdAt` to 90 days ago, so `lastTeam` has data on the demo (no schema change) |
| Not touched | schema and migrations (no DB change), crons, API v1, auth config |

## 9. Required test matrix (each fails without its change; record a break-it for each)

| ID | Test | Scenario | Break-it |
|---|---|---|---|
| T1 | `unit/route-moves.test.ts` | **Plain substring scan** of `stripComments(src)` for the **11 `/admin/...` old paths** in §4.1 (not `/settings`, which is a substring of every new path; the `/settings` rule is checked only in the `redirects()` assertions), across `src/**` (excluding `src/__tests__/**`) and `scripts/**`: zero hits outside `next.config.ts`. Template literals like `` `${appUrl}/admin/billing` `` are caught. Import `next.config.ts` and `await (default).redirects()`: every §4.1 row is present, payroll-export comes before the integrations wildcard, and all are `permanent: false`. | leave `/admin/billing` in one email template; or swap the rule order |
| T2 | `unit/nav-config.test.ts` | `mainNav(role)` per the §4.2 table. Every top-level leaf and `SETTINGS_NAV` item has an icon. `activeHref` is longest-prefix on segment boundaries (`/settings/integrations/gusto` → Integrations; `/admin/payroll-export` → Payroll export; `/admin/users-x` doesn't match `/admin/users`). `isSettingsPath`, `landingPath`, `SETTINGS_BACK`. | exact-match `activeHref` |
| T3 | `unit/app-navbar.test.tsx` (jsdom) | **Group header `tagName === 'BUTTON'`** and childless; clicking toggles `aria-expanded` exactly once; `aria-controls` points at the sibling Collapse. The active group is open and its toggle does nothing. Active leaf has `aria-current="page"`. Leaves have no `aria-label` in expanded mode. Approvals link **text contains "3 waiting"**; no badge when 0. Settings path renders the back link + `SETTINGS_NAV` and no heading. **Rail mode:** group flyout lists children; group icon active for a child route; Settings leaves render icons on `/settings/*`; Approvals indicator labelled "Approvals, 3 waiting". **Static:** `localStorage` is read only inside `useEffect` (and written in the toggle handler). axe clean on `document.body`. | drop `component="button"`; or read `localStorage` in `useState` |
| T4 | `unit/app-shell-mobile.test.tsx` (jsdom; mocks `next-auth/react`, `SyncStatusIndicator`, a mutable `usePathname`; `installDomStubs()`) | the Burger's `aria-expanded` flips to true on click; a pathname change sets it back to false; the first render doesn't toggle | remove the pathname effect |
| T5 | `unit/header-menu.test.tsx` | open the menu (query `document.body`): "Profile and security", "Notifications" → `/profile/notifications`, "Sign out"; role shown as a word | old labels |
| T6 | `unit/landing.test.ts` + updated `routing.test.tsx` (mock `@/lib/session`) | workspace host: admin → `/home`, supervisor → `/home`, employee → `/timesheet`, no session → `/login`; `redirect` isn't swallowed by the `try`. Static: `LoginForm` pushes `'/'`. | always `/timesheet`; or redirect inside the `try` |
| T7 | `integration/approval-queue.test.ts` | supervisor: excludes own, peer-supervisor and admin periods; includes designators' and shared-CLIN employees'. Admin: all others, own only when self-approval is available. Only `submitted`. Oldest first, null `submitted_at` last. `getWaitingCount` equals `approvalQueue().count`. **A deactivated employee's submitted period is counted.** Names de-duplicated. | drop the `canApprove` filter; or add an `is_active` filter |
| T8 | `integration/team-period-status.test.ts` | buckets incl. a cleared cell → notStarted; rejected → returned; an inactive user excluded; **a user created after the period end excluded** (set `createdAt` explicitly; `createTestUser` defaults to now); a supervisor's `teamScope` excludes self and peers; an admin with no hours excluded and one with hours included; a mid-period hire counted; a pay-schedule change gives the previous period its own length | drop the `created_at` rule; or the `is_active` filter |
| T9 | `integration/home-data.test.ts` (`vi.mock` with `importOriginal`, not `spyOn`) | supervisor: no admin parts run, and names are limited to `teamScope`. Admin: every attention item fires on a seeded fixture; a clean fixture (**two active admins or a designee**, so `recommendDesignee` doesn't fire) gives "all caught up". **Unpriced:** seed a corrected cell (revision 2), a conflict and a cleared cell; assert `unpricedTotal` = Σ `unpricedEntries(db, {}).rows.hours`, and each contract's priced cost and unpriced hours equal `getContractSummaries()`. Seed an unpriced entry on an **inactive** contract and assert it's in `unpricedTotal`. Seed a contract with **2 CLINs with sub-cent products** (e.g. 0.25 h × 123.45) and assert cost equality with `getContractSummaries()` to the cent. A just-demoted admin (JWT admin, DB supervisor) sees no money. A user demoted to employee gets `{ redirect: '/timesheet' }`. | drop `LATEST_REVISION`; filter `unpricedTotal` to active contracts; round once per contract; or branch on the JWT role |
| T10 | `unit/home-page.test.tsx` (jsdom) | attention items render; mini cadence `aria-hidden` with its text summary ("{workdaysFilled} of {workdaysSoFar}"); team counts; contracts card says "priced cost", shows unpriced labels and `CURRENT_RATES_NOTE`, tier words; empty state "You're all caught up."; axe clean. Home files added to the `cost-basis.test.ts:216-237` static label checks. | label the figure "spent" |
| T11 | `unit/burn.test.ts` | rounding first (74.6 → 75 → Watch; 74.4 → 74 → On track); 89.5 → 90 → Near limit; remaining < 0 → Over funding; funded null or 0 → noFunding (never Over funding); `remainingWarning` at 9,999 / 10,000; `DashboardClient` imports `burnTier` (static) | treat funded 0 as Over funding |
| T12 | `unit/approvals-client.test.tsx` (jsdom; mock `next/navigation`) | default "Waiting for you (n)" shows only `canApprove` rows, oldest submitted first (controlled sorting); "Everything" shows non-draft rows; a submitted row with `!canApprove` shows "View" + the correct chip for each case; **an approved row shows no chip**; a decision calls `router.refresh()`; admin banner gone; flags render; empty Waiting copy | default to "Everything"; or a chip on decided rows |
| T13 | `integration/period-flags.test.ts` | corrections, late entries (revision 1 + reason), resubmitted; `source = 'migration'` excluded; only for decidable rows | key on the `'LATE_ENTRY'` code |
| T14 | `integration/setup-status.test.ts` | B1 repro (contract + CLIN + employee + CLIN assignment, no charge-code access) → incomplete; one active employee with an active chargeable code → complete; inactive employee or code → incomplete; inactive SLIN on the only code → incomplete; distinct counting | count `user_assignments` |
| T15 | `unit/setup-wizard.test.tsx` | 7 steps in order, new copy (no "CLINs are the charge codes"), "Create one per CLIN" calls `autobridgeChargeCodesFromClins`, done screen → Home | old copy |
| T16 | `unit/chargeable.test.ts` (static) | `getChargeCodesForEmployee` (row sourcing) and `setup.ts` import `CHARGEABLE_CODE`; the save path passes `slinActive` to `newCellRefusal` | inline the predicate in `setup.ts`; or omit `slinActive` |
| T17 | `integration/grid-corrections.test.ts` (extend) | SLIN deactivated: new day refused (`/no longer active/` + "SLIN"); correction with reason succeeds; **mixed batch (new cell on the closed SLIN + a correction) → refused and zero rows written**, then the correction alone succeeds; code listed `assignable: false`; SLIN reactivated → new day allowed | remove the `slinActive` check |
| T18 | `unit/grid-corrections.test.ts` (extend) | `newCellRefusal` with `slinActive` false refuses, true allows; mocks gain `slinStatus` (also `certified-small-items.test.ts:49`) | ignore `slinActive` |
| T19 | `unit/settings-pages.test.tsx` | render `WorkspaceSettingsClient` (timezone, workweek, export, no pay periods, no `getValidScheduleChangeDates` call) and `PayScheduleClient` (pay periods only); both pages call `requirePageRole('admin')` first (static); titles "Workspace" and "Pay schedule" | render the old combined client |
| T20 | `unit/notifications-page.test.tsx` | employee: no supervisors-only switch; supervisor: switch shown | always show it |
| T21 | `integration/employee-dashboard.test.ts` | `dailyHours` per date; `daysWithEntries` ignores a 0-hour cell; `workdaysFilled` ignores weekend hours and days after today | `COUNT(DISTINCT entry_date)` |

## 10. Verification
```bash
npx tsc --noEmit && npm run lint && npm run test && npm run test:tz && node --import tsx scripts/check-migration-safety.ts
```
**Product owner** (each separately):
```bash
REQUIRE_CONTROL_PLANE_TESTS=1 CONTROL_PLANE_DATABASE_URL="$(grep -h '^CONTROL_PLANE_DATABASE_URL=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" ENCRYPTION_KEY="$(grep -h '^ENCRYPTION_KEY=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" TZ=America/New_York npm run test:integration
```
```bash
npm run build && node scripts/check-build-trace.mjs
```
```bash
npm run demo:local && npm run demo:local
```

**Pre-deploy, read-only, per tenant** (B5 takes effect immediately for SLINs already inactive): list SLINs not `active` that have active charge codes assigned to someone. Run it in a read-only SQL session against **your local DB**. In production, it runs during the staging rehearsal:
```sql
SELECT s.slin_number, s.status, cc.code, COUNT(DISTINCT ucc.user_id) AS users
FROM slins s JOIN charge_codes cc ON cc.slin_id = s.id AND cc.is_active
JOIN user_charge_codes ucc ON ucc.charge_code_id = cc.id AND ucc.is_active
WHERE s.status <> 'active' GROUP BY 1,2,3;
```

**Browser checks** (`acme.localhost:3000`; password `Password123!`):
1. **As admin,** sign in → you land on **Home**.
   - "Needs your attention" shows waiting approvals, unpriced hours, the reviewer notice and any setup item.
   - "Your timesheet" shows the cadence.
   - Contracts show tier words.
2. **Sidebar:** Home, My timesheet, Approvals with a count, then Contracts, People and Reports groups that open and close. Settings is at the bottom.
   - Open Charge codes: the Contracts group stays open and Charge codes is highlighted.
   - Reload: your open/closed choices are remembered.
   - **Keyboard:** Tab to a group. Space and Enter each toggle it **once**. Check in Chrome and Safari (Firefox too if you have it).
3. **Settings:** the sidebar swaps to the Settings list with "Back to the app". Workspace and Pay schedule are separate pages. Billing, Integrations (open QuickBooks: Integrations stays highlighted), API keys, Data import and Timesheet history import all load.
4. **Old URLs redirect:** paste `/admin/billing`, `/admin/settings`, `/admin/integrations/quickbooks`, `/admin/integrations/payroll-export`, `/admin/notifications`. Each lands on its new page.
5. **Collapsed rail:** collapse the sidebar; hovering or tabbing to an icon shows its label; clicking the Contracts icon opens a menu of its pages.
6. **Phone width** (or a narrow window): open the menu, tap a page → the menu closes.
7. **User menu:** shows Profile and security, Notifications, Sign out; role as a word.
8. **As `sarah.wilson@cadenzpoint.dev`** (supervisor), land on Home: waiting approvals (only people Sarah can decide) and team status for her scope, no money.
   - Approvals opens on "Waiting for you"; **Sarah's own timesheets are not there**.
   - "Everything" shows them with "View" and "Your own — needs another approver".
   - Approve one: the sidebar count drops.
9. **As `jane.smith@cadenzpoint.dev`** (employee): land on Timesheet; the sidebar shows only Timesheet. `/home` sends you back to Timesheet.
10. **Setup:** as admin, open `/admin/setup`. There are 7 steps including Charge codes and Charge code access. On the seeded demo it's complete. To test the bug repro, use a **throwaway tenant only**, never acme/globex/initech.
11. **SLIN:** Contracts → Manage CLINs and SLINs → deactivate a SLIN that has a charge code an employee uses.
    - As that employee, the row shows "Closed to new hours — you can correct existing hours".
    - A new day can't be entered; an existing day can be corrected with a reason.
    - Reactivate the SLIN.

## 11. Known traps
- **T-A** A `requireAdmin` action called during a supervisor's Home render throws. Call internals, not actions, and branch on the role from facts.
- **T-B** Guard-first: `requirePageRole` is the first await on every page. Never put it inside `Promise.all`.
- **T-C** In `redirects()`, the specific rule comes before the wildcard. Use `permanent: false`, because a 308 is cached forever. Don't also add a page for `/settings`: config redirects run first.
- **T-D** Layouts don't re-render on client navigation. The badge updates via `router.refresh()`. An error thrown in `(app)/layout.tsx` isn't caught by `(app)/error.tsx`, so wrap the waiting count.
- **T-E** Mantine `NavLink` renders an `<a>` and sets no `aria-expanded` / `aria-current`. Groups need `component="button"` plus explicit aria attributes.
- **T-F** Never pass a raw `Date` into a drizzle `sql` template; dates and the timezone are strings.
- **T-G** `getEmployeeScope` reloads facts and includes peers and self. Use `reviewScopeFrom(facts, id)` filtered by `canApprove` for `teamScope`.
- **T-H** Period rows exist only after a first submission.
- **T-I** The pool is `max: 10`, and it queues. Run setup's COUNTs after the main `Promise.all`.
- **T-J** `git mv` the page directories. Update the icon allowlist (repoint paths, remove `SettingsClient.tsx`), `page-metadata` (32 pages; `settings/error.tsx` asserted as a re-export, **not** in the title list) and the moved-path tests in the same commit.
- **T-K** `settings/error.tsx` is a re-export of `admin/error`, so it doesn't grow the icon allowlist.
- **T-L** Never use the demo tenants (acme, globex, initech) for destructive or bug-repro tests.
- **T-M** Exports from `'use server'` files are public endpoints. New internals go in `src/server/internal/`.
- **T-N** React `cache()` compares arguments by identity; key on primitive strings only.
- **T-O** `localStorage` is read in `useEffect` only; a `useState` initializer causes a hydration mismatch.
- **T-P** `redirect()` must not sit inside a `try` that catches everything (`src/app/page.tsx:17-21`).
- **T-Q** The timesheet save is all-or-nothing; don't make the SLIN refusal per cell.

## 12. Dev-agent hand-off rules
Follow `BLUEPRINT-STANDARD.md` §3.
1. **Impact analysis first.** Stop and ask if anything in §1 or §4 doesn't match the code, or if UX2-Q1 / Q2 seem wrong.
2. **Commit order** (each with its tests):
   1. §4.8 SLIN + §4.7 Setup (T14–T18): the server rules first;
   2. §4.1 routes + redirects + link updates + §4.4 (T1, T19, T20);
   3. §4.2 shell + §4.3 landing (T2–T6);
   4. §4.6 approvals + count (T7, T12, T13);
   5. §4.5 Home + burn + employee-dashboard extraction (T8–T11, T21).

   `/home` links (setup done screen, landing, nav) may land before commit 5; the app is only fully consistent after it, so don't ship partial commits. **The layout's `getWaitingCount` wiring belongs to commit 4,** together with `approval-queue.ts`. Commit 3 renders the badge from a `waitingCount` prop that is `null` until then.
3. **Don't push.** Report the break-its (mutation plus failing test), every pre-existing test changed and why, the lint warning count, and what you couldn't run.

## 13. Pre-mortem record

**Round 1 (2026-10-27).** Two reviewers (routes/shell/UI; server/data) raised 10 HIGH, 15 MEDIUM and about 17 LOW findings. The lead verified the HIGHs in the source:
- `NavLink` renders an `<a>`;
- the `SettingsClient` props and hooks;
- `BillingWall`'s import;
- the 30-page count;
- the all-or-nothing save;
- nullable `fundedValue`.

All are fixed in v2:
- group buttons;
- `localStorage` read in an effect;
- the Settings split into two clients;
- no `settings/page.tsx`, and 32 pages;
- `BillingWall` and the moved-path test list;
- the B5 batch semantics;
- the `noFunding` tier, with active contracts only;
- the `created_at` rule;
- a real unpriced cross-check;
- the CO-D17 labels on Home.

MEDIUM fixes:
- icon keys and the allowlist;
- rail icons and active state;
- the badge accessible name;
- layout try/catch;
- `cache` keyed on a string;
- chips only on submitted rows;
- controlled sorting;
- T1 as a substring scan;
- Burger location;
- internals placement;
- `teamScope`;
- `workdaysFilled`;
- a deploy note for B5;
- `lastTeam` always shown;
- parallelism.

**Round 2 (2026-10-27).** One fresh reviewer read v2 in full. Result: 1 HIGH, 10 MEDIUM, 10 LOW, all fixed in v3.
- **HIGH:** `unpricedTotal` is defined over all contracts, so it matches the report it links to.
- **MEDIUM:**
  - name consistency (`approvalQueue`);
  - no setup `cache()`, which would have collided with an existing action name;
  - `settings/error.tsx` assertion;
  - T1 scans only `/admin` paths;
  - `cur` and `prev` resolved first;
  - per-CLIN rounding via a shared helper;
  - waiting queue includes inactive submitters (invariant 4 clarified);
  - team query written out;
  - group header as a childless button plus a sibling Collapse;
  - role fall-through redirect.
- **LOW:**
  - seeder backdates demo `createdAt`;
  - `submissionCount` selected;
  - names de-duplicated;
  - allowlist entry removed;
  - `ROLE_COLOR` location;
  - typo;
  - commit ownership;
  - segment-boundary matching.

Per the two-round limit, the blueprint is handed off; anything left is caught in the post-implementation audit.
