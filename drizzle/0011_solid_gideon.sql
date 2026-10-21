CREATE TABLE "workspace_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_settings_single_row_check" CHECK ("workspace_settings"."id" = 1)
);
--> statement-breakpoint
-- Seed the single row immediately — every existing tenant needs a workspace_settings row for
-- getWorkspaceTimezone()/getWorkspaceToday() to have anything to read. Defaults to the column's
-- own default (America/New_York); an admin can change it afterward via Settings (D8).
INSERT INTO "workspace_settings" ("id", "timezone") VALUES (1, 'America/New_York')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- feature-plan-calendar-dates.md D2, step 1: duplicate-period guard. Two timesheet_periods rows
-- for the same user that map to the same calendar day under the +12h UTC rounding below would
-- make the new (user_id, period_start) semantics (one row per user per CALENDAR DAY, not per
-- instant) ambiguous. Fail closed — raise with exactly which user(s)/day(s) collide rather than
-- silently merging or picking one. Local demo/dev databases can be re-seeded if this fires; a
-- real tenant (none exist per §2) would need manual review instead.
DO $$
DECLARE
  conflict_summary text;
BEGIN
  SELECT string_agg(
    format('user_id=%s day=%s (%s colliding periods)', user_id, day, cnt),
    '; '
  )
  INTO conflict_summary
  FROM (
    SELECT
      user_id,
      ((period_start AT TIME ZONE 'UTC') + interval '12 hours')::date AS day,
      COUNT(*) AS cnt
    FROM timesheet_periods
    GROUP BY user_id, ((period_start AT TIME ZONE 'UTC') + interval '12 hours')::date
    HAVING COUNT(*) > 1
  ) AS dupes;

  IF conflict_summary IS NOT NULL THEN
    RAISE EXCEPTION 'feature-plan-calendar-dates.md D2: duplicate timesheet_periods rows collide on the same calendar day after UTC+12h conversion — %. Re-seed local demo/dev data, or resolve manually before re-running this migration.', conflict_summary;
  END IF;
END $$;
--> statement-breakpoint
-- feature-plan-calendar-dates.md D2, step 2: revision renumbering. Two entries for the same
-- cell (user + charge/indirect/CLIN code) that were saved under different raw timestamps but
-- represent the SAME calendar day (because the server and browser computed "midnight"
-- differently) currently both hold "revision_number = 1" — a broken append-only chain. This
-- renumbers every cell's revisions sequentially by (created_at, revision_number, id); for a
-- cell whose revisions were already contiguous and correctly ordered, the new numbers are
-- identical to the old ones (a no-op). No row is deleted or merged — only the numbering is
-- repaired, which is what makes "two colliding revision-1 rows" become "revision 1, revision 2"
-- in creation order, exactly as if they had been saved under one consistent day all along.
DO $$
DECLARE
  conflict_summary text;
BEGIN
  SELECT string_agg(format('user_id=%s labor_category_id=%s day=%s', user_id, labor_category_id, day), '; ')
  INTO conflict_summary
  FROM (
    SELECT user_id, labor_category_id, ((effective_date AT TIME ZONE 'UTC') + interval '12 hours')::date AS day
    FROM user_labor_categories
    GROUP BY user_id, labor_category_id, ((effective_date AT TIME ZONE 'UTC') + interval '12 hours')::date
    HAVING COUNT(*) > 1
  ) AS dupes;
  IF conflict_summary IS NOT NULL THEN
    RAISE EXCEPTION 'feature-plan-calendar-dates.md D2: user_labor_categories rows collide on the same effective day after conversion (user_lcat_effective_unique_idx would fail) — %. Re-seed local demo/dev data, or resolve manually.', conflict_summary;
  END IF;
END $$;
--> statement-breakpoint
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY
        user_id,
        COALESCE(charge_code_id, indirect_code_id, clin_id),
        ((entry_date AT TIME ZONE 'UTC') + interval '12 hours')::date
      ORDER BY created_at, revision_number, id
    ) AS new_revision_number
  FROM timesheet_entries
)
UPDATE timesheet_entries
SET revision_number = ranked.new_revision_number
FROM ranked
WHERE timesheet_entries.id = ranked.id
  AND timesheet_entries.revision_number IS DISTINCT FROM ranked.new_revision_number;
--> statement-breakpoint
-- feature-plan-calendar-dates.md D2, step 3: type changes. USING ((col AT TIME ZONE 'UTC') +
-- interval '12 hours')::date recovers the calendar day a stored "midnight" instant represents
-- regardless of which timezone computed it (correct for UTC-midnight, US-local-midnight, and
-- post-DST-change US-local-midnight storage — the three conventions this bug produced). The
-- 1900-01-01 00:00:00 UTC effective_from sentinel converts to 1900-01-01, unchanged.
-- migration-safety: allow pre-launch type change to calendar date; no production tenants (feature-plan-calendar-dates.md §2)
ALTER TABLE "timesheet_periods" ALTER COLUMN "period_start" SET DATA TYPE date USING (("period_start" AT TIME ZONE 'UTC') + interval '12 hours')::date;
--> statement-breakpoint
-- migration-safety: allow pre-launch type change to calendar date; no production tenants (feature-plan-calendar-dates.md §2)
ALTER TABLE "timesheet_entries" ALTER COLUMN "entry_date" SET DATA TYPE date USING (("entry_date" AT TIME ZONE 'UTC') + interval '12 hours')::date;
--> statement-breakpoint
-- migration-safety: allow pre-launch type change to calendar date; no production tenants (feature-plan-calendar-dates.md §2)
ALTER TABLE "pay_period_config" ALTER COLUMN "anchor_date" SET DATA TYPE date USING (("anchor_date" AT TIME ZONE 'UTC') + interval '12 hours')::date;
--> statement-breakpoint
-- migration-safety: allow pre-launch type change to calendar date; no production tenants (feature-plan-calendar-dates.md §2)
ALTER TABLE "pay_period_config" ALTER COLUMN "effective_from" SET DATA TYPE date USING (("effective_from" AT TIME ZONE 'UTC') + interval '12 hours')::date;
--> statement-breakpoint
-- migration-safety: allow pre-launch type change to calendar date; no production tenants (feature-plan-calendar-dates.md §2)
ALTER TABLE "contracts" ALTER COLUMN "start_date" SET DATA TYPE date USING (("start_date" AT TIME ZONE 'UTC') + interval '12 hours')::date;
--> statement-breakpoint
-- migration-safety: allow pre-launch type change to calendar date; no production tenants (feature-plan-calendar-dates.md §2)
ALTER TABLE "contracts" ALTER COLUMN "end_date" SET DATA TYPE date USING (("end_date" AT TIME ZONE 'UTC') + interval '12 hours')::date;
--> statement-breakpoint
-- migration-safety: allow pre-launch type change to calendar date; no production tenants (feature-plan-calendar-dates.md §2)
ALTER TABLE "user_labor_categories" ALTER COLUMN "effective_date" SET DATA TYPE date USING (("effective_date" AT TIME ZONE 'UTC') + interval '12 hours')::date;
--> statement-breakpoint
-- migration-safety: allow pre-launch type change to calendar date; no production tenants (feature-plan-calendar-dates.md §2)
-- end_date becomes the INCLUSIVE last day of the assignment (readers now use end_date >= entry_date).
-- Old values were real instants ("End assignment" stored now()), compared as end > entry midnight:
-- a non-midnight instant counted its own day, so its UTC date is the last day; an exact UTC
-- midnight (date-picker value) excluded that day, so the last day is the day before.
ALTER TABLE "user_labor_categories" ALTER COLUMN "end_date" SET DATA TYPE date USING (CASE WHEN ("end_date" AT TIME ZONE 'UTC')::time = time '00:00' THEN ("end_date" AT TIME ZONE 'UTC')::date - 1 ELSE ("end_date" AT TIME ZONE 'UTC')::date END);
--> statement-breakpoint
-- migration-safety: allow pre-launch type change to calendar date; no production tenants (feature-plan-calendar-dates.md §2)
ALTER TABLE "integration_sync_logs" ALTER COLUMN "period_start" SET DATA TYPE date USING (("period_start" AT TIME ZONE 'UTC') + interval '12 hours')::date;
--> statement-breakpoint
-- migration-safety: allow pre-launch type change to calendar date; no production tenants (feature-plan-calendar-dates.md §2)
-- period_end was always an end-of-month instant (23:59:59.999 in the admin's browser), which can
-- fall early the NEXT day in UTC; subtracting 12 hours recovers the intended last day.
ALTER TABLE "integration_sync_logs" ALTER COLUMN "period_end" SET DATA TYPE date USING (("period_end" AT TIME ZONE 'UTC') - interval '12 hours')::date;
--> statement-breakpoint
-- feature-plan-calendar-dates.md D2, step 4: uniqueness the CalendarDate model now makes
-- possible. timesheet_periods' existing (user_id, period_start) unique index ("user_period_unique_idx")
-- now means one row per user per CALENDAR DAY (period_start is a `date`, not an instant) —
-- Postgres rebuilds it automatically as part of the ALTER COLUMN TYPE above; the duplicate-period
-- guard at the top of this migration already proved it would succeed. timesheet_entries gets a
-- new unique index closing the race where two concurrent saves both compute the same next
-- revision_number for one cell — the revision renumbering above already guarantees no existing
-- row violates it.
CREATE UNIQUE INDEX "entries_user_code_date_rev_unique_idx" ON "timesheet_entries" USING btree ("user_id",coalesce("charge_code_id", "indirect_code_id", "clin_id"),"entry_date","revision_number");
