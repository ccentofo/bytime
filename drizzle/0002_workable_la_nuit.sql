CREATE TYPE "public"."integration_provider" AS ENUM('quickbooks_online', 'gusto', 'adp', 'paychex', 'sage_intacct', 'csv_export');--> statement-breakpoint
CREATE TYPE "public"."integration_sync_status" AS ENUM('pending', 'running', 'success', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"external_company_id" varchar(255),
	"external_company_name" varchar(255),
	"access_token_encrypted" text,
	"refresh_token_encrypted" text,
	"token_expires_at" timestamp with time zone,
	"scopes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"auto_sync_on_approval" boolean DEFAULT false NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_status" "integration_sync_status",
	"connected_by" uuid NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_entity_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"bytime_entity_id" uuid NOT NULL,
	"bytime_entity_name" varchar(255),
	"external_entity_id" varchar(255) NOT NULL,
	"external_entity_name" varchar(255),
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_sync_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"sync_type" varchar(50) NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"triggered_by" uuid,
	"trigger_type" varchar(20) DEFAULT 'manual' NOT NULL,
	"records_pushed" integer DEFAULT 0 NOT NULL,
	"records_failed" integer DEFAULT 0 NOT NULL,
	"records_skipped" integer DEFAULT 0 NOT NULL,
	"status" "integration_sync_status" DEFAULT 'pending' NOT NULL,
	"error_summary" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_sync_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_log_id" uuid NOT NULL,
	"bytime_entity_type" varchar(50) NOT NULL,
	"bytime_entity_id" uuid NOT NULL,
	"external_entity_id" varchar(255),
	"status" varchar(20) NOT NULL,
	"error_message" text,
	"request_payload" text,
	"response_payload" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_entity_mappings" ADD CONSTRAINT "integration_entity_mappings_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_logs" ADD CONSTRAINT "integration_sync_logs_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_logs" ADD CONSTRAINT "integration_sync_logs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_records" ADD CONSTRAINT "integration_sync_records_sync_log_id_integration_sync_logs_id_fk" FOREIGN KEY ("sync_log_id") REFERENCES "public"."integration_sync_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mapping_unique_idx" ON "integration_entity_mappings" USING btree ("connection_id","entity_type","bytime_entity_id");