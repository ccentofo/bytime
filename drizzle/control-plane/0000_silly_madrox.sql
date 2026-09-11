CREATE TYPE "public"."tenant_status" AS ENUM('provisioning', 'active', 'suspended', 'deleting');--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(63) NOT NULL,
	"name" varchar(200) NOT NULL,
	"db_url_encrypted" text NOT NULL,
	"status" "tenant_status" DEFAULT 'provisioning' NOT NULL,
	"plan" varchar(40) DEFAULT 'trial' NOT NULL,
	"stripe_customer_id" varchar(100),
	"stripe_subscription_id" varchar(100),
	"subscription_status" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
