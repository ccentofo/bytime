CREATE TABLE "labor_category_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"labor_category_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"hourly_rate" varchar(20) NOT NULL,
	"ceiling_rate" varchar(20),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "labor_category_rates" ADD CONSTRAINT "labor_category_rates_labor_category_id_labor_categories_id_fk" FOREIGN KEY ("labor_category_id") REFERENCES "public"."labor_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_category_rates" ADD CONSTRAINT "labor_category_rates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lcat_rate_effective_unique_idx" ON "labor_category_rates" USING btree ("labor_category_id","effective_date");