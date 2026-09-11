CREATE TYPE "public"."work_location" AS ENUM('onsite', 'telework', 'other');--> statement-breakpoint
CREATE TABLE "charge_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"clin_id" uuid NOT NULL,
	"slin_id" uuid,
	"labor_category_id" uuid,
	"class_id" uuid,
	"work_location" "work_location",
	"billable" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charge_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "cost_classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_classes_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "user_charge_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"charge_code_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by" uuid
);
--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD COLUMN "charge_code_id" uuid;--> statement-breakpoint
ALTER TABLE "charge_codes" ADD CONSTRAINT "charge_codes_clin_id_clins_id_fk" FOREIGN KEY ("clin_id") REFERENCES "public"."clins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_codes" ADD CONSTRAINT "charge_codes_slin_id_slins_id_fk" FOREIGN KEY ("slin_id") REFERENCES "public"."slins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_codes" ADD CONSTRAINT "charge_codes_labor_category_id_labor_categories_id_fk" FOREIGN KEY ("labor_category_id") REFERENCES "public"."labor_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_codes" ADD CONSTRAINT "charge_codes_class_id_cost_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."cost_classes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_charge_codes" ADD CONSTRAINT "user_charge_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_charge_codes" ADD CONSTRAINT "user_charge_codes_charge_code_id_charge_codes_id_fk" FOREIGN KEY ("charge_code_id") REFERENCES "public"."charge_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_charge_codes" ADD CONSTRAINT "user_charge_codes_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_charge_codes_clin" ON "charge_codes" USING btree ("clin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_charge_code_unique_idx" ON "user_charge_codes" USING btree ("user_id","charge_code_id");--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_charge_code_id_charge_codes_id_fk" FOREIGN KEY ("charge_code_id") REFERENCES "public"."charge_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_entries_user_chargecode_date_rev" ON "timesheet_entries" USING btree ("user_id","charge_code_id","entry_date","revision_number");