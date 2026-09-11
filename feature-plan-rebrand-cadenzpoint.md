# Blueprint: Rebrand ByTime → CadenzPoint (User-Facing String Migration)

> **Role for the executing developer: Careful refactor engineer.** This is a high-precision,
> low-creativity task. The danger is not difficulty — it's collateral damage. A blind
> find-and-replace of "bytime" will silently break decryption, orphan offline data, and corrupt
> database column names. **Read the DO-NOT-MODIFY list in §3 before touching anything**, and prefer
> the anchored edits in §4 over a global replace.

## 1. Product Overview

The product's launch name is **CadenzPoint** (one word, internal capital `P`). "ByTime" was a
placeholder. This blueprint replaces every **user-facing** occurrence of the old name with the new
one, and converts the two hardcoded brand domains to env-driven values so they track the real domain
once it's purchased.

**What "user-facing" means here:** page titles, headings, marketing copy, email subjects/bodies, the
authenticator-app issuer label, the browser tab title, and the workspace-URL hint shown at signup.
**What it explicitly does NOT mean:** database identifiers, encryption salts/contexts, IndexedDB
store names, local Postgres role/db names, or internal class names whose value is persisted or
hashed. Those are load-bearing — see §3.

This blueprint is **independent** of the design-system and logo blueprints and can ship first. It
changes words, not visuals.

---

## 2. Technical Direction

There are three categories of `bytime` strings in the codebase. Treat each differently:

| Category | Example | Action |
|---|---|---|
| **Cosmetic brand word** | `<Title>ByTime</Title>`, `title: "ByTime — …"`, email subjects | Rename to **CadenzPoint** |
| **Brand domain (env-able)** | `noreply@bytime.dev`, `{slug}.bytime.app`, demo `@bytime.dev` emails | Make env-driven; fall back to `cadenzpoint.dev` / `cadenzpoint.app` |
| **Load-bearing / persisted** | encryption context, IndexedDB name, `bytime_entity_id` columns, local DB role | **DO NOT TOUCH** (§3) |

**Method:** Do the explicit anchored edits in §4 first (those are the high-traffic surfaces). Then
run a final grep sweep (§4, Step 9) and resolve each remaining hit by the table above — never
auto-replace. Verify with `npm run build` + `npm run test` after.

---

## 3. File Topology & Guardrails

```
Files to MODIFY (cosmetic rename / env-ify):
├── src/app/layout.tsx                         ← <Metadata> title + description
├── src/app/page.tsx                           ← landing hero, footer, demo-cred emails
├── src/components/shell/AppHeader.tsx         ← header title (will be replaced by <Logo> in the logo blueprint — rename for now)
├── src/app/login/LoginForm.tsx                ← login card title
├── src/app/(app)/AppShellWrapper.tsx          ← setup-banner copy
├── src/app/signup/SignupForm.tsx              ← workspace-URL hint (env-ify the domain)
├── src/lib/totp.ts                            ← APP_NAME (authenticator issuer) — user-visible
├── src/lib/email/client.ts                    ← EMAIL_FROM default
├── src/lib/email/send.ts                      ← email subject(s)
├── src/lib/email/send-signup.ts              ← email subject
├── src/lib/email/templates/*.tsx              ← brand word in email bodies/footers
├── src/app/terms/page.tsx                     ← brand word in legal copy
├── src/app/privacy/page.tsx                   ← brand word in legal copy
├── src/app/(app)/admin/setup/SetupWizardClient.tsx        ← cosmetic copy
├── src/app/(app)/admin/integrations/**/*.tsx              ← cosmetic copy ("ByTime entity" labels)
├── src/server/actions/users.ts                ← demo-seed emails (DEMO ONLY — see note)
└── src/__tests__/unit/totp.test.ts            ← assertion must match new APP_NAME

⛔ Files NOT TOUCHED — load-bearing `bytime` strings (changing these breaks prod/data):
├── src/lib/encryption.ts                      ← scrypt context 'bytime-encryption' (line 24) and dev
│                                                 fallback 'bytime-dev-key-not-for-production' (line 17).
│                                                 The context string is part of the KDF — changing it
│                                                 makes every stored tenant dbUrl UNDECRYPTABLE. LEAVE.
├── src/lib/offline/db.ts                      ← Dexie DB name 'bytime-offline' (line 59). Changing it
│                                                 orphans every user's offline-queued time entries.
│                                                 LEAVE the string. (The class name `ByTimeOfflineDB` is
│                                                 internal; renaming the class is allowed but pointless —
│                                                 leave it to avoid churn.)
├── src/db/schema.ts                           ← columns bytime_entity_id / bytime_entity_type and the
│                                                 `bytimeEntityId` fields (lines ~321–369). These are
│                                                 live DB column names — renaming requires a migration
│                                                 and breaks the integrations mapping. LEAVE.
├── src/lib/tenant/neon.ts                      ← local dev fallback DSN
│                                                 'postgresql://bytime:bytime_dev@localhost:5432/bytime'
│                                                 (line ~75) is your actual local Postgres role/db. LEAVE.
│                                                 (Neon PROJECT-name prefix `bytime-${slug}` on line ~40
│                                                 is cosmetic and only affects NEW Neon projects — OPTIONAL,
│                                                 low priority; safe to change to `cadenzpoint-${slug}` but
│                                                 it does not rename existing projects.)
└── src/__tests__/unit/validation.test.ts      ← 'Admin@ByTime.Dev' is an incidental email-normalization
                                                  fixture, NOT a brand assertion. LEAVE (or change the
                                                  local part only; irrelevant to branding).
```

> **The single most important rule:** never run `sed -i 's/bytime/cadenzpoint/g'` across the repo.
> The encryption context and IndexedDB name look identical to cosmetic strings but are catastrophic
> to change. Use the anchored edits below.

---

## 4. Step-by-Step

> **⚠️ GUARDRAILS:**
> - Per `AGENTS.md`, this is Next.js 16 — confirm metadata/route conventions in `node_modules/next/dist/docs/` if unsure.
> - Touch only the files in the MODIFY list. If a grep hit is in a DO-NOT-TOUCH file, skip it.
> - Preserve the internal-cap spelling exactly: **CadenzPoint** (not "Cadenzpoint", "CadenzaPoint", "Cadence Point").
> - `npm run build` and `npm run test` must pass at the end.

**Step 1 — Browser tab + metadata.** In `src/app/layout.tsx`:
```diff
 export const metadata: Metadata = {
-  title: "ByTime — DCAA-Compliant Timekeeping",
+  title: "CadenzPoint — DCAA-Compliant Timekeeping",
   description: "Modern timekeeping for Government Contractors",
 };
```

**Step 2 — App header.** In `src/components/shell/AppHeader.tsx`:
```diff
-        <Title order={3}>ByTime</Title>
+        <Title order={3}>CadenzPoint</Title>
```
> (The logo blueprint later replaces this whole `Avatar + Title` block with a `<Logo>` component.
> Rename it now so the app is consistent even if the logo blueprint hasn't run yet.)

**Step 3 — Login card.** In `src/app/login/LoginForm.tsx`:
```diff
-          <Title order={2}>ByTime</Title>
+          <Title order={2}>CadenzPoint</Title>
```

**Step 4 — Setup banner.** In `src/app/(app)/AppShellWrapper.tsx`:
```diff
-                  Your ByTime instance needs initial setup.{' '}
+                  Your CadenzPoint workspace needs initial setup.{' '}
```
> The localStorage key `BANNER_DISMISS_KEY = 'bytime-setup-banner-dismissed'` is internal — leave it
> (renaming it just re-shows the banner once to existing users; harmless either way, not worth the churn).

**Step 5 — Landing page.** In `src/app/page.tsx`: replace the hero `<Title>ByTime</Title>`, the footer
copyright line, and the three demo-credential emails:
```diff
-          <Title order={1} ta="center" size={48}>
-            ByTime
-          </Title>
+          <Title order={1} ta="center" size={48}>
+            CadenzPoint
+          </Title>
```
```diff
-          © 2026 ByTime — DCAA-Compliant Timekeeping for Government Contractors
+          © 2026 CadenzPoint — DCAA-Compliant Timekeeping for Government Contractors
```
Demo-cred emails (cosmetic; keep in sync with Step 11): `admin@bytime.dev` → `admin@cadenzpoint.dev`,
`sarah.wilson@bytime.dev` → `sarah.wilson@cadenzpoint.dev`, `jane.smith@bytime.dev` →
`jane.smith@cadenzpoint.dev`.

**Step 6 — Authenticator issuer (user-visible in Google/Microsoft Authenticator).** In `src/lib/totp.ts`:
```diff
-const APP_NAME = 'ByTime';
+const APP_NAME = 'CadenzPoint';
```
> **Note:** this changes the issuer label shown for NEW MFA enrollments. Users already enrolled keep
> the old "ByTime" label in their authenticator app, but their codes still validate (the issuer is a
> display label, not part of the secret). No migration needed. Update the matching test in Step 10.

**Step 7 — Email sender + subjects.**
- `src/lib/email/client.ts`:
```diff
-export const EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@bytime.dev';
+export const EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@cadenzpoint.dev';
```
- `src/lib/email/send.ts`: `subject: 'Reset Your ByTime Password'` → `'Reset Your CadenzPoint Password'`.
- `src/lib/email/send-signup.ts`: `subject: 'Confirm your email to create your ByTime workspace'` →
  `'Confirm your email to create your CadenzPoint workspace'`.
- `src/lib/email/templates/*.tsx`: rename every visible "ByTime" in headings/footers/body copy to
  "CadenzPoint" (these are the emails customers actually read — be thorough across all template files).

**Step 8 — Signup workspace-URL hint (env-ify the domain).** In `src/app/signup/SignupForm.tsx`, the
line that reads `Your team will log in at {slug || 'yourcompany'}.bytime.app` ties the brand to a
domain you don't own yet. Drive it from the public root-domain env var with a CadenzPoint fallback:
```diff
-                  Your team will log in at <strong>{slug || 'yourcompany'}.bytime.app</strong>
+                  Your team will log in at <strong>{slug || 'yourcompany'}.{process.env.NEXT_PUBLIC_APP_ROOT_DOMAIN ?? 'cadenzpoint.app'}</strong>
```
> If a `NEXT_PUBLIC_APP_ROOT_DOMAIN` doesn't already exist, add it to `.env.example` with a comment
> ("public root domain for tenant subdomains, e.g. app.cadenzpoint.com"). The non-public
> `APP_ROOT_DOMAIN` used server-side stays as-is.

**Step 9 — Legal + secondary copy.** Rename visible "ByTime" → "CadenzPoint" in:
`src/app/terms/page.tsx`, `src/app/privacy/page.tsx`,
`src/app/(app)/admin/setup/SetupWizardClient.tsx`, and the
`src/app/(app)/admin/integrations/**` client/page files (labels like "ByTime entity" → "CadenzPoint
entity" in the UI text — but **not** the `bytimeEntityId` schema fields they bind to).

**Step 10 — Demo seed (DEMO ONLY).** In `src/server/actions/users.ts`, the seeded demo accounts use
`@bytime.dev`. Rename them to `@cadenzpoint.dev` to match the landing page.
> **Caveat:** changing these means demos seeded *after* this change use the new emails; any *already
> seeded* demo data still has the old emails. For a fresh demo, re-seed. Call this out to the user.
> This is the only step that affects login identifiers — it's safe because these are throwaway demo
> users, not real customers.

**Step 11 — Fix the TOTP test.** In `src/__tests__/unit/totp.test.ts`:
```diff
-    expect(result.uri).toContain('ByTime');
+    expect(result.uri).toContain('CadenzPoint');
```

**Step 12 — Final sweep.** Run the grep below and resolve every remaining hit using the §2 table.
Each hit is either cosmetic (rename), a brand domain (env-ify), or load-bearing (skip per §3).
```bash
grep -rin "bytime" src/ \
  --include="*.ts" --include="*.tsx" --include="*.css" \
  | grep -vi "encryption.ts" \
  | grep -vi "offline/db.ts" \
  | grep -vi "schema.ts" \
  | grep -vi "tenant/neon.ts" \
  | grep -vi "validation.test.ts"
```
> Anything this prints is a candidate for rename. Anything it filters out is intentionally preserved.
> If you find a NEW load-bearing string not listed in §3 (e.g. another hashed/persisted constant),
> STOP and flag it rather than renaming.

---

## 5. Verification

### 5a. Build & tests
```bash
npm run build        # zero errors
npm run test         # unit tests pass (totp test now expects CadenzPoint)
npm run lint         # no NEW errors
```

### 5b. Load-bearing integrity (the part that matters)
| Check | How | Expected |
|---|---|---|
| Encryption context untouched | `grep -n "bytime-encryption" src/lib/encryption.ts` | still present (1 hit) |
| Offline DB name untouched | `grep -n "'bytime-offline'" src/lib/offline/db.ts` | still present (1 hit) |
| Schema columns untouched | `grep -cn "bytime_entity" src/db/schema.ts` | unchanged count |
| Existing tenant decrypts | Log into a previously-provisioned tenant (e.g. `acme.localhost:3000`) | loads (proves dbUrl still decrypts) |
| Existing offline data | Open the app offline after upgrade | queued entries still present |

### 5c. Brand surface check
| Surface | Expected text |
|---|---|
| Browser tab title | "CadenzPoint — DCAA-Compliant Timekeeping" |
| App header | CadenzPoint |
| Login card | CadenzPoint |
| Landing hero + footer | CadenzPoint |
| Password-reset / signup-verify email subject | "…CadenzPoint…" |
| New MFA enrollment in authenticator app | issuer "CadenzPoint" |
| Signup workspace hint | `slug.cadenzpoint.app` (or your env domain) |

### 5d. Common errors to watch for
| Symptom | Cause | Fix |
|---|---|---|
| Previously-provisioned tenant now 500s with a decrypt error | encryption context string was changed | revert `src/lib/encryption.ts` to `'bytime-encryption'` exactly |
| Users' offline entries vanished | Dexie DB name changed | revert `src/lib/offline/db.ts` name to `'bytime-offline'` |
| `db:push` wants to drop/rename columns | `bytime_entity_*` columns were renamed in schema.ts | revert the schema field/column names |
| Local dev DB won't connect | local fallback DSN role/db renamed | revert `tenant/neon.ts` line ~75 DSN |
| Build fails: `NEXT_PUBLIC_APP_ROOT_DOMAIN` undefined at build | referenced without fallback | keep the `?? 'cadenzpoint.app'` fallback in the JSX |
