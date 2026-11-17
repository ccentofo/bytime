CREATE TABLE "backup_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar(80) NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"oldest_object_at" timestamp with time zone,
	"oldest_key" text,
	"objects_over_29_days" integer,
	"total_objects" integer,
	"total_bytes" bigint,
	"versioning_status" varchar(20),
	"stale_uploads" integer,
	"kms_key_state" varchar(40),
	"alert_email_confirmed" boolean,
	"protection_drift" text,
	"leftover_test_dbs" integer,
	"stuck_test_dbs" integer,
	"errors" text
);
--> statement-breakpoint
CREATE TABLE "backup_permission_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar(80) NOT NULL,
	"role" varchar(20) NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"detail" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "database_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"target" varchar(20) NOT NULL,
	"run_id" varchar(80) NOT NULL,
	"status" varchar(10) NOT NULL,
	"s3_key" text,
	"bytes" bigint,
	"sha256" char(64),
	"row_counts" jsonb,
	"server_version" varchar(40),
	"pg_dump_version" varchar(80),
	"region" varchar(40),
	"target_deadline_ms" integer NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restore_test_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"test_run_id" uuid NOT NULL,
	"run_id" varchar(80) NOT NULL,
	"target" varchar(20) NOT NULL,
	"tenant_id" uuid,
	"backup_id" uuid,
	"s3_key" text,
	"backup_started_at" timestamp with time zone,
	"result" varchar(40) NOT NULL,
	"detail" text,
	"duration_ms" integer NOT NULL,
	"tested_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restore_test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar(80) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" varchar(10) NOT NULL,
	"planned" integer,
	"swept_test_dbs" integer DEFAULT 0 NOT NULL,
	"deadline_ms" integer NOT NULL,
	"target_deadline_ms" integer NOT NULL,
	"detail" text
);
--> statement-breakpoint
ALTER TABLE "database_backups" ADD CONSTRAINT "database_backups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_test_results" ADD CONSTRAINT "restore_test_results_test_run_id_restore_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."restore_test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_test_results" ADD CONSTRAINT "restore_test_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_test_results" ADD CONSTRAINT "restore_test_results_backup_id_database_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."database_backups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_audits_run_at_idx" ON "backup_audits" USING btree ("run_at");--> statement-breakpoint
CREATE INDEX "backup_permission_checks_role_idx" ON "backup_permission_checks" USING btree ("role","checked_at");--> statement-breakpoint
CREATE INDEX "database_backups_tenant_status_idx" ON "database_backups" USING btree ("tenant_id","status","finished_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "database_backups_run_idx" ON "database_backups" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "database_backups_s3_key_unique" ON "database_backups" USING btree ("s3_key") WHERE "database_backups"."s3_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "restore_test_results_tenant_idx" ON "restore_test_results" USING btree ("tenant_id","result","tested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "restore_test_results_run_idx" ON "restore_test_results" USING btree ("test_run_id");--> statement-breakpoint
CREATE INDEX "restore_test_runs_started_idx" ON "restore_test_runs" USING btree ("started_at");