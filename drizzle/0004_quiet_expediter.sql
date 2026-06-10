CREATE TYPE "public"."pay_period_type" AS ENUM('weekly', 'biweekly', 'semimonthly', 'monthly');--> statement-breakpoint
CREATE TABLE "pay_period_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_type" "pay_period_type" DEFAULT 'semimonthly' NOT NULL,
	"anchor_date" timestamp with time zone NOT NULL,
	"week_start_day" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
