CREATE TABLE "export_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"s3_key" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" char(64) NOT NULL,
	"token_hash" char(64) NOT NULL,
	"token_encrypted" text,
	"recipients_encrypted" text NOT NULL,
	"time_zone" varchar(100) NOT NULL,
	"extra_recipient" boolean NOT NULL,
	"extra_only" boolean NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"erased_at" timestamp with time zone,
	"download_count" integer DEFAULT 0 NOT NULL,
	"last_download_at" timestamp with time zone,
	"run_id" varchar(80) NOT NULL,
	CONSTRAINT "export_deliveries_notice_id_unique" UNIQUE("notice_id"),
	CONSTRAINT "export_deliveries_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "export_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"s3_key" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" char(64) NOT NULL,
	"reason" text NOT NULL,
	"run_id" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text
);
--> statement-breakpoint
ALTER TABLE "export_deliveries" ADD CONSTRAINT "export_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_deliveries" ADD CONSTRAINT "export_deliveries_notice_id_tenant_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."tenant_notices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_holds" ADD CONSTRAINT "export_holds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_deliveries_tenant_created_idx" ON "export_deliveries" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "export_holds_tenant_idx" ON "export_holds" USING btree ("tenant_id","created_at");