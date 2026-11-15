CREATE TABLE "tenant_seat_billing" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"sync_due_at" timestamp with time zone,
	"mark_seq" bigint DEFAULT 0 NOT NULL,
	"stripe_subscription_id" varchar(100),
	"stripe_quantity" integer,
	"billable_count" integer,
	"checked_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "plan_interval" varchar(10);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "subscription_cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "collection_method" varchar(30);--> statement-breakpoint
ALTER TABLE "tenant_seat_billing" ADD CONSTRAINT "tenant_seat_billing_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- feature-plan-per-user-billing.md §6.2: the flat Starter/Pro tiers become per-user Standard (dev and staging rows only;
-- production isn't live). New code also maps any leftover legacy value to the Standard limit. 'enterprise' rows stay.
UPDATE "tenants" SET "plan" = 'standard' WHERE "plan" IN ('starter', 'pro');
