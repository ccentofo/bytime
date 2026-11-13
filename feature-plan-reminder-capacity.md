# Reminder email capacity (build queue 4b)

> **Status:** **FINAL v3.1**, 2026-11-12, lead architect. **Pre-mortem CLEAN** (rounds 1 and 2 plus a confirmation pass, §14). **Accepted by the product owner on 2026-11-12** (Q2 and Q3 answered in §2). Ready for a fresh dev session.
>
> **Branch:** `reminder-capacity`, from `main` at `4572b39` (after PR #26).
>
> **Source:**
> - `LAUNCH-TRACKER.md` build queue 4b, approved 2026-11-11 (launch hardening Q8: "the cron senders use Resend batch send").
> - Product owner, 2026-11-12: **batch only the two reminder crons**. Admin notice delivery stays one email per send.
>
> **Standard:** `BLUEPRINT-STANDARD.md`.

## 1. Goal and scope

**Goal.** Today the two reminder crons send one email per Resend request, at most 2 requests per second, inside a 240 s budget. That caps them at about **480 reminders per run across all workspaces**. A larger run stops early, raises the `cron-incomplete` alert, and the remaining employees get no reminder that day. This blueprint moves both crons to Resend's batch endpoint, which takes up to 100 emails per request. Capacity rises by roughly two orders of magnitude, and nothing changes for employees.

**In scope**
1. `daily-reminder` and `submission-deadline` send through one new batch helper (§6.2), in batches of up to 100, one workspace per batch.
2. Every batch request carries a fixed idempotency key (§6.3). Retries and duplicate cron invocations can't send the same reminder twice.
3. Resend's quota and configuration errors, and three whole-batch failures in a row, stop the run's sending instead of being retried (§6.2, §6.4). The `cron-incomplete` alert and Sentry name the reason (§6.5).
4. The deadline cron reads period status and opt-outs once per workspace instead of twice per employee (§6.7). Once sending is batched, those per-employee reads would be the slowest step.

**Out of scope**
- Notice delivery (`src/lib/tenant/notices.ts`). Product owner, 2026-11-12.
- Every other sender: approval, return, submission, password reset, signup, ops alerts, the ops digest. They send one email at a time and are user-triggered or low volume.
- Email content, subjects, recipients, schedules (`vercel.json`), the 240 s budget and the 2 requests/second spacing.
- The Resend plan and quota. That's a business item (§10.3).

## 2. Questions for the product owner

| # | Question | Recommendation |
|---|---|---|
| Q1 | Batch notices too? | **Decided 2026-11-12: no.** Reminders only. |
| Q2 | **Answered 2026-11-12: not possible yet; there's no Resend account.** The live check moves to the staging rehearsal (§12.1). The design doesn't depend on it: A1 counts ids rather than positions, B20 pins the SDK envelope, and the `email-failing` breaker covers a per-email sender rejection. *(Original question:)* Before the dev starts, may the lead send **two test batch requests** with the Resend key in your `.env.local`? (a) Two emails to Resend's test inbox (`delivered@resend.dev`) plus one deliberately invalid address, in permissive mode. (b) One email to the test inbox from a sender domain that isn't verified (`noreply@example.com`). At most 2 emails are delivered, both to Resend's test inbox, and nothing goes to a real person. | **Yes.** Permissive mode's response is documented only in the SDK's types (§4.1, F4), and the docs don't say whether an unverified sender fails the whole request or one email. The test records the exact SDK-level result in §4.1 before the dev builds on it. |
| Q3 | **Answered 2026-11-12: no reserve code; the Resend Free tier for now** (product owner). *(Original question:)* **Quota reserve.** Reminders, the legally required lifecycle and Terms notices, password resets and ops alerts all share one Resend quota. Today's 480-per-run ceiling partly shields the others; batching removes it, so one run can use up the Free plan's 100/day, or a paid plan's month. Should reminders hold back part of the quota? | **No reserve code at launch.** Instead, size the Resend plan with headroom (the business item, §10.3). Notices aren't lost when the quota runs out: they stay pending and the 10-minute cron retries them until they send (`notices.ts:278-298`). They'd go out after the daily reset, or once the plan is raised. The quota stop (§6.5) makes exhaustion loud. If you want a reserve, the alternative is a configured monthly allowance that reminders stop at, read from Resend's `x-resend-monthly-quota` response header. That's about a day more work, and it needs the plan size in config. |

**Behaviour changes, listed for your approval with the blueprint.** None of them is visible to employees.
1. **A duplicate cron run usually sends no second reminder.** Vercel can occasionally invoke the same scheduled run twice (§4.2). Today that sends everyone two reminders. With the idempotency key, Resend answers a repeated batch without sending (§6.3). **The limit:** batches are cut by count, so if one employee enters time between the two runs, their batch and every later batch in that workspace get new keys, and those people still get a second reminder.
2. **When Resend's quota runs out, rejects the API key or sender domain, or fails three batches in a row,** the run stops sending. It doesn't keep retrying. Sentry and the `cron-incomplete` alert's stored details say why (§6.5). Today every remaining send fails one by one, each with its own Sentry error.
3. **Sentry gets one message per failed batch**, with the count and the recipient domains, instead of one per failed email.
4. **The run summary** stored in `cron_runs.last_summary` gains `batches` and `stopReason` (§6.6).
5. **The deadline cron reads a workspace's submitted periods and opt-outs once,** at the start of that workspace's turn. Today it reads them per employee. The data is at most seconds older.

## 3. Verified current state (2026-11-12, `4572b39`)

### 3.1 The two reminder crons
- **Shell.** Both routes call `runCron(request, name, sendReminders, { maxRuntimeMinutes: 5 })` (`daily-reminder/route.ts:32-34`, `submission-deadline/route.ts:33-35`) with `export const maxDuration = 300` as a literal (`:30` / `:31`). `runCron` checks auth, answers `?probe=1`, writes `cron_runs` start, runs the work, then writes success with the summary (`src/lib/cron/run-cron.ts:21-30`). A throw or a function timeout leaves `last_summary` (and so the rotation state) as the previous run left it.
- **Tenants.** Status `active` and access `full` (`daily-reminder/route.ts:40-41`, `submission-deadline/route.ts:41-42`).
- **Throttle.** One `createSendThrottle()` per run (`daily-reminder/route.ts:46`, `submission-deadline/route.ts:47`), awaited before every send. It spaces sends at least 500 ms apart (`src/lib/email/rate.ts:6-7,13-24`).
- **Sweep.** `sweepTenants` (`src/lib/cron/tenant-sweep.ts:57-116`):
  - 240 s budget (`:26,66-67`);
  - fair rotation after the saved cursor (`:29-34,69-70`);
  - per-tenant resume after the last finished employee (`:76,81,84-91`);
  - a non-`'done'` outcome breaks the loop and marks the run incomplete (`:84-90`). When the stop is inside the first tenant of the rotation, the cursor moves past it (`:88`);
  - a tenant that throws is reported to Sentry, its resume entry deleted, and the loop continues (`:92-97`);
  - an incomplete run sends a Sentry warning plus the `cron-incomplete:<name>` ops alert with a fixed "stopped at its time budget" text (`:102-110`); a complete run resolves the alert (`:111-113`).
  - `TenantOutcome` is `'done' | { stoppedAfter: string | null }` (`:55`).
- **Per-employee loop, daily** (`daily-reminder/route.ts:54-106`):
  - the tenant's local date and weekend skip (`:62-66`);
  - active employees in id order, after `resumeAfter` (`:69-74`);
  - one query for everyone with an entry today (`:77-82`);
  - `outOfTime()` checked before every employee (`:88`); skip those with an entry (`:90`) and seed-domain addresses (`:91`); no preference lookup (H1, `:93-94`);
  - `await sendThrottle(); await sendDailyReminderEmail(...)` (`:95-101`); `ok` counts as sent, `reason: 'error'` as failed, `disabled` as neither (`:102-103`).
- **Per-employee loop, deadline** (`submission-deadline/route.ts:55-131`):
  - local date, period config, and the deadline (the last weekday of the period); sends only 2 days before and on the deadline (`:64-75`);
  - per employee: `outOfTime()` (`:91`), seed skip (`:93`), **one query for the employee's period** (`:95-103`; skip `submitted` / `approved`, `:105-108`), **one query for the employee's `email_deadline_reminder` preference** (`:110-115`; no row means on);
  - throttle and `sendSubmissionDeadlineEmail` (`:117-128`).
- **Summaries.** `{ message, sent, failedSends, skippedSeedRecipients, processed, candidates, incomplete, failedTenants, failedTenantCount, cursor, resumes }` (`daily-reminder/route.ts:109-121`, `submission-deadline/route.ts:134-146`). `readCronState` reads only `cursor` and `resumes` back (`src/lib/cron/heartbeat.ts:92-107`). No other code reads `failedSends` or `sent`.
- **Uniqueness.** `timesheet_periods` is unique on `(user_id, period_start)` (`src/db/schema.ts:421`). `notification_preferences.user_id` is unique (`:495`). Period statuses: `draft`, `submitted`, `approved`, `rejected` (`:16`).

### 3.2 Single send today
- `deliverEmail` (`src/lib/email/send.ts:51-61`) returns `disabled` when there's no client (`:52`), retries once after 2 s on a rate limit (`:54-58`), and records success only with a message id (`:43-44`).
- `attemptSend` treats **any `statusCode === 429`** as a rate limit (`:40`). Resend's quota errors are also 429 (§4.1, F7), so today an exhausted quota is retried once, pointlessly, on every send.
- `reportFailure` logs and sends to Sentry with the recipient **domain** only (`:26-32`).
- The reminder senders: `sendDailyReminderEmail` (`:145-161`) and `sendSubmissionDeadlineEmail` (`:164-182`). Each builds a subject and a React element, then calls `deliverEmail`.
- The client: `resend` is `null` without `RESEND_API_KEY` (`src/lib/email/client.ts:7-9`); `EMAIL_FROM` (`:13`).

### 3.3 Notice delivery (unchanged; the design precedent)
`deliverNotice` (`src/lib/tenant/notices.ts:239-271`) sends with `{ idempotencyKey }` inside a `Promise.race` timeout (10 s). It retries `concurrent_idempotent_requests` and rate limits up to 3 attempts, and treats `invalid_idempotent_request` as a non-retryable mismatch. It imports `CRON_SEND_INTERVAL_MS` (`:11,39`). This blueprint uses the same error semantics for batches.

### 3.4 Every caller and consumer
| Thing | Used by |
|---|---|
| `sendDailyReminderEmail`, `sendSubmissionDeadlineEmail` | the two cron routes only. Mocked in `unit/reminder-crons.test.ts:63`. Tested in `unit/email-send.test.ts:27-28,123-124`. Listed in the explicit-export `vi.mock('@/lib/email/send', …)` factories of 7 integration files ("list every export explicitly", `charge-code-actions.test.ts:64-74`): `charge-code-actions:71-72`, `charge-codes-ux4c:95-96`, `calendar-dates-d9:60-61`, `authorization:97-98`, `audit-ux4c:69-70`, `dcaa-concurrency:75-76`, `submission-emails:81-82`. |
| `createSendThrottle`, `CRON_SEND_INTERVAL_MS` | the two cron routes; `notices.ts:11,39`; `unit/email-schedule-throttle.test.ts`; mocked in `unit/reminder-crons.test.ts:62`. |
| `sweepTenants`, `TenantOutcome` | the two cron routes; `unit/cron-ops.test.ts:167-343`; mocked in `unit/reminder-crons.test.ts:41-55`. |
| Cron routes | `vercel.json` (schedules unchanged); `unit/route-segment-config.test.ts`; `unit/cron-auth.test.ts`; `integration/authorization.test.ts:441-470` (401 checks); `scripts/smoke-tenancy.sh` (`?probe=1` only). |
| Templates `DailyReminderEmail`, `SubmissionDeadlineEmail` | `send.ts`; `unit/reminder-email-footer.test.ts`. Unchanged. |

## 4. External behaviour (verified from source)

### 4.1 Resend (installed `resend` 6.12.4; resend.com docs fetched 2026-11-12)
| # | Fact | Source |
|---|---|---|
| F1 | `resend.batch.send(emails, options?)` posts to `/emails/batch`. Each email is `CreateEmailOptions` without `attachments` and `scheduledAt`. | `node_modules/resend/dist/index.d.mts:635-636,1501-1506`; `dist/index.mjs:221-245` |
| F2 | Up to **100 emails per request**. | docs `api-reference/emails/send-batch-emails`; `dashboard/emails/batch-sending` |
| F3 | The SDK **renders each `react` element to `html` itself** and **mutates the passed objects** (`email.html = …; email.react = undefined`). It sends the header `x-batch-validation` (default `strict`). | `dist/index.mjs:228-243` |
| F4 | **The SDK result wraps the API body.** `fetchRequest` returns `{ data: await response.json(), error: null, headers }` (`dist/index.mjs:1110-1114`), and the batch API body is `{ "data": [{ "id" }…], "errors"?: […] }` (docs "Response" example). **So the array is at `result.data.data`, and per-email errors at `result.data.errors`.** `batchValidation: 'permissive'` is a typed option. With it, the body type is `{ data: { id }[]; errors: { index; message }[] }`, where `index` is "the index of the failed email in the batch". In `strict` mode (the default), one invalid email fails the whole request. **The public API reference no longer mentions the header.** The CLI reference documents `--batch-validation strict` ("entire batch fails on any error") and `permissive`. Docs say: "When the request succeeds, each entry in `data` corresponds to the email at the same index in the batch payload". **Not documented:** whether, in permissive mode, `data` omits the failed entries or keeps their positions. §6.2 doesn't depend on it, and Q2 checks it live. | `dist/index.d.mts:637-661`; `llms-full.txt` (CLI `resend emails batch`); send-batch-emails "Response format" |
| F5 | **Errors are returned, not thrown.** (Then `result.data` is `null` and `result.error` is set.) Non-2xx → `{ data: null, error }` with the API's JSON body (`{ name, message, statusCode }`). A non-JSON body → `application_error` with the HTTP status. A network failure → `application_error` with `statusCode: null`. The SDK sets **no timeout** on `fetch`. | `dist/index.mjs:1071-1124`; `dist/index.d.mts:121-135` |
| F6 | **Idempotency keys:** 1–256 characters, kept 24 h. Same key and same payload → the original response, nothing re-sent. Same key and different payload → **409 `invalid_idempotent_request`**. Same key while the first is in flight → **409 `concurrent_idempotent_requests`**, "safe to retry later". Batch is a supported endpoint; the key covers the whole request. | docs `dashboard/emails/idempotency-keys`; `api-reference/errors` |
| F7 | **Rate limit:** 10 requests/s **per team**, across all keys → **429 `rate_limit_exceeded`**. **Quotas:** **429 `daily_quota_exceeded`** (Free plan only: 100/day, resets at midnight UTC) and **429 `monthly_quota_exceeded`** (Free: 3,000/month). Quotas count emails, not requests. "Each batch request counts as one request against your rate limit." | docs `api-reference/rate-limit`, `api-reference/errors`, `llms-full.txt:57402,57469` |
| F8 | Auth and sender errors: 401 `validation_error` / `missing_api_key` / `restricted_api_key` (bad, missing or restricted key); 403 `validation_error` (domain not verified, testing restrictions); 403 `restricted_api_key` (key not active); **400 `validation_error` "API key is invalid"** for a malformed `Authorization` header (for example, a stray quote in `RESEND_API_KEY`). These fail every request until someone fixes the configuration. **Not documented:** whether, in permissive mode, an unverified sender fails the whole request or comes back per email in `errors` (Q2 (b) checks it). | docs `api-reference/errors` |
| F10 | `render(node): Promise<string>` is exported by `@react-email/components` (a direct dependency, `package.json:52`; re-exports `@react-email/render` 2.0.6). It's the same function the SDK calls (`dist/index.mjs:210-216`). | `node_modules/@react-email/render/dist/node/index.d.mts:37` |
| F9 | `RESEND_BASE_URL` overrides the API base URL (used only for the local checks in §12, with a local mock server). | `dist/index.mjs:1036,1063` |

### 4.2 Vercel
- "Cron delivery can also occasionally invoke the same scheduled run more than once … cron jobs should be resilient to both missed runs and duplicate runs." "Vercel will not retry an invocation if a cron job fails." (docs `cron-jobs/manage-cron-jobs`, fetched 2026-11-12.)
- The function duration limit is `maxDuration` (300 s here). When it's exceeded, the function is killed: `recordCronSuccess` never runs, so the next run starts from the previous run's cursor and resumes.

## 5. Invariants that must not break
1. **Same recipients, same content.** An employee gets a reminder exactly when the current code would send one: same skip rules (entry today / weekend / deadline days / submitted or approved / opted out of deadline reminders / seed domains), same subject, same template props, same `appUrl` (`tenantBaseUrl(tenant.slug)`).
2. **Daily reminders stay unconditional** (H1): the daily cron never reads `notification_preferences`.
3. **Success only with a message id** (`BLUEPRINT-STANDARD.md` §3.3). Count a reminder as sent only when Resend returns a non-empty id for it.
4. **Never log a full address.** Logs and Sentry carry the recipient **domain** only. Resend's per-email error messages can contain the address, so redact them (§6.2).
5. **Tenancy isolation.** A batch holds one workspace's reminders only. Never mix tenants in a request.
6. **Rotation and resume** (P6 §4, audits A10, R1): the budget is checked before every employee; a tenant that stops **for the time budget** reports the last employee it finished (an email stop keeps its starting position, §6.4); resumes are per tenant; a stop inside the first tenant still moves the cursor past it. **New:** every employee before `stoppedAfter` was either skipped or **had its batch sent** before the tenant returned.
7. **Resend's 10 requests/s team limit.** Each reminder cron stays at ≤ 2 requests/s, so all three crons together stay ≤ 6/s.
8. **Never throws on a send failure.** The batch helper returns an outcome; a send failure never fails the tenant or the run.
9. **Notices untouched** (Q1).

## 6. Design

### 6.1 Message builders (`src/lib/email/reminder-messages.ts`, new)
Replace the two reminder senders with two pure builders that return what a batch needs. They live in a **new module**, not in `send.ts`: 7 integration files mock `@/lib/email/send` with an explicit export list (§3.4), and `authorization.test.ts:441-470` loads both cron routes under that mock. A builder exported from `send.ts` would be missing from those mocks.

```ts
export type ReminderMessage = { to: string; subject: string; react: React.ReactElement };
export function dailyReminderMessage(data: { employeeEmail; employeeName; todayDate; appUrl }): ReminderMessage;
export function submissionDeadlineMessage(data: { employeeEmail; employeeName; periodLabel; deadlineDate; appUrl }): ReminderMessage;
```

- Subjects and template props are **exactly** today's (`send.ts:154-159`, `:174-180`).
- **Delete** `sendDailyReminderEmail` and `sendSubmissionDeadlineEmail` from `send.ts`. Nothing else calls them (§3.4).
- **Leave** the 7 integration mock factories that list them **untouched**. An extra key in a `vi.mock` factory is harmless, and editing 7 unrelated files widens the diff for no gain.
- The cron routes import the builders from `@/lib/email/reminder-messages` and the helper from `@/lib/email/send-batch`. Neither module is mocked by any existing test.

### 6.2 Batch helper (`src/lib/email/send-batch.ts`, new)

```ts
export const REMINDER_BATCH_SIZE = 100;          // F2
export const BATCH_ATTEMPT_TIMEOUT_MS = 12_000;  // the SDK has no timeout (F5)
export const BATCH_RETRY_DELAY_MS = 2_000;
export const BATCH_MAX_ATTEMPTS = 3;

export type BatchStopReason = 'email-quota' | 'email-config';
export type BatchOutcome =
  | { kind: 'disabled' }
  | { kind: 'sent'; sent: number; failed: number }          // failed > 0 only for per-email rejections
  | { kind: 'failed'; failed: number; errorName: string }   // the whole batch, after any retries
  | { kind: 'stop'; failed: number; reason: BatchStopReason };

export async function deliverReminderBatch(
  label: 'daily-reminder' | 'submission-deadline',
  messages: ReminderMessage[],
  opts: { idempotencyKey: string; notAfter: number; now?: () => number },
): Promise<BatchOutcome>;
```

**Before the first attempt**
1. `messages.length` must be between 1 and 100. Otherwise throw a `RangeError`: that's a programming error, and the caller chunks.
2. `resend === null` → `{ kind: 'disabled' }`, with no request and no rendering.
3. **Render once.** For each message, `html = await render(m.react)` (F10). Build the payload array once: `{ from: EMAIL_FROM, to: m.to, subject: m.subject, html }`. It has **no `react` field**, so the SDK neither renders nor mutates anything (F3). Every retry sends this exact array, so the body is byte-identical and matches the idempotency key. Rendering sits outside the attempt timeout. If rendering throws → `failed`, `errorName` = the error's `name`, no request.

**Each attempt.** `resend.batch.send(payload, { idempotencyKey, batchValidation: 'permissive' })`, raced against a `BATCH_ATTEMPT_TIMEOUT_MS` timer as in `notices.ts:245-254`. Clear the timer in `finally`. Read the result as `const { data: body, error } = result` (F4): **`body.data` is the array of `{ id }`, and `body.errors` the per-email errors.**

**Classifying one attempt** (first matching row wins):

| # | Attempt result | Class | Action |
|---|---|---|---|
| A1 | `error` is null and `Array.isArray(body?.data)` | ok | `sent` = entries of `body.data` with a non-empty string `id`. `failed` = `messages.length − sent`. If `body.errors` is non-empty, or `sent + (body.errors?.length ?? 0) ≠ messages.length`, send one Sentry warning per batch (below). Return `sent`. **Processing here must never throw:** treat a non-array `errors` as empty, and an `index` that isn't an integer within `messages` as domain `unknown`. |
| A2 | `error` is null, `body.data` not an array | unexpected | No retry (the same key would return the same body). Return `failed`, `errorName: 'unexpected_response'`. |
| A3 | `error.name` is `daily_quota_exceeded` or `monthly_quota_exceeded` | quota | **No retry.** Return `stop`, `reason: 'email-quota'`. Checked **before** any 429 rule (F7). |
| A4 | `error.statusCode` is 401 or 403; or `error.name` is `missing_api_key`, `invalid_api_key` or `restricted_api_key`; or `statusCode === 400` with `name === 'validation_error'` and a message matching `/api key/i` | config | **No retry.** Return `stop`, `reason: 'email-config'`. |
| A5 | `error.name` is `rate_limit_exceeded`, or `statusCode === 429` with any other name | rate limited | Retry. |
| A6 | `error.name === 'concurrent_idempotent_requests'` | in flight elsewhere | Retry (F6). |
| A7 | Our timeout fired; or `statusCode` is `null` or not a number; or `statusCode >= 500`; or `error.name` isn't a string (for example, a JSON 502 from a proxy, passed through by the SDK unchanged, `dist/index.mjs:1074-1079`) | unknown or server | Retry, **same key**. The first request may have gone through; the key makes the retry safe (F6). |
| A8 | `error.name === 'invalid_idempotent_request'` | key mismatch | No retry. Return `failed`. Sentry **warning** (§6.3 says when this can happen). |
| A9 | Any other `error` (400 / 422 `validation_error`, `invalid_idempotency_key`, …) | rejected | No retry. Return `failed` with `error.name`. |
| A10 | `batch.send` throws | rejected | No retry. Return `failed`, `errorName` = the error's `name`. |

**Retries**
- After a retryable result (A5–A7), and **before waiting**, check the time cap: if `now() + BATCH_RETRY_DELAY_MS + BATCH_ATTEMPT_TIMEOUT_MS > notAfter`, stop and return `failed` with the last error name. Otherwise wait `BATCH_RETRY_DELAY_MS` and attempt again with the same payload and key.
- The **first** attempt always runs, whatever `notAfter` says: the caller only flushes when it must.
- At most `BATCH_MAX_ATTEMPTS` attempts in total. If the last attempt is still A5–A7, return `failed` with the last error name.
- A batch whose retries end on A6 or A7 may in fact have been sent (FM18). It's counted as failed: the count errs towards "not sent", and never records success without an id.

**Sentry and logs.** One `console.error` plus one `Sentry.captureMessage` per batch that has any failure. The console line is exactly `` `Reminder batch failed (${label}): ${errorName} [${failed} of ${batchSize}; domains: ${recipientDomains.join(', ')}]` `` (for a partial A1, `errorName` is `partial`). Level `error` for `failed` / `stop`, `warning` for a partial A1 and for A8. `extra` holds:
- `label`, `errorName`, `batchSize`, `failed`;
- `recipientDomains`: the domains of the failed messages (from `body.errors[].index` for A1; all messages otherwise), deduplicated, at most 20;
- `firstErrorMessage`: the first error message with every `\S+@\S+` replaced by `[redacted]`.

Never put a full address in logs. The idempotency key holds only ids and a hash (§6.3).

**A1 doesn't map `body.data[i]` to `messages[i]`.** F4 leaves open whether failed entries keep their positions. Counting non-empty ids is correct either way, and failed recipients come from `errors[].index`.

### 6.3 Idempotency key
`reminderBatchKey(cron, tenantId, localDate, userIds)` (exported from `send-batch.ts`):
- Format: `rem:<cron>:<tenantId>:<localDate>:<hex>`, where `hex` is the SHA-256 of the **sorted** user ids joined with `,`.
- At most 4 + 19 + 1 + 36 + 1 + 10 + 1 + 64 = 136 characters (≤ 256, F6).
- `tenantId` is `tenants.id` (uuid; `src/db/control-plane/schema.ts:13`), not the slug. `localDate` is the tenant's `today` that the cron already computes.

**What it guarantees**
- A retry inside the helper, or a duplicate invocation that builds the same batch (same workspace, same day, same recipients), gets Resend's stored response. **No second email**, and the second run counts the batch as sent.
- A duplicate run that builds a **different** set gets a different key. Batches are cut by count, so one employee entering time between the runs changes their batch and every later batch in that workspace. Those people can get a second reminder. That's the same as today, only narrower. Closing it fully needs a run lock, which is out of scope.
- **`invalid_idempotent_request` (A8)** happens only when the same cron, workspace, day and recipients produce a different body inside 24 h: an employee renamed between two runs, a template change deployed between them, or a slug change. The first run almost certainly sent; this run counts the batch as failed, with a warning.

### 6.4 Cron loops (both routes)
**Sweep context.** `processTenant` gets one more field: `sendCutoff` (epoch ms) = the sweep's budget deadline + `REMINDER_SEND_GRACE_MS` (20 s, exported from `tenant-sweep.ts`). It's passed to the helper as `notAfter`, so no batch attempt runs past 260 s.

**Run-level failure breaker.** One counter per run (shared by every tenant): `consecutiveBatchFailures`.
- Reset to 0 after any batch with `sent > 0`.
- Incremented after a `failed` outcome, and after a `sent` outcome with `sent === 0`. **Not** incremented when the `failed` outcome's `errorName` is `concurrent_idempotent_requests`: that means a duplicate run is sending the same batch (FM8), not that Resend is failing.
- `disabled` neither increments nor resets it.
- At **3**, stop with reason `email-failing`. It catches what A3/A4 can't name: a malformed key that Resend reports another way, an unverified sender rejected per email, or a long outage.

Per tenant, after the existing gates (weekend / deadline days) and queries:

```ts
const pending: { userId: string; message: ReminderMessage }[] = [];
let lastDone: string | null = resumeAfter;

async function flush(): Promise<CronStopReason | null> {
  if (pending.length === 0) return null;
  await sendThrottle();                                   // one throttle per batch request
  const outcome = await deliverReminderBatch(CRON, pending.map((p) => p.message), {
    idempotencyKey: reminderBatchKey(CRON, tenant.id, today, pending.map((p) => p.userId)),
    notAfter: sendCutoff,
  });
  pending.length = 0;
  // totals: sent += outcome.sent ?? 0; failed += outcome.failed ?? 0; batches++ unless 'disabled'
  // breaker: update consecutiveBatchFailures as above
  if (outcome.kind === 'stop') return outcome.reason;
  return consecutiveBatchFailures >= 3 ? 'email-failing' : null;
}

for (const emp of allEmployees) {
  if (outOfTime()) {
    const stop = await flush();
    return stop ? { stoppedAfter: resumeAfter, reason: stop } : { stoppedAfter: lastDone };
  }
  lastDone = emp.id;                // exactly where it's set today
  // …existing skip rules, unchanged (`continue` on a skip)…
  pending.push({ userId: emp.id, message: dailyReminderMessage({ ... }) });
  if (pending.length === REMINDER_BATCH_SIZE) {
    const stop = await flush();
    if (stop) return { stoppedAfter: resumeAfter, reason: stop };
  }
}
const stop = await flush();
return stop ? { stoppedAfter: resumeAfter, reason: stop } : 'done';
```

- **Where a stopped tenant resumes depends on why it stopped.**
  - **Time budget** (unchanged rule): `{ stoppedAfter: lastDone }`, after the post-budget flush. That flush can't return an email stop and still use this rule; see the next item.
  - **Email stop** (`email-quota`, `email-config`, `email-failing`, including one returned by the post-budget flush): **`{ stoppedAfter: resumeAfter, reason }`**, the position this run started from for that tenant. The saved resume point stays as it was.
  - **Why:** a resume point makes the next day's run skip everyone at or before it (`gt(users.id, resumeAfter)`, `daily-reminder/route.ts:73`). Today an email failure never saves one, so the next day every eligible employee is reminded. Saving `batchStartsAfter` on an email stop would quietly drop the employees in that workspace's already-sent batches from the next day's reminders. Returning `resumeAfter` keeps today's next-day behaviour **when the tenant had no saved resume point**, the normal case.
  - **Accepted trade-offs:**
    - A workspace bigger than the remaining quota restarts from the same place each day.
    - A tenant that already had a resume point (say `r0`, from an earlier budget stop) keeps `r0`, so employees at or before `r0` miss the next sending day too. Today that tenant would have finished with failed sends and cleared `r0`. This needs a budget stop followed by an email stop in the same workspace.
- **`CronStopReason`** = `BatchStopReason | 'email-failing'`.
- **Run-level stop.** A `{ reason }` outcome makes `sweepTenants` break, as any non-`'done'` outcome does today (`tenant-sweep.ts:84-90`). No further tenant is processed this run, so no request is wasted on a quota that's gone, a key that's wrong, or an outage.
- **`disabled`** (no API key): nothing is counted (as today), `batches` isn't incremented, the breaker isn't touched, and the loop continues.
- **A tenant that throws** after some batches were sent: unchanged sweep handling (`:92-97`). Unsent `pending` items are dropped. That's the same as today, where the employees after the throw are never reached.

### 6.5 Sweep stop reason (`src/lib/cron/tenant-sweep.ts`)
- `TenantOutcome` becomes `'done' | { stoppedAfter: string | null; reason?: CronStopReason }`. A missing `reason` means the time budget. Define `CronStopReason` here and import it in the routes; `send-batch.ts` keeps `BatchStopReason`.
- `processTenant`'s context gains `sendCutoff` (§6.4).
- `SweepResult` gains `stopReason: 'budget' | CronStopReason | null` (`null` when complete).
- `sweepTenants`' resume and cursor handling is unchanged for every stop. It saves whatever `stoppedAfter` the tenant returns; for email stops, that's the unchanged `resumeAfter` (§6.4). Add `console.warn(\`Cron ${name} stopped sending: ${reason}\`)` next to the email-stop Sentry message.
- **The alert's `detail` gains `stopReason`** for every stop, including `'budget'`. `raiseAlert` stores only `detail`, never `summary` (`src/lib/tenant/lifecycle-store.ts:58-70`), and bumping an already-open alert sends no email (`ops-alert-email.ts:24`). So `detail` is the only record that survives on the alert row and in the digest (`ops-digest.ts:127`). One `dedupKey` per cron, as today; a complete run resolves the alert, as today.
- **Budget stop:** today's Sentry warning and alert summary text, unchanged.
- **Email stop** (`email-quota`, `email-config`, `email-failing`):
  - `Sentry.captureMessage(\`cron ${name} stopped sending: ${reason}\`, { level: 'error', extra: detail })` on **every** occurrence. This is the one signal guaranteed to fire, because the alert's email probably fails for the same reason.
  - Summary text: `The ${name} cron stopped sending after ${processed} of ${n} workspaces because ${REASON_TEXT[reason]}. The next run starts after "${cursor ?? '(start)'}"; reminders it didn't send today are not re-sent.` (plus the existing "resumes mid-way" clause). `REASON_TEXT`:
    - `email-quota` → "Resend's email quota ran out";
    - `email-config` → "Resend rejected the API key or sender domain";
    - `email-failing` → "three email batches in a row failed".
- **Time-box the alert call.** Race `raiseAlertWithEmail(...)` against a 10 s timer inside `sweepTenants` (it never throws; on timeout, log and carry on). Its email has no timeout of its own (`ops-alert-email.ts:35`), and a hang there would cost the run its `cron_runs` success record. `ops-alert-email.ts` itself is unchanged.

### 6.6 Summary fields (both routes)
Add `batches` (batch requests made, counting a retried batch once) and `stopReason` (`sweep.stopReason`: `null`, `'budget'`, `'email-quota'`, `'email-config'` or `'email-failing'`). Keep every existing field and meaning. `sent` counts reminders with a message id; `failedSends` counts reminders in failed, stopped or partly rejected batches.

### 6.7 Deadline cron: one read per workspace (`submission-deadline/route.ts`)
After the deadline-day gate (`:75`), before the employee loop:

```ts
const closed = new Set((await db.select({ userId: timesheetPeriods.userId }).from(timesheetPeriods)
  .where(and(eq(timesheetPeriods.periodStart, periodStart), inArray(timesheetPeriods.status, ['submitted', 'approved']))))
  .map((r) => r.userId));
const optedOut = new Set((await db.select({ userId: notificationPreferences.userId }).from(notificationPreferences)
  .where(eq(notificationPreferences.emailDeadlineReminder, false)))
  .map((r) => r.userId));
```

- In the loop, skip if `closed.has(emp.id)` or `optedOut.has(emp.id)`. Same rules as `:105-117`: a `draft` or `rejected` period, or no period, gets a reminder; no preference row means on (`notification_preferences.user_id` is unique, `schema.ts:495`).
- Keep the order of checks: `outOfTime()`, `lastDone`, seed skip, then these sets.

### 6.8 Constants and comments
- `rate.ts`: values unchanged. The comment becomes: each cron sender makes at most 2 **requests** per second (a batch is one request).
- `tenant-sweep.ts` header: add the stop reasons, `sendCutoff` and the alert time-box.
- Route headers: mention batching.
- No env var, migration, schema or `vercel.json` change.

## 7. States

### 7.1 One batch (`deliverReminderBatch`)
| State | Event | Next | Side effects |
|---|---|---|---|
| start | `resend === null` | done: `disabled` | none |
| start | 0 or > 100 messages | throws `RangeError` | none (caller bug; a test pins it) |
| start | rendering throws | done: `failed` | Sentry error; no request |
| start | rendered | attempt 1 (runs even past `notAfter`) | one request |
| attempt n | A1 ok | done: `sent` | Sentry warning if any per-email failure or count mismatch |
| attempt n | A2 unexpected | done: `failed` | Sentry error |
| attempt n | A3 quota | done: `stop/email-quota` | Sentry error |
| attempt n | A4 config | done: `stop/email-config` | Sentry error |
| attempt n < 3 | A5 / A6 / A7, and the next attempt fits before `notAfter` | wait 2 s → attempt n+1 | same payload, same key |
| attempt n < 3 | A5 / A6 / A7, next attempt doesn't fit | done: `failed` | Sentry error |
| attempt 3 | A5 / A6 / A7 | done: `failed` | Sentry error |
| attempt n | A8 mismatch | done: `failed` | Sentry warning |
| attempt n | A9 / A10 | done: `failed` | Sentry error |

### 7.2 One tenant (cron loop)
| State | Event | Next | Side effects |
|---|---|---|---|
| looping | out of time, `pending` empty | returns `{ stoppedAfter: lastDone }` | none |
| looping | out of time, `pending` non-empty | flush → if email stop: `{ stoppedAfter: resumeAfter, reason }`, else `{ stoppedAfter: lastDone }` | one batch request |
| looping | employee skipped | looping | `lastDone` advances (as today) |
| looping | employee queued, `pending` < 100 | looping | none |
| looping | employee queued, `pending` reaches 100 | flush → looping, or stop as above | one batch request |
| looping | a flush returns an email stop, or trips the breaker | `{ stoppedAfter: resumeAfter, reason }` | none further |
| looping | loop ends | flush → `'done'` or stop | at most one batch request |
| any | a query throws | the sweep catches (unchanged) | Sentry; tenant counted failed; resume entry deleted |

"Can't happen": a stop outcome with `pending` still non-empty. `flush` always empties it.

## 8. Failure modes
| # | Situation | What happens | Covered by |
|---|---|---|---|
| FM1 | Resend times out, but the batch was accepted | Retry with the same key → stored response, no second email (F6) | B10, K1 |
| FM2 | Network failure (`statusCode: null`) | Retry, same key | B11 |
| FM3 | 429 rate limit | Retry after 2 s, up to 3 attempts | B5, B6 |
| FM4 | Daily or monthly quota runs out mid-run | Stop: no more requests this run; Sentry error and the alert's `detail` name the quota; the next tenant isn't touched; the stopped tenant's resume point is unchanged (§6.4). Notices stay pending and retry every 10 minutes (Q3). **Assumed, undocumented:** a batch bigger than the remaining quota is rejected whole, and a rejected request isn't stored under its idempotency key (the docs say Resend checks whether an email with the key "has already been sent"). If Resend instead sent part of a batch behind a 429, those people could get that day's reminder again on a same-day manual re-run. Accepted: rare, and visible in Sentry. | B7, B8, C7, S1 |
| FM5 | Bad API key or unverified sender domain (401 / 403 / 400 "API key") | Stop with `email-config` | B9, B9b, C8 |
| FM6 | One invalid address in a batch | Permissive: the other 99 send; one failure counted; Sentry with the domain only and the message redacted | B2 |
| FM7 | The whole batch is rejected (400 / 422) | `failed` for that batch; the run continues; a third such batch in a row trips the breaker | B15, C9, C14 |
| FM8 | Vercel invokes the run twice at once | Same batches, same keys: one request gets 409 concurrent → retries → stored response. One email each. Both runs write a summary. A run that ends incomplete after the other completed can overwrite its summary (`heartbeat.ts:73`) and leave a false `cron-incomplete` alert, resolved by the next complete run. Concurrent-409 failures don't count towards the breaker (§6.4), so a slow Resend can't make the duplicate run raise a false `email-failing` stop. If both runs hit the time budget, they stop at different employees, so their last partial batches get different keys, and those people can get two reminders. Together the two runs can approach Resend's 10 requests/s for a few seconds; a 429 retries. | B13, K1, C14 |
| FM9 | Vercel invokes the run twice, minutes apart | Same set → stored response, no email. A changed set → new keys from that batch on, and those people get a second reminder (as today, narrower; §6.3). | K1 |
| FM10 | Template change deployed between duplicate runs | 409 `invalid_idempotent_request` → `failed` + warning; those employees most likely already got the first run's email | B14 |
| FM11 | The budget runs out with a batch queued | One flush, capped by `notAfter` (260 s), then stop | C5, C13, B19 |
| FM12 | Resend hangs for the whole run | Each batch: attempts until `notAfter`; the breaker stops the run after 3 failed batches; the alert call is capped at 10 s. Bound below. | B19, B21, C14, S3 |
| FM13 | The function is killed at 300 s anyway | No success record; the next run starts from the previous cursor and resumes. Same as today; §9 keeps this out of reach. | — (documented) |
| FM14 | A tenant DB query throws mid-tenant | Unchanged sweep handling; queued, unsent reminders are dropped | existing `cron-ops` test |
| FM15 | `RESEND_API_KEY` unset (local, CI) | `disabled`: nothing sent or counted; the cron completes | B16, C10 |
| FM16 | A missed cron day | Unchanged: reminders aren't back-filled | — (unchanged) |
| FM17 | Failed entries keep their positions in `body.data` with no id | Counting non-empty ids still works | B3 |
| FM18 | Retries end on A6/A7 although Resend sent the batch | Counted `failed` (errs towards "not sent"); emails went out once | B6, B10 |
| FM19 | A slow cold render | Outside the attempt timeout, so it can't trigger a retry; the dev measures it (§13) | B1 |

## 9. Platform limits and capacity
- **Resend rate limit (F7):** a batch is one request. Each reminder cron makes ≤ 2 requests/s; with notice delivery, all three stay ≤ 6/s of the team's 10.
- **Vercel duration:** `maxDuration = 300` (unchanged literal).
  - The budget is 240 s.
  - No batch attempt starts unless it can end by 260 s (`notAfter`; the first attempt of a flush always runs, and a flush can only begin before 240 s or as the single post-budget flush, so it ends by ≈ 252 s + render).
  - Then the alert call (≤ 10 s) and two `cron_runs` writes.
  - **Bound ≈ 275 s.**
- **Capacity:** a workspace that sends costs its DB reads (3 queries daily, 5 deadline, independent of headcount after §6.7), rendering (≈ 100 templates), and one request per 100 reminders, spaced ≥ 500 ms. At roughly 0.5–1.5 s per sending workspace, one run covers about **160–480 sending workspaces**. At 30 employees each, that's about 5,000–14,000 reminders per run, against today's 480. A workspace with nothing to send costs only its reads. The dev records a measured render time for 100 messages in the impact analysis.
- **Memory:** 100 rendered emails (a few MB) per request at most; they're released after the flush.
- **Neon:** the deadline cron drops from 2 queries per employee to 2 per workspace.
- **Resend quota (business):** see Q3 and §10.3.

## 10. Blast radius
### 10.1 Changed
| File | Change |
|---|---|
| `src/lib/email/reminder-messages.ts` | **New:** `ReminderMessage`, `dailyReminderMessage`, `submissionDeadlineMessage`. |
| `src/lib/email/send.ts` | Delete the two reminder senders **and their now-unused template imports** (`:6-7`). `deliverEmail` and every other sender are unchanged. |
| `src/lib/email/send-batch.ts` | **New:** `deliverReminderBatch`, `reminderBatchKey`, the constants. |
| `src/lib/email/rate.ts` | Comment only. |
| `src/lib/cron/tenant-sweep.ts` | `CronStopReason`, `REMINDER_SEND_GRACE_MS`, `sendCutoff` in the context, `reason` on the stop outcome, `stopReason` on the result and in the alert `detail`, reason-specific Sentry and alert text, the 10 s alert time-box (§6.5). |
| `src/app/api/cron/daily-reminder/route.ts` | Batch loop and breaker (§6.4), summary fields (§6.6). |
| `src/app/api/cron/submission-deadline/route.ts` | Batch loop and breaker, workspace-level reads (§6.7), summary fields. |
| `src/__tests__/unit/reminder-crons.test.ts` | See the harness notes under §11. |
| `src/__tests__/unit/email-send.test.ts` | Remove `:27-28` and `:123-124` (the deleted senders). |
| `src/__tests__/unit/reminder-messages.test.ts` | **New:** M1. |
| `src/__tests__/unit/email-send-batch.test.ts` | **New:** B1–B24, B9b, K1. |
| `src/__tests__/unit/cron-ops.test.ts` | Add S1–S4. Make its Sentry mock (`:23`) record the options argument, so `level` can be asserted. |
| `src/__tests__/integration/reminder-batch-cron.test.ts` | **New:** I1–I3. |

### 10.2 Checked, unchanged
`notices.ts` (Q1), `ops-alert-email.ts`, `lifecycle-store.ts`, `ops-digest.ts`, `send-signup.ts`, the templates, `vercel.json`, `heartbeat.ts`, `run-cron.ts`, `email-schedule-throttle.test.ts`, `route-segment-config.test.ts`, `reminder-email-footer.test.ts`, `authorization.test.ts`, the 7 integration mock factories (§6.1), and `scripts/smoke-tenancy.sh`.

### 10.3 For the product owner, not the dev
`PRODUCTION-DEPLOY.md:228` says "Resend — Free tier is fine to start". The Free plan allows **100 emails/day and 3,000/month** (F7). A single workspace of 30 employees can reach 100 daily reminders in about 4 weekdays of missed entries, plus deadline reminders. This is the business item "Resend account" on the tracker. When the plan runs out, this blueprint makes the failure loud and cheap (FM4), but it can't add quota. See Q3.

## 11. Required tests (each must fail without the change it proves)

**Mock shape (every B-row).** `batch.send` resolves the SDK's real envelope.
- Success: `{ data: { data: [{ id }…], errors: [{ index, message }…] }, error: null, headers: null }`. Use `errors: []` when there are none.
- Error: `{ data: null, error: { name, message, statusCode }, headers: null }`.
- Type the mock with `CreateBatchResponse<{ batchValidation: 'permissive' }>`, imported from `resend`, for example `vi.fn<() => Promise<CreateBatchResponse<{ batchValidation: 'permissive' }>>>()`. The lead checked with `tsc` that this type rejects a flat `data: [...]`. **Don't use `Awaited<ReturnType<Resend['batch']['send']>>`: it resolves to `any`.**
- Deliberately malformed envelopes (B4, B23, B24) are cast with `as unknown as CreateBatchResponse<…>`: `tsc` checks test files too (`tsconfig.json` includes `**/*.ts`).
- B20 pins the envelope against the real SDK.

**Fake timers.** Fake only `setTimeout`, `clearTimeout` and `Date`: `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })`. Vitest's default also fakes `setImmediate`, which React's server renderer uses, so a real `render()` would never settle. Drive waits with `vi.advanceTimersByTimeAsync`, but first wait for the `batch.send` call to happen (`await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(n))`, which uses real timers). Rendering settles on real `setImmediate` ticks, so the attempt timer doesn't exist until then.

**Batch helper** (`unit/email-send-batch.test.ts`, mocking `@/lib/email/client` with `resend.batch.send`; fake timers for waits and timeouts; `now` injected)
| # | Scenario | Expect |
|---|---|---|
| B1 | 3 messages, success | One `batch.send` call: 3 items with `from: EMAIL_FROM`, each `to` / `subject`, a non-empty `html` string, and **no `react` key**; options `{ idempotencyKey, batchValidation: 'permissive' }`; returns `sent: 3, failed: 0`; no Sentry. |
| B2 | Partial: `body.data` 2 ids, `body.errors: [{ index: 1, message: 'Invalid \`to\` field: bad@x-corp.com' }]` | `sent: 2, failed: 1`; one Sentry warning whose `extra` has `recipientDomains: ['x-corp.com']`; no `bad@` anywhere in the Sentry call or console output. |
| B3 | `body.data: [{ id: '' }, { id: 'm2' }]` | `sent: 1, failed: 1`. |
| B4 | `body: { data: {} }` (not an array) | One call (no retry); `failed`, `unexpected_response`. |
| B5 | `rate_limit_exceeded` then success | Two calls with the **same** key and a deep-equal payload; second call ≥ 2 s after the first; `sent`. |
| B6 | Rate limited 3 times | Exactly 3 calls; `failed`; one Sentry error. |
| B7 | `{ name: 'daily_quota_exceeded', statusCode: 429 }` | Exactly 1 call; `stop`, `email-quota`, `failed` = size. |
| B8 | `monthly_quota_exceeded` | Same as B7. |
| B9 | 401 `validation_error`; separately 403 `validation_error` | 1 call each; `stop`, `email-config`. |
| B9b | 400 `validation_error`, message "API key is invalid" | 1 call; `stop`, `email-config`. A 400 `validation_error` with another message → `failed` (B15). |
| B10 | First call never settles | The second call starts at 14 s (12 s timeout + 2 s wait), with the same key; success → `sent`. |
| B11 | `{ name: 'application_error', statusCode: null }` then success | 2 calls; `sent`. |
| B12 | 500 then success | 2 calls; `sent`. |
| B13 | `concurrent_idempotent_requests` then success | 2 calls, same key; `sent`. |
| B14 | `invalid_idempotent_request` | 1 call; `failed`; Sentry **warning**. |
| B15 | 422 `validation_error` | 1 call; `failed`. |
| B16 | `resend` is `null` | No call; `disabled`. |
| B17 | `batch.send` throws | 1 call; `failed`; the helper doesn't throw. |
| B18 | 0 messages; 101 messages | `RangeError`; no call. |
| B19 | 3 timeouts in a row, `notAfter` far away | Settles `failed` at 40 s of fake time, not later. |
| B20 | **Real SDK:** `new Resend('re_test')` with a stubbed global `fetch` returning HTTP 200 `{"data":[{"id":"a"},{"id":"b"}]}` | `sent: 2`; the stubbed request went to `/emails/batch` with headers `Idempotency-Key` (the key) and `x-batch-validation: permissive`, and a JSON body of 2 objects with `html` and no `react`. Inject the client through the module mock or a test seam, not by editing `client.ts`. |
| B21 | `notAfter` = now + 13 s; first attempt times out | No second attempt (12 + 2 + 12 > 13); `failed` at 12 s of fake time. And with `notAfter` already in the past, the first attempt still runs. |
| B22 | Rendering throws | No `batch.send` call; `failed`. |
| B23 | `body.errors: [{ index: 999, message: 'x' }]` and `[{ index: 'a', message: 'y' }]` with 2 ids for 3 messages | The helper doesn't throw; `sent: 2, failed: 1`; `recipientDomains` contains `unknown`. |
| B24 | `{ data: null, error: { message: 'Bad Gateway' } }` (no `name`, no `statusCode`) then success | 2 calls (classified A7); `sent`. |
| K1 | `reminderBatchKey` | Same output for the same ids in any order; differs when the cron, tenant, date or any id differs; ≤ 256 characters; contains no email address. |

**Builders** (`unit/reminder-messages.test.ts`)
| # | Scenario | Expect |
|---|---|---|
| M1 | Each builder | Subject strings exactly as today (`Reminder: Enter Your Time for …`, `Submit Your Timesheet — Due …`); `to` is the employee's address; the React element's props include the caller's `appUrl` (replaces `email-send.test.ts:123-124`). |

**Cron loops** (`unit/reminder-crons.test.ts`, both crons through `describe.each` unless noted)

Harness notes:
- Mock `@/lib/email/send-batch` by spreading `importOriginal` and replacing only `deliverReminderBatch`, so `REMINDER_BATCH_SIZE` and `reminderBatchKey` stay real.
- Give the tenant fixture (`:13`, `:107-110`) an `id`.
- The mocked `sweepTenants` (`:45-53`) must break on any non-`'done'` outcome (as the real sweep does), return `stopReason`, and pass `sendCutoff`. Or use the real sweep with `readCronState` and the alert functions mocked. Say which in the impact analysis.

| # | Scenario | Expect |
|---|---|---|
| C1 | Seed domains and an exempt real tenant (existing) | Batched messages go only to the real addresses; `skippedSeedRecipients: 2`; `sent: 2`. |
| C2 | A9 adapted | Log is `throttle, batch(demo×1), throttle, batch(comped×2)`; every message's `appUrl` is its own tenant's host; no batch mixes tenants. |
| C3 | 250 eligible employees in one tenant | 3 batches of 100, 100, 50, in id order; 3 throttles; `batches: 3`. |
| C4 | Out of time before the first employee (existing, adapted) | No batch; outcomes `[{ stoppedAfter: null }]`: the sweep breaks after the first tenant, so the second isn't processed (was one outcome per tenant at `:147`). |
| C5 | Out of time after c1 (existing, adapted) | c1 is sent in a batch of 1 **before** the tenant returns; `{ stoppedAfter: 'c1' }`. |
| C6 | Resumed tenant (existing) | Queries `gt(users.id, 'c1')`. |
| C7 | The first batch of tenant 1 returns `stop/email-quota` (tenant resumed after `r0`) | No further batch call (tenant 2 isn't processed); outcome `{ stoppedAfter: 'r0', reason: 'email-quota' }` (the unchanged resume point); summary `stopReason: 'email-quota'`. |
| C8 | No saved resume; 101 eligible employees with a seed-domain employee between employee 100 and 101; batch 1 `sent`, batch 2 returns `stop/email-config` | `{ stoppedAfter: null, reason: 'email-config' }`: an email stop keeps the run's starting position, not employee 100 or the seed-domain employee (§6.4). `sent: 100`. |
| C9 | Tenant 1's batch returns `failed` | `failedSends` += its size; tenant 2 is still sent. |
| C10 | Helper returns `disabled` | `sent: 0`, `failedSends: 0`, `batches: 0`; the run completes. |
| C11 | Totals across two tenants (one partial: 2 of 3 sent) | `sent: 2 + n`, `failedSends: 1`, `batches: 2`. |
| C12 | The key and cutoff passed | `idempotencyKey` equals `reminderBatchKey(cron, tenant.id, <tenant's local date>, <batch user ids>)`; `notAfter` equals the context's `sendCutoff`. |
| C13 | Tenant resumed after `r0`; out of time with a batch queued, and that flush returns `stop/email-quota` | `{ stoppedAfter: 'r0', reason: 'email-quota' }`, not `lastDone`. |
| C14 | Breaker | (a) Three tenants, each batch `failed`: the third trips it, `stopReason: 'email-failing'`, and a fourth tenant isn't processed. (b) failed, `sent` (with ids), failed, failed: no stop. (c) failed, `sent` with `sent: 0, failed: n`, failed: stop (a zero-sent batch counts). (d) failed, `disabled`, failed, failed: stop (disabled doesn't reset). (e) three `failed` with `errorName: 'concurrent_idempotent_requests'`: no stop. |
| T1, T2 | H1 tests (daily), adapted | Still pass: the opted-out employee gets the daily reminder, and no `notification_preferences` query runs. |

**Sweep** (`unit/cron-ops.test.ts`)
| # | Scenario | Expect |
|---|---|---|
| S1 | A tenant returns `{ stoppedAfter: 'x', reason }` for each of `email-quota`, `email-config`, `email-failing` | `incomplete: true`; `stopReason` = the reason; resume `x` saved; Sentry `level: 'error'` naming the reason; the alert summary contains that reason's text and not "time budget"; **the alert `detail` contains `stopReason`**. |
| S2 | Budget stop (existing test) | Text and level unchanged; `stopReason: 'budget'`, also in `detail`. |
| S3 | `raiseAlertWithEmail` never settles | `sweepTenants` resolves about 10 s later (fake timers) with its result. |
| S4 | `processTenant` context | `sendCutoff` = start + budget + `REMINDER_SEND_GRACE_MS`. |

**Integration** (`integration/reminder-batch-cron.test.ts`)

Harness (the suite runs with `fileParallelism: false` and `__TEST_DB__`; CI uses `REQUIRE_CONTROL_PLANE_TESTS=1`):
- Mock `@/db` so `getDbForUrl` returns `countingDb(__TEST_DB__).db` (`integration/query-counter.ts:6`).
- Mock `@/lib/cron/run-cron` (the real one writes `cron_runs` through the mocked control plane, `run-cron.ts:26`), `@/lib/encryption`, `@/db/control-plane` (the tenant list), `@/lib/tenant/lifecycle`, `@/lib/tenant/registry`, `@/lib/tenant/host` and the sweep, as `unit/reminder-crons.test.ts:38-64` does.
- Build `countingDb(__TEST_DB__)` lazily: `__TEST_DB__` is set only in `setup-db.ts`'s `beforeAll` (`:71`). Use the `vi.hoisted` holder pattern from `integration/review-read.test.ts:19-25`.
- Replace `deliverReminderBatch` with `vi.mock('@/lib/email/send-batch', async (importOriginal) => ({ ...(await importOriginal()), deliverReminderBatch: vi.fn(...) }))` returning `sent`. A `vi.spyOn` on the module namespace wouldn't intercept the route's own import.
- Set the deadline day with `vi.useFakeTimers({ toFake: ['Date'] })`, plus a seeded pay-period config (real `configAt`) or the unit test's `@/lib/date-utils` mock.
- Call `cleanupTestData()` in `beforeEach`.

| # | Scenario | Expect |
|---|---|---|
| I1 | Deadline cron on a deadline day. Employees: `submitted`, `approved`, `draft`, `rejected`, no period, opted out (`email_deadline_reminder = false`), opted in explicitly, a seed-domain address, and one whose **previous** period is `submitted` with no current period | Recipients are exactly: `draft`, `rejected`, no period, opted in, and the previous-period employee. |
| I2 | Deadline cron query count | The same number of tenant-DB queries with 5 eligible employees as with 30. |
| I3 | Daily cron on a weekday | Employees with an entry today are excluded; one with an entry yesterday only is included. |

## 12. Verification
1. **Live Resend check: moved to the staging rehearsal** (PRODUCTION-DEPLOY Phase 12), once the Resend account exists (Q2). The lead sends (a) one permissive batch (`delivered@resend.dev` ×2 plus `not-an-email`), and (b) one batch with `from: noreply@example.com`. It records the **SDK-level** result objects in §4.1 F4 / F8. If either contradicts §6.2 A1 / A4, a fix goes in before production.
2. **Dev gates:** `npx tsc --noEmit`, `npm run lint` (0 errors), `npm run test`, `npm run test:tz`, `npm run db:safety`.
3. **Integration on the product owner's machine:**
   ```bash
   REQUIRE_CONTROL_PLANE_TESTS=1 CONTROL_PLANE_DATABASE_URL="$(grep -h '^CONTROL_PLANE_DATABASE_URL=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" ENCRYPTION_KEY="$(grep -h '^ENCRYPTION_KEY=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" TZ=America/New_York npm run test:integration
   ```
   Expect about 1 skipped file, not 13.
4. **`npm run build`** (Turbopack). No migration, so no `npm run demo:local` re-seed is needed.
5. **Browser checks:** `REMINDER-CAPACITY-BROWSER-CHECKS.md` (written by the lead). They use a local mock Resend server through `RESEND_BASE_URL`, a throwaway workspace with 150 employees, and `curl` against the cron. Expected: 2 batch requests of 100 and 50 with the key and permissive headers, a re-run that reuses the same keys, and a simulated quota error stopping the run.

## 13. Hand-off rules (in addition to `BLUEPRINT-STANDARD.md` §3)
1. Write `REMINDER-CAPACITY-IMPACT-ANALYSIS.md` (uncommitted) first. It covers:
   - the files;
   - the callers (grep the test tree for the two deleted senders, `createSendThrottle` and `sweepTenants`, including `vi.mock` factories);
   - the external facts, re-checked;
   - **the measured render time for 100 messages**;
   - the harness choice for C7 / C14;
   - anything in this blueprint that looks wrong.
2. Commits, in order, each passing `tsc` on its own:
   1. the builders (`reminder-messages.ts`) and the batch helper plus their tests (`send.ts` untouched);
   2. the sweep changes plus S1–S4;
   3. both cron routes, the deletion of the two senders from `send.ts` with their imports, the `email-send.test.ts` edits, the C-tests and the integration file.
3. Every test in §11 must fail without its change. Name the revert check for each in the report.
4. Notices, the templates, `ops-alert-email.ts` and every other sender stay untouched. Any change outside §10.1 goes to the lead, then to the product owner.

## 14. Pre-mortem log
- **Round 1** (2026-11-12, two independent reviewers: send path and sweep; loops, tests and scope). **2 HIGH (the same defect, found by both), 4 MEDIUM, 12 LOW. All fixed in v2.**
  - **HIGH:** the SDK wraps the API body, so the batch array is at `result.data.data`, not `result.data`. As drafted, every successful batch would have counted as failed, and flat test mocks would have hidden it. Fixed in F4 and A1, the mock-shape rule, and B20 (the real SDK with a stubbed `fetch`).
  - **MEDIUM:**
    - The stop reason was lost when the alert was already open, because `raiseAlert` stores only `detail`. `stopReason` now goes into `detail`, and Sentry fires on every stop.
    - The 300 s bound ignored retries and the alert email. Fixed with `notAfter` / `sendCutoff` (260 s) and a 10 s alert time-box.
    - A 400 "API key is invalid" didn't stop the run. Fixed with an A4 rule plus the run-level `email-failing` breaker.
    - I1 couldn't catch a missing `periodStart` filter. Fixed with the previous-period employee.
  - **LOW, fixed:**
    - rendering moved outside the timeout, rendered once with no SDK mutation (B1, B22);
    - F7 now cites "each batch request counts as one request";
    - FM8 notes a possible false alert;
    - FM18: a "failed" batch may have been sent;
    - the §6.4 comment on `batchStartsAfter`, and C8 pinned with a skipped employee between batches;
    - C13 (out-of-time flush returning a stop);
    - test harness notes;
    - integration plumbing;
    - `send.ts` unused imports;
    - §2 item 1 qualified;
    - S3 / S4;
    - Q2 (b) for an unverified sender.
  - **To the product owner:** the quota-reserve question (Q3).
  - **LOW, accepted and documented:** three single-address workspaces with one invalid address each, in a row, would trip the breaker. That's harmless and rare, and the next run starts fresh.
- **Round 2** (2026-11-12, two fresh reviewers, same split). **No HIGH. 4 MEDIUM (one found by both) and 11 LOW. All fixed in v3.**
  - **MEDIUM:**
    - Round 1's mock type, `Awaited<ReturnType<Resend['batch']['send']>>`, resolves to `any`, so flat mocks would still compile. Now `CreateBatchResponse<{ batchValidation: 'permissive' }>`; the lead confirmed with `tsc` that it rejects the flat shape.
    - An email stop saved a mid-workspace resume point, which would have dropped already-reminded employees from the next day's reminders, a change from today. Email stops now keep the run's starting position (§6.4; C7, C8, C13).
    - C4 contradicted the required sweep mock. C4 is adapted.
  - **LOW, fixed:**
    - the retry time cap is checked before the wait, the dead `send_deadline` result is removed, and B10 / B21 timings are corrected;
    - A1 processing can't throw on a bad `index` (B23);
    - an error without `name` or `statusCode` retries (B24);
    - the undocumented quota-within-a-batch behaviour is stated as an accepted assumption (FM4);
    - FM8 covers concurrent duplicate runs: concurrent-409 failures don't count towards the breaker, and budget-stopped duplicates can double-send their last batch;
    - fake-timer settings so real rendering settles;
    - the integration harness gets `run-cron`, `registry` and `host` mocks and a lazy test DB;
    - the commit order keeps `tsc` green per commit;
    - C14 covers zero-sent, `disabled` and concurrent-409 cases;
    - exact console lines are specified for the checks file.
  - **Confirmed sound:**
    - the ≈ 275 s timing bound;
    - byte-identical retry payloads;
    - the bulk-read equivalence;
    - who gets a reminder on the day, unchanged;
    - every §3 line reference;
    - no PII in logs, Sentry or the alert `detail`.
- **Confirmation pass** (2026-11-12, one fresh reviewer, whole of v3). **Verdict: CLEAN, with no HIGH or MEDIUM.** It confirmed:
  - the email-stop resume rule can't stall the rotation (`tenant-sweep.ts:86,88`);
  - the `CreateBatchResponse` type rejects every malformed shape;
  - the sections and tests agree;
  - the timing bound holds.

  6 LOW, fixed in v3.1:
  - casts for deliberately malformed mocks;
  - wait for the send call before advancing fake time;
  - the §10.1 test lists;
  - the next-day claim and invariant 6 qualified (a pre-existing resume point is kept on an email stop);
  - `vi.mock` instead of `vi.spyOn` in the integration harness;
  - the `cursor ?? '(start)'` fallback in the alert text.
