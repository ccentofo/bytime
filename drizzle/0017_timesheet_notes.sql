CREATE TABLE "timesheet_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"charge_code_id" uuid,
	"indirect_code_id" uuid,
	"clin_id" uuid,
	"body" text NOT NULL,
	"revision_number" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timesheet_notes_one_code_check" CHECK (num_nonnulls("timesheet_notes"."charge_code_id", "timesheet_notes"."indirect_code_id", "timesheet_notes"."clin_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "timesheet_notes" ADD CONSTRAINT "timesheet_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_notes" ADD CONSTRAINT "timesheet_notes_charge_code_id_charge_codes_id_fk" FOREIGN KEY ("charge_code_id") REFERENCES "public"."charge_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_notes" ADD CONSTRAINT "timesheet_notes_indirect_code_id_indirect_charge_codes_id_fk" FOREIGN KEY ("indirect_code_id") REFERENCES "public"."indirect_charge_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_notes" ADD CONSTRAINT "timesheet_notes_clin_id_clins_id_fk" FOREIGN KEY ("clin_id") REFERENCES "public"."clins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_notes" ADD CONSTRAINT "timesheet_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timesheet_notes_cell_rev_unique_idx" ON "timesheet_notes" USING btree ("user_id",coalesce("charge_code_id", "indirect_code_id", "clin_id"),"entry_date","revision_number");--> statement-breakpoint
CREATE INDEX "idx_timesheet_notes_user_date" ON "timesheet_notes" USING btree ("user_id","entry_date");--> statement-breakpoint
-- feature-plan-ux-timesheet.md A4.1 (UX3-D1): timesheet_notes is append-only, like timesheet_entries (0012/0013) and
-- import_batches / admin_change_log (0014): UPDATE/DELETE (row level) and TRUNCATE (statement level) raise, using the
-- same function, so clearTenantData's documented bypass (SET LOCAL cadenzpoint.allow_entry_delete = 'on') covers it.
CREATE TRIGGER timesheet_notes_append_only
  BEFORE UPDATE OR DELETE ON "timesheet_notes"
  FOR EACH ROW EXECUTE FUNCTION cadenzpoint_block_entry_mutation();--> statement-breakpoint
CREATE TRIGGER timesheet_notes_no_truncate
  BEFORE TRUNCATE ON "timesheet_notes"
  FOR EACH STATEMENT EXECUTE FUNCTION cadenzpoint_block_entry_mutation();
