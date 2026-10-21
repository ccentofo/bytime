ALTER TYPE "public"."tenant_status" ADD VALUE 'deleted';--> statement-breakpoint
CREATE TABLE "tenant_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(60) NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"recipients" text[] NOT NULL,
	"provider_message_id" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_notices_tenant_kind_scheduled_unique" UNIQUE("tenant_id","kind","scheduled_for")
);
--> statement-breakpoint
ALTER TABLE "signups" ADD COLUMN "terms_version" varchar(40);--> statement-breakpoint
ALTER TABLE "signups" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "past_due_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "subscription_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "deletion_scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "neon_project_id" varchar(100);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "terms_version" varchar(40);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "last_stripe_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "signup_email" varchar(255);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "billing_email" varchar(255);--> statement-breakpoint
ALTER TABLE "tenant_notices" ADD CONSTRAINT "tenant_notices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;