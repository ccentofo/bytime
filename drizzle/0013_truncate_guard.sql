-- feature-plan-terms-compliance-fixes.md §5.5: the append-only triggers from 0012 fire on UPDATE/DELETE
-- (row level) but a row-level trigger never fires on TRUNCATE. Add statement-level TRUNCATE guards using the
-- same function, so the DB-level guarantee covers every way of removing time records. The documented bypass
-- (`SET LOCAL cadenzpoint.allow_entry_delete = 'on'`, used only by clearTenantData) still applies.
CREATE TRIGGER timesheet_entries_no_truncate
  BEFORE TRUNCATE ON "timesheet_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION cadenzpoint_block_entry_mutation();--> statement-breakpoint
CREATE TRIGGER period_events_no_truncate
  BEFORE TRUNCATE ON "period_events"
  FOR EACH STATEMENT EXECUTE FUNCTION cadenzpoint_block_entry_mutation();
