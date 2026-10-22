# Blueprint Standard

Every `feature-plan-*.md` written from now on follows this standard, and every dev-agent hand-off
points to it. It exists because audits kept finding defects after implementation that a more
precise plan would have prevented. The goal is that defects are caught **in planning and review,
before merge**: not after.

## 1. How a blueprint is made (lead architect)

1. **Research before writing.** Map the real code paths involved, with file:line evidence: every
   caller and consumer of anything the blueprint changes, including scripts, seeders, crons,
   webhooks, tests, and docs, not just the app.
2. **Verify every external behavior from the source.** For each library and service the plan relies
   on (Stripe, Resend, Neon, Auth.js, Drizzle, Next.js, Vercel), confirm from `node_modules` types or
   current official docs how it behaves, especially **how it reports errors**, its limits, and
   version-specific field names. Write the confirmed facts into the blueprint with their source.
3. **Pre-mortem review.** Before hand-off, independent adversarial reviewers read the blueprint
   against the code and ask "how would this fail in production?" Findings are fixed in the
   blueprint. A blueprint is not handed off until this review comes back clean. **Clean** means a fresh
   reviewer finds no high- or medium-severity issue (production failure, contract/Terms non-compliance, data
   loss, security weakness, or a stuck state). Low-severity items are written into the blueprint and verified
   in the post-implementation code audit.
4. **No business decisions.** Anything that is a policy choice goes to the product owner first
   (business side) and lands in a config file; the blueprint never invents one.

## 2. What every blueprint must contain

| Section | Required content |
|---|---|
| **Verified current state** | What exists today, with file:line references. No assumptions. |
| **Invariants that must not break** | DCAA (append-only revisions, reason codes, period lock, charge-code denormalization), security (every action guarded before any query, identity from session, tenant binding, no secrets to the browser), tenancy isolation, the calendar-date model, and anything specific to the feature. |
| **State machines** | For anything with states (billing, lifecycle, approval, sync): an explicit table of every state, every event, the resulting state, and the side effects (emails, writes, external calls). Every cell filled; "can't happen" cells say why. |
| **Failure modes** | For every external call and every multi-step operation: what happens when it fails halfway, when it's retried, when it runs twice concurrently, when events arrive out of order or duplicated, when a scheduled job misses a day. |
| **Platform limits** | Response size and timeout limits (Vercel), connection/pooling behavior (Neon), memory, rate limits, that apply to this feature, and how the design stays within them. |
| **Blast radius** | Every existing file, script, seeder, cron, test, and doc the change touches or can break, and how each is updated. |
| **Required test matrix** | Not "add tests for X": a table of named scenarios (including the failure modes and every state-machine transition) that must each have a test which fails without the fix. |
| **Verification steps** | Commands, including the ones only the product owner's machine can run (integration tests against Postgres, Turbopack build, local demo re-seed), and manual end-to-end checks. |

## 3. Rules every dev-agent hand-off includes

1. **Research first, code second.** Before writing code, produce a short written impact analysis:
   files to change, callers affected, external behaviors confirmed (with source), and any place the
   blueprint seems wrong or incomplete. Stop and ask if anything is unclear. Never guess a
   business rule.
2. **Follow the state tables and test matrix exactly.** Every scenario in the matrix gets a test.
   A test must fail without the change it proves.
3. **Check how each library reports errors.** Never assume a call throws on failure (for example,
   Resend returns `{ error }` instead of throwing). Never record success without confirming it.
4. **Destructive operations** require explicit flags, refuse when preconditions are unproven, print
   what they will do, and never run against anything but a throwaway local resource during testing.
5. **Adversarial self-review before reporting.** Re-read the diff against the invariants, the state
   tables, and the failure-modes section, and list anything not covered.
6. **Report honestly.** Never claim a check passed that wasn't run; name every command that couldn't
   run and why.

## 4. Definition of done (before merge)

- Lead-architect audit: own scan plus independent reviewers, with every finding verified in code.
- `npx tsc --noEmit`, `npm run lint` (0 errors), `npm run test`, `npm run test:tz`, `npm run db:safety`.
- On the product owner's machine: `TZ=America/New_York npm run test:integration` (with the isolation
  databases), `npm run build` (Turbopack), and `npm run demo:local` re-run when data or migrations
  changed.
- Production readiness additionally requires the end-to-end staging rehearsal (PRODUCTION-DEPLOY.md).
