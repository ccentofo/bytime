CREATE TABLE "cron_runs" (
	"name" varchar(60) PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_succeeded_at" timestamp with time zone,
	"last_summary" jsonb
);
