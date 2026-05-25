CREATE TYPE "public"."period_status" AS ENUM('draft', 'submitted', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."record_status" AS ENUM('active', 'inactive', 'closed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'supervisor', 'employee');--> statement-breakpoint
CREATE TABLE "clins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"clin_number" varchar(50) NOT NULL,
	"description" text,
	"funded_amount" varchar(20),
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_number" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"contract_type" varchar(20) DEFAULT 'prime' NOT NULL,
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"funded_value" varchar(20),
	"ceiling_value" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contracts_contract_number_unique" UNIQUE("contract_number")
);
--> statement-breakpoint
CREATE TABLE "labor_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clin_id" uuid NOT NULL,
	"slin_id" uuid,
	"lcat_code" varchar(50) NOT NULL,
	"title" varchar(255) NOT NULL,
	"hourly_rate" varchar(20) DEFAULT '0.00' NOT NULL,
	"ceiling_rate" varchar(20),
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"ip_address" varchar(45),
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"successful" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email_on_submit" boolean DEFAULT true NOT NULL,
	"email_on_approve" boolean DEFAULT true NOT NULL,
	"email_on_reject" boolean DEFAULT true NOT NULL,
	"email_daily_reminder" boolean DEFAULT true NOT NULL,
	"email_deadline_reminder" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "slins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clin_id" uuid NOT NULL,
	"slin_number" varchar(50) NOT NULL,
	"description" text,
	"funded_amount" varchar(20),
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheet_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"clin_id" uuid NOT NULL,
	"slin_id" uuid,
	"entry_date" timestamp with time zone NOT NULL,
	"hours" varchar(10) DEFAULT '0' NOT NULL,
	"revision_number" integer DEFAULT 1 NOT NULL,
	"change_reason_code" varchar(50),
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "timesheet_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"status" "period_status" DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_comment" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"review_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"clin_id" uuid NOT NULL,
	"slin_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by" uuid
);
--> statement-breakpoint
CREATE TABLE "user_labor_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"labor_category_id" uuid NOT NULL,
	"effective_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone,
	"assigned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"full_name" varchar(255) NOT NULL,
	"role" "user_role" DEFAULT 'employee' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"password_hash" varchar(255),
	"password_changed_at" timestamp with time zone,
	"flsa_exempt" boolean DEFAULT false NOT NULL,
	"session_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "clins" ADD CONSTRAINT "clins_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_categories" ADD CONSTRAINT "labor_categories_clin_id_clins_id_fk" FOREIGN KEY ("clin_id") REFERENCES "public"."clins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_categories" ADD CONSTRAINT "labor_categories_slin_id_slins_id_fk" FOREIGN KEY ("slin_id") REFERENCES "public"."slins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slins" ADD CONSTRAINT "slins_clin_id_clins_id_fk" FOREIGN KEY ("clin_id") REFERENCES "public"."clins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_clin_id_clins_id_fk" FOREIGN KEY ("clin_id") REFERENCES "public"."clins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_slin_id_slins_id_fk" FOREIGN KEY ("slin_id") REFERENCES "public"."slins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_assignments" ADD CONSTRAINT "user_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_assignments" ADD CONSTRAINT "user_assignments_clin_id_clins_id_fk" FOREIGN KEY ("clin_id") REFERENCES "public"."clins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_assignments" ADD CONSTRAINT "user_assignments_slin_id_slins_id_fk" FOREIGN KEY ("slin_id") REFERENCES "public"."slins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_assignments" ADD CONSTRAINT "user_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_labor_categories" ADD CONSTRAINT "user_labor_categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_labor_categories" ADD CONSTRAINT "user_labor_categories_labor_category_id_labor_categories_id_fk" FOREIGN KEY ("labor_category_id") REFERENCES "public"."labor_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_labor_categories" ADD CONSTRAINT "user_labor_categories_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clin_lcat_unique_idx" ON "labor_categories" USING btree ("clin_id","lcat_code");--> statement-breakpoint
CREATE UNIQUE INDEX "clin_slin_unique_idx" ON "slins" USING btree ("clin_id","slin_number");--> statement-breakpoint
CREATE UNIQUE INDEX "user_period_unique_idx" ON "timesheet_periods" USING btree ("user_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "user_clin_unique_idx" ON "user_assignments" USING btree ("user_id","clin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_lcat_effective_unique_idx" ON "user_labor_categories" USING btree ("user_id","labor_category_id","effective_date");