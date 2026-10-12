# Blueprint: App-Wide UI/UX Polish — Persistent Navbar (No Flash) + Responsive Tables

> **Role for the executing developer: Senior front-end / UX engineer.** Two must-fix defects plus an
> opportunistic polish pass. The bar: the app should feel like a single, stable SPA — the shell never
> flashes or reloads on navigation, and no table ever bleeds past the page width. Do not break any
> existing functionality (sorting, filtering, row actions, approvals, DCAA audit behavior).

## 1. Overview & Root-Cause Findings

Three goals:
1. **Navbar keeps its state across navigation with zero flash.**
2. **Every table is responsive — no horizontal page bleed at 100% zoom with the navbar open.**
3. **Opportunistic, non-breaking polish** the developer identifies along the way.

### Root cause of the navbar flash (already diagnosed — don't re-investigate, just fix)
`src/components/shell/AppNavbar.tsx` renders Mantine `NavLink` with a **plain `href`** and no
`component={Link}`. Mantine then emits a real `<a href>`, so **every nav click is a full-page
document reload**, not client-side routing. The entire app (including the shell) remounts on each
navigation → the collapsed rail re-initializes → the open→collapse flash (and slow navigations).

Prior mitigation already in place (keep it — it correctly fixes the *first-paint* case):
- `src/app/(app)/layout.tsx` reads a `cadenzpoint-navbar-collapsed` cookie and passes
  `initialCollapsed` to `AppShellWrapper`.
- `AppShellWrapper` seeds `useState(initialCollapsed)`, persists via that cookie on toggle, and reads
  `useMediaQuery(..., { getInitialValueInEffect: false })`.

That groundwork is correct but insufficient on its own **because the page keeps doing full reloads**.
The decisive fix is client-side navigation. Once nav is client-side, the shell persists and the
state/flash problem disappears; the cookie work then just guarantees a clean first/hard load.

### Tables
`src/app/(app)` has **9 MantineReactTable (MRT) instances** and several **raw `<Table>`** usages.
`AppShell.Main` already sets `minWidth: 0`, but most tables don't constrain their own overflow, so a
wide table stretches the page instead of scrolling within itself. The **audit-trail table is the
reference implementation** (already fixed) — apply the same pattern everywhere.

---

## 2. File Topology

```
NAVBAR (Phase 1) — MODIFY:
├── src/components/shell/AppNavbar.tsx     ← NavLink href → component={Link} (client-side nav)
├── src/components/shell/AppHeader.tsx     ← Menu.Item component="a" href → component={Link}
└── (verify only) src/app/(app)/AppShellWrapper.tsx, src/app/(app)/layout.tsx  ← cookie seeding already done; keep

TABLES (Phase 2) — MODIFY (apply the canonical responsive pattern to each):
├── src/app/(app)/admin/assignments/AssignmentsClient.tsx       (MRT)
├── src/app/(app)/admin/api-keys/ApiKeysClient.tsx              (MRT)
├── src/app/(app)/admin/labor-categories/LaborCategoriesClient.tsx (MRT)
├── src/app/(app)/admin/contracts/ContractsClient.tsx          (MRT + raw <Table>)
├── src/app/(app)/admin/dashboard/DashboardClient.tsx          (MRT + raw <Table>)
├── src/app/(app)/admin/indirect-codes/IndirectCodesClient.tsx (MRT)
├── src/app/(app)/admin/approvals/ApprovalsClient.tsx          (MRT + raw <Table>)
├── src/app/(app)/admin/users/UsersClient.tsx                  (MRT)
├── src/app/(app)/admin/integrations/quickbooks/QBOConfigClient.tsx     (raw <Table>)
├── src/app/(app)/admin/integrations/gusto/GustoConfigClient.tsx        (raw <Table>)
├── src/app/(app)/admin/integrations/payroll-export/PayrollExportClient.tsx (raw <Table>)
├── src/app/(app)/admin/import/ImportClient.tsx                (raw <Table>)
├── src/app/(app)/admin/migration/MigrationClient.tsx          (raw <Table>)
├── src/components/timesheet/TimesheetDashboard.tsx            (raw <Table>)
└── src/components/timesheet/ReasonModal.tsx                   (raw <Table> — inside a modal; lower risk)

REFERENCE (DO NOT REDO — copy its pattern):
└── src/app/(app)/admin/audit-trail/AuditTrailClient.tsx       ← already responsive + content-sized

DO NOT MODIFY:
├── src/server/actions/**       ← no data/logic changes
├── src/db/**, src/lib/**       ← no schema/business-logic changes
└── the timesheet grid (src/components/timesheet/BiWeeklyTable.tsx) ← already fit-to-width; leave it
```

---

## 3. Step-by-Step

> **⚠️ GUARDRAILS:**
> - Next.js 16 + Mantine v9 — confirm `component={Link}` polymorphism and MRT props against
>   `node_modules/next/dist/docs/` and `node_modules/mantine-react-table` before relying on them.
> - **Do not break existing behavior.** Every table must still sort, filter, paginate, open its
>   drawers/modals, and fire its row actions exactly as before.
> - Do not undo the audit-trail work or the cookie-seeding in the shell — build on them.
> - `npm run build`, `npm run test`, and `npm run lint` must pass; no NEW lint errors.

### Phase 1 — Client-side navigation (fixes the flash)

**Step 1.1 — Navbar links.** In `src/components/shell/AppNavbar.tsx`, import Next's Link and render
each `NavLink` with it so navigation is client-side (no document reload):
```tsx
import Link from 'next/link';
// ...
<NavLink
  component={Link}
  href={item.href}
  label={collapsed ? undefined : item.label}
  leftSection={item.icon}
  active={pathname === item.href}
  aria-label={item.label}
  styles={/* unchanged collapsed styles */}
/>
```
> Keep everything else (tooltips when collapsed, active state, the collapsed `styles`). Only the
> `component={Link}` addition changes behavior. The Tooltip wrapper for collapsed items stays.

**Step 1.2 — Header menu links.** In `src/components/shell/AppHeader.tsx`, the user-menu items use
`component="a" href="/profile"` / `/admin/notifications` (also full reloads). Convert them to
`component={Link}` (import `Link from 'next/link'`). Leave the Sign Out item (it's an `onClick`).

**Step 1.3 — Verify no remount.** With client-side nav working, the `(app)` layout and
`AppShellWrapper` persist across navigation, so the collapse state simply stays put. Confirm in the
browser (see Verification 5a) that collapsing the rail and navigating between several admin pages
produces **no flash and no full reload** (Network tab shows RSC fetches, not full document loads).

> If a flash somehow persists after Step 1.1–1.2, investigate in this order and report findings:
> (a) confirm clicks no longer trigger full document loads (Network tab); (b) confirm
> `AppShellWrapper` is not remounting (add a temporary `console.log` in a `useEffect(() => {...}, [])`
> — it should fire once per hard load, not per navigation); (c) check whether Mantine AppShell is
> animating the navbar width on mount — if so, suppress the width transition on first paint. Fix the
> actual cause; do not paper over it.

### Phase 2 — Responsive tables (no width bleed)

**The canonical MRT pattern** (lifted from the audit-trail reference). For every MRT table, ensure the
table owns its overflow instead of stretching the page:
```ts
const table = useMantineReactTable({
  columns,
  data,
  // ...existing options...
  mantinePaperProps: { style: { width: '100%' } },
  mantineTableContainerProps: { style: { maxWidth: '100%', overflowX: 'auto' } },
  // Prefer content-based widths where the table has few columns:
  //   layoutMode: 'semantic',
  // Only keep column pinning if a table genuinely needs a sticky column during scroll — pinning
  // forces fixed-pixel 'grid' layout (the thing that made widths non-dynamic). Default to NOT pinning.
});
```
Apply per table:

**Step 2.1 — Audit each MRT table** (assignments, api-keys, labor-categories, contracts, dashboard,
indirect-codes, approvals, users). For each:
- Add `mantinePaperProps.width: '100%'` + `mantineTableContainerProps` overflow as above.
- If the table has many columns or long cells that overflow, either switch to `layoutMode: 'semantic'`
  for content sizing, and/or **default-hide low-value columns** via `initialState.columnVisibility`
  (keep them toggleable), mirroring the audit-trail approach. Use judgment per table; the acceptance
  bar is "fits at 100% with the navbar open, or scrolls within its own container — never bleeds the
  page."
- Verify row actions / drawers (Contracts and Approvals have Drawers) still open and work.

**Step 2.2 — Wrap raw `<Table>` usages** (quickbooks, gusto, payroll-export, import, migration,
TimesheetDashboard, ReasonModal, and the raw tables inside contracts/dashboard/approvals). Use
Mantine's responsive wrapper:
```tsx
import { Table } from '@mantine/core';
// ...
<Table.ScrollContainer minWidth={/* sensible min, e.g. 500–700 */}>
  <Table>{/* unchanged head/body */}</Table>
</Table.ScrollContainer>
```
> `Table.ScrollContainer` gives the table its own horizontal scroll on narrow widths instead of
> pushing the page. Pick a `minWidth` just above the table's natural content so it only scrolls when
> it truly must. ReasonModal's table is inside a modal — low risk, but wrap it too for consistency.

**Step 2.3 — Sanity-check the shell constraint.** Confirm `AppShell.Main` still has `minWidth: 0`
(it does) — that's what lets these containers actually constrain. Don't remove it.

### Phase 3 — Opportunistic polish (non-breaking; developer's discretion)

Address any of these you find, **only if they don't risk existing functionality** — and report what
you changed:
- **Mobile nav is unreachable (real gap):** `AppShellWrapper` has `opened`/`toggle` from
  `useDisclosure`, but `toggle` is unused — there is **no `Burger`** anywhere, so on mobile the navbar
  can't be opened. Add a `Burger` in `AppHeader` (shown `hiddenFrom="sm"`) wired to `toggle`
  (pass it down, or lift the burger into the header section of `AppShellWrapper`). This also clears the
  pre-existing `toggle` unused-var lint warning.
- **Consistent page headers/spacing:** if admin pages use inconsistent `Title order`/margins, align
  them (light touch).
- **Empty/loading states:** tables with no data should show a friendly empty state (MRT does this by
  default; raw tables may not).
- **Tabular numerals:** ensure numeric/hours/currency columns use `font-variant-numeric: tabular-nums`
  (the design system added a `.tnum` helper + a table rule — apply where numbers should align).
- Do **not** undertake large refactors or restyle the brand/theme here — that's done. Keep changes
  surgical.

---

## 4. Verification

### 4a. Navbar (the headline)
```bash
npm run dev
```
| Check | Expected |
|---|---|
| Collapse rail, click through 4–5 admin pages | rail stays collapsed, **no flash**, **no full reload** |
| DevTools → Network during nav | RSC/fetch requests, NOT full document loads |
| Hard refresh on a deep page while collapsed | renders collapsed immediately, no flash |
| Toggle expand, navigate, refresh | preference persists (cookie) |
| Mobile width (if Phase 3 done) | burger opens the nav; labels shown |

### 4b. Table width-bleed sweep (the other headline)
At 100% zoom **with the navbar open**, visit every `(app)` route and confirm **no page-level
horizontal scrollbar** (`document.documentElement.scrollWidth === clientWidth`); wide tables get their
own internal scrollbar instead:

| Route | Table(s) |
|---|---|
| /admin/dashboard | MRT + raw |
| /admin/contracts | MRT + raw (Drawer) |
| /admin/assignments | MRT |
| /admin/approvals | MRT + raw (Drawer) |
| /admin/labor-categories | MRT |
| /admin/audit-trail | MRT (reference — already good) |
| /admin/users | MRT |
| /admin/indirect-codes | MRT |
| /admin/api-keys | MRT |
| /admin/import, /admin/migration | raw |
| /admin/integrations/{quickbooks,gusto,payroll-export} | raw |
| /timesheet | grid (already fit) + TimesheetDashboard raw |

### 4c. Functional regression (must not break)
| Check | Expected |
|---|---|
| Each table sorts/filters/paginates | works as before |
| Contracts & Approvals drawers | open and function |
| Audit-trail history (Rev # icon) drawer | still opens |
| Approvals approve/reject flow | unaffected |
| Dark mode | tables + rail correct in both schemes |

### 4d. Build, test, lint
```bash
npm run build    # zero errors
npm run test     # passes
npm run lint     # no NEW errors (Phase 3 burger should also clear the 'toggle' unused warning)
```

### 4e. Common errors to watch for
| Symptom | Cause | Fix |
|---|---|---|
| Nav still does full reloads | `component={Link}` missing or `href` on a non-Link | every shell link must be `component={Link}` |
| Flash persists after Link fix | shell remounting for another reason | use the Step 1.3 investigation; report findings |
| MRT table still bleeds page | container overflow not set | add `mantineTableContainerProps` overflowX/maxWidth + paper width 100% |
| Columns rigidly equal-width | column pinning forcing grid layout | drop pinning → `layoutMode: 'semantic'` unless a sticky column is essential |
| Raw table bleeds | not wrapped | wrap in `Table.ScrollContainer` |
| Hidden column data "lost" | default-hidden via columnVisibility | confirm the column-visibility toolbar button re-enables it |

---

## 5. Definition of Done
- Collapsing the rail and navigating anywhere in the app produces **no flash and no full reload**;
  the preference persists across navigation and hard refresh.
- No `(app)` route bleeds the page horizontally at 100% zoom with the navbar open; wide tables scroll
  within themselves.
- All tables retain full sort/filter/drawer/row-action behavior; build, test, lint green.
- (If tackled) mobile nav is reachable via a burger.
```
