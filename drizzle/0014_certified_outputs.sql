CREATE TABLE "admin_change_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"entity" varchar(40) NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" varchar(40) NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(10) NOT NULL,
	"source_system" varchar(100) NOT NULL,
	"imported_by" uuid NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"file_name" varchar(255),
	"row_count" integer NOT NULL,
	"imported_count" integer NOT NULL,
	"skipped_count" integer NOT NULL,
	CONSTRAINT "import_batches_kind_check" CHECK ("import_batches"."kind" IN ('entries', 'periods'))
);
--> statement-breakpoint
ALTER TABLE "indirect_charge_codes" ADD COLUMN "leave_pay_type" varchar(10);--> statement-breakpoint
ALTER TABLE "period_events" ADD COLUMN "source" varchar(20) DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "period_events" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "period_events" ADD COLUMN "original_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "period_events" ADD COLUMN "approval_context" jsonb;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "source" varchar(20) DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "original_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "timesheet_periods" ADD COLUMN "submission_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "approver_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "history_import_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "workweek_start_day" smallint;--> statement-breakpoint
ALTER TABLE "admin_change_log" ADD CONSTRAINT "admin_change_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_admin_change_log_entity" ON "admin_change_log" USING btree ("entity","entity_id","created_at");--> statement-breakpoint
ALTER TABLE "period_events" ADD CONSTRAINT "period_events_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_lcat_user_effective" ON "user_labor_categories" USING btree ("user_id","effective_date");--> statement-breakpoint
ALTER TABLE "indirect_charge_codes" ADD CONSTRAINT "indirect_charge_codes_leave_pay_type_check" CHECK ("indirect_charge_codes"."leave_pay_type" IS NULL OR "indirect_charge_codes"."leave_pay_type" IN ('pto', 'sick', 'holiday', 'unpaid'));--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workweek_start_day_check" CHECK ("workspace_settings"."workweek_start_day" IS NULL OR "workspace_settings"."workweek_start_day" BETWEEN 0 AND 6);--> statement-breakpoint
-- feature-plan-certified-outputs.md C1: import_batches and admin_change_log are append-only, like timesheet_entries
-- and period_events (0012/0013): UPDATE/DELETE (row level) and TRUNCATE (statement level) raise, using the same
-- function so clearTenantData's documented bypass (SET LOCAL cadenzpoint.allow_entry_delete = 'on') covers them.
CREATE TRIGGER import_batches_append_only
  BEFORE UPDATE OR DELETE ON "import_batches"
  FOR EACH ROW EXECUTE FUNCTION cadenzpoint_block_entry_mutation();--> statement-breakpoint
CREATE TRIGGER import_batches_no_truncate
  BEFORE TRUNCATE ON "import_batches"
  FOR EACH STATEMENT EXECUTE FUNCTION cadenzpoint_block_entry_mutation();--> statement-breakpoint
CREATE TRIGGER admin_change_log_append_only
  BEFORE UPDATE OR DELETE ON "admin_change_log"
  FOR EACH ROW EXECUTE FUNCTION cadenzpoint_block_entry_mutation();--> statement-breakpoint
CREATE TRIGGER admin_change_log_no_truncate
  BEFORE TRUNCATE ON "admin_change_log"
  FOR EACH STATEMENT EXECUTE FUNCTION cadenzpoint_block_entry_mutation();--> statement-breakpoint
-- C7 / CO-D16: the built-in leave codes ship with their pay type. Other (custom) leave codes stay null until an
-- admin sets one (the payroll export lists them and refuses meanwhile).
UPDATE "indirect_charge_codes" SET "leave_pay_type" = CASE "code"
    WHEN 'LV-AL' THEN 'pto' WHEN 'LV-SL' THEN 'sick' WHEN 'LV-HOL' THEN 'holiday' WHEN 'LV-LWOP' THEN 'unpaid' END
  WHERE "category" = 'leave' AND "code" IN ('LV-AL', 'LV-SL', 'LV-HOL', 'LV-LWOP') AND "leave_pay_type" IS NULL;--> statement-breakpoint
-- C1: the workspace_settings row always exists (a missing row is treated as a CLOSED import window).
INSERT INTO "workspace_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- C1 (conservative backfill): an existing workspace that has ever had a timesheet leave draft, or any submission
-- event, is past onboarding — its history-import window is closed.
UPDATE "workspace_settings" SET "history_import_closed_at" = now()
  WHERE "id" = 1 AND "history_import_closed_at" IS NULL
    AND (EXISTS (SELECT 1 FROM "timesheet_periods" WHERE "status" <> 'draft')
      OR EXISTS (SELECT 1 FROM "period_events" WHERE "event" = 'submitted'));
