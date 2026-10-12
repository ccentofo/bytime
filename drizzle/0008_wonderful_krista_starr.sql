-- Add effective_from as nullable first so existing rows don't violate NOT NULL.
-- IF NOT EXISTS keeps this safe on DBs where the column was already created via drizzle-kit push.
ALTER TABLE "pay_period_config" ADD COLUMN IF NOT EXISTS "effective_from" timestamp with time zone;
--> statement-breakpoint
-- Backfill existing rows to a far-past date so all historical periods keep their current schedule.
UPDATE "pay_period_config" SET "effective_from" = '1900-01-01 00:00:00+00' WHERE "effective_from" IS NULL;
--> statement-breakpoint
-- Now enforce NOT NULL.
ALTER TABLE "pay_period_config" ALTER COLUMN "effective_from" SET NOT NULL;
