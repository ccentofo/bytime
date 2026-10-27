CREATE TABLE "charge_code_labor_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"charge_code_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"labor_category_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "charge_code_labor_categories" ADD CONSTRAINT "charge_code_labor_categories_charge_code_id_charge_codes_id_fk" FOREIGN KEY ("charge_code_id") REFERENCES "public"."charge_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_code_labor_categories" ADD CONSTRAINT "charge_code_labor_categories_labor_category_id_labor_categories_id_fk" FOREIGN KEY ("labor_category_id") REFERENCES "public"."labor_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_code_labor_categories" ADD CONSTRAINT "charge_code_labor_categories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cc_lcat_effective_unique_idx" ON "charge_code_labor_categories" USING btree ("charge_code_id","effective_date");