/**
 * LB-D1 retention backfill core (feature-plan-launch-blockers.md P6 §1, §8): set `history_retention_seconds` on every
 * non-deleted tenant's Neon project. Pure — Neon calls are injected — so the rules are unit-testable.
 *
 *  - A tenant without `neon_project_id` can't be patched: listed as needing manual action.
 *  - `--check`: GET only (never PATCH); reports which projects differ from the target.
 *  - A 404 is a skip ONLY for a `deleting` tenant (its project is confirmed gone); for any other tenant it is a failure.
 *  - One project failing never stops the others; the caller exits non-zero when `failed` is non-empty.
 *  - Idempotent: PATCHing the value a project already has changes nothing.
 */

export interface RetentionTenant {
  slug: string;
  status: string;
  neonProjectId: string | null;
}

export interface RetentionDeps {
  get(projectId: string): Promise<number | 'not-found'>;
  set(projectId: string, seconds: number): Promise<'updated' | 'not-found'>;
  log(line: string): void;
}

export interface RetentionReport {
  updated: string[];
  alreadyOk: string[];
  wouldUpdate: string[];
  skippedDeleted: string[];
  manual: string[];
  failed: Array<{ slug: string; error: string }>;
}

export async function runRetentionBackfill(
  tenants: RetentionTenant[],
  targetSeconds: number,
  opts: { check: boolean },
  deps: RetentionDeps,
): Promise<RetentionReport> {
  const report: RetentionReport = { updated: [], alreadyOk: [], wouldUpdate: [], skippedDeleted: [], manual: [], failed: [] };

  for (const t of tenants) {
    if (t.status === 'deleted') continue;
    if (!t.neonProjectId) {
      report.manual.push(t.slug);
      deps.log(`  ${t.slug}: no neon_project_id — MANUAL ACTION (run backfill:neon-project-ids, or set retention in the Neon console)`);
      continue;
    }
    const notFound = () => {
      if (t.status === 'deleting') {
        report.skippedDeleted.push(t.slug);
        deps.log(`  ${t.slug}: project ${t.neonProjectId} not found (tenant is deleting) — skipped (database deleted)`);
      } else {
        report.failed.push({ slug: t.slug, error: `Neon project ${t.neonProjectId} not found` });
        deps.log(`  ${t.slug}: ✗ project ${t.neonProjectId} not found`);
      }
    };
    try {
      if (opts.check) {
        const current = await deps.get(t.neonProjectId);
        if (current === 'not-found') notFound();
        else if (current === targetSeconds) {
          report.alreadyOk.push(t.slug);
          deps.log(`  ${t.slug}: ✓ ${current} s`);
        } else {
          report.wouldUpdate.push(t.slug);
          deps.log(`  ${t.slug}: ${current} s → would set ${targetSeconds} s`);
        }
      } else {
        const outcome = await deps.set(t.neonProjectId, targetSeconds);
        if (outcome === 'not-found') notFound();
        else {
          report.updated.push(t.slug);
          deps.log(`  ${t.slug}: ✓ set to ${targetSeconds} s`);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      report.failed.push({ slug: t.slug, error });
      deps.log(`  ${t.slug}: ✗ ${error}`);
    }
  }
  return report;
}
