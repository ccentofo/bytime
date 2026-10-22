CREATE TABLE "ops_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(64) NOT NULL,
	"tenant_id" uuid,
	"kind" varchar(60) NOT NULL,
	"dedup_key" varchar(200) DEFAULT '' NOT NULL,
	"detail" jsonb,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_note" text
);
--> statement-breakpoint
CREATE TABLE "payment_pending_observations" (
	"tenant_id" uuid NOT NULL,
	"invoice_id" varchar(100) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_pending_observations_tenant_id_invoice_id_kind_pk" PRIMARY KEY("tenant_id","invoice_id","kind")
);
--> statement-breakpoint
CREATE TABLE "tenant_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(60) NOT NULL,
	"detail" text,
	"actor" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_notices" ALTER COLUMN "recipients" SET DEFAULT '{}'::text[];--> statement-breakpoint
ALTER TABLE "tenant_notices" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_notices" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_notices" ADD COLUMN "first_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_notices" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "tenant_notices" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_notices" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "tenant_notices" ADD COLUMN "payload_frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_notices" ADD COLUMN "idempotency_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_notices" ADD COLUMN "forced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_notices" ADD COLUMN "forced_reason" text;--> statement-breakpoint
ALTER TABLE "tenant_notices" ADD COLUMN "forced_audit_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "first_good_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "suspension_reason" varchar(20);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "lifecycle_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "stripe_customer_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "lifecycle_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "lifecycle_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "lifecycle_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ops_alerts" ADD CONSTRAINT "ops_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_pending_observations" ADD CONSTRAINT "payment_pending_observations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_audit_events" ADD CONSTRAINT "tenant_audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ops_alerts_open_unique" ON "ops_alerts" USING btree ("scope","kind","dedup_key") WHERE "ops_alerts"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tenant_audit_events_tenant_idx" ON "tenant_audit_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_stripe_customer_unique" ON "tenants" USING btree ("stripe_customer_id") WHERE "tenants"."stripe_customer_id" IS NOT NULL;--> statement-breakpoint
-- feature-plan-terms-compliance-fixes.md §4.1 backfill (idempotent). A tenant whose mirrored Stripe status is
-- active/trialing (GOOD) or past_due/unpaid (DUNNING, which implies it was active) has subscribed before.
UPDATE "tenants" SET "first_good_at" = "updated_at"
WHERE "first_good_at" IS NULL AND "subscription_status" IN ('active', 'trialing', 'past_due', 'unpaid');--> statement-breakpoint
-- Existing suspensions: past-due ones are non-payment; anything else was an admin (policy) action.
UPDATE "tenants" SET "suspension_reason" = CASE WHEN "past_due_since" IS NOT NULL THEN 'nonpayment' ELSE 'policy' END
WHERE "status" = 'suspended' AND "suspension_reason" IS NULL;
