CREATE TABLE "signal_counters" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signups" ADD COLUMN "ip_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "signups" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signups" ADD COLUMN "waitlisted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signups" ADD COLUMN "provisioned_at" timestamp with time zone;