CREATE TYPE "public"."period_event" AS ENUM('submitted', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "period_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event" "period_event" NOT NULL,
	"actor_id" uuid,
	"comment" text,
	"completeness_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "period_events" ADD CONSTRAINT "period_events_period_id_timesheet_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."timesheet_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_events" ADD CONSTRAINT "period_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_events" ADD CONSTRAINT "period_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_period_events_period" ON "period_events" USING btree ("period_id");--> statement-breakpoint
-- feature-plan-terms-compliance.md T8 (R11): timesheet_entries and period_events are append-only.
-- UPDATE/DELETE raise unless the session has explicitly opted in for this one statement via
-- `SET LOCAL cadenzpoint.allow_entry_delete = 'on'` (the integration test suite's cleanupTestData()
-- is the only intended caller, inside a transaction so SET LOCAL's scope matches the delete).
-- Workspace deletion (T7) drops the whole database, so it is unaffected by this trigger.
CREATE OR REPLACE FUNCTION cadenzpoint_block_entry_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('cadenzpoint.allow_entry_delete', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION '% on % is not permitted — this table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER timesheet_entries_append_only
  BEFORE UPDATE OR DELETE ON "timesheet_entries"
  FOR EACH ROW EXECUTE FUNCTION cadenzpoint_block_entry_mutation();--> statement-breakpoint
CREATE TRIGGER period_events_append_only
  BEFORE UPDATE OR DELETE ON "period_events"
  FOR EACH ROW EXECUTE FUNCTION cadenzpoint_block_entry_mutation();