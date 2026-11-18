CREATE TABLE "disaster_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar(80) NOT NULL,
	"tenant_id" uuid,
	"kind" varchar(20) NOT NULL,
	"status" varchar(60) NOT NULL,
	"project_name" varchar(100),
	"new_project_id" varchar(100),
	"old_project_id" varchar(100),
	"backup_key" text,
	"backup_started_at" timestamp with time zone,
	"detail" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disaster_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar(80) NOT NULL,
	"mode" varchar(20) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" varchar(10) NOT NULL,
	"summary" jsonb
);
--> statement-breakpoint
ALTER TABLE "disaster_actions" ADD CONSTRAINT "disaster_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disaster_actions_tenant_idx" ON "disaster_actions" USING btree ("tenant_id","kind","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "disaster_actions_project_idx" ON "disaster_actions" USING btree ("new_project_id");--> statement-breakpoint
CREATE INDEX "disaster_runs_started_idx" ON "disaster_runs" USING btree ("started_at");