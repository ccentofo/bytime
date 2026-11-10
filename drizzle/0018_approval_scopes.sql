CREATE TABLE "approval_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supervisor_id" uuid NOT NULL,
	"clin_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"source" varchar(20) DEFAULT 'app' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" uuid,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "approval_scopes" ADD CONSTRAINT "approval_scopes_supervisor_id_users_id_fk" FOREIGN KEY ("supervisor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_scopes" ADD CONSTRAINT "approval_scopes_clin_id_clins_id_fk" FOREIGN KEY ("clin_id") REFERENCES "public"."clins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_scopes" ADD CONSTRAINT "approval_scopes_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_scopes_supervisor_clin_unique_idx" ON "approval_scopes" USING btree ("supervisor_id","clin_id");--> statement-breakpoint
CREATE INDEX "idx_approval_scopes_active_clin" ON "approval_scopes" USING btree ("clin_id") WHERE "approval_scopes"."is_active";--> statement-breakpoint
-- feature-plan-approval-scope.md §3 (S1, S6): convert today's implied approval scopes into explicit rows, ONCE.
-- Before this release a supervisor approved employees on every CLIN they had an active user_assignments row on; each
-- such pair becomes an active, UNREVIEWED scope (source 'migration', reviewed_at null) that keeps granting until an
-- admin keeps or removes it on Assignments → Approval scope. Employees' rows are not converted. Idempotent: the unique
-- index makes a re-run insert nothing. New tenants run it on an empty database (nothing inserted).
INSERT INTO approval_scopes (supervisor_id, clin_id, is_active, source, granted_at, granted_by)
SELECT ua.user_id, ua.clin_id, true, 'migration', ua.assigned_at, ua.assigned_by
FROM user_assignments ua JOIN users u ON u.id = ua.user_id
WHERE u.role = 'supervisor' AND ua.is_active
ON CONFLICT (supervisor_id, clin_id) DO NOTHING;
