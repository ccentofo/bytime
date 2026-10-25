import { readFileSync } from 'fs';
import path from 'path';

/**
 * Certified outputs fix round 1, F16: is the local control-plane database behind drizzle/control-plane? drizzle's
 * migrator applies every journal entry whose `when` (folder millis) is later than the last applied row's created_at,
 * so the applied count is the number of journal entries at or before that timestamp.
 */
export function controlPlaneMigrationGap(journalWhens: number[], lastAppliedAt: number | null): { applied: number; total: number; behind: boolean } {
  const total = journalWhens.length;
  const applied = lastAppliedAt === null ? 0 : journalWhens.filter((w) => w <= lastAppliedAt).length;
  return { applied, total, behind: applied < total };
}

export function controlPlaneBehindMessage(gap: { applied: number; total: number }): string {
  return `Control-plane database is behind (${gap.applied} of ${gap.total} migrations) — run \`npm run db:migrate:cp\` with CONTROL_PLANE_DATABASE_URL set.`;
}

export function controlPlaneJournalWhens(root = process.cwd()): number[] {
  const journal = JSON.parse(readFileSync(path.join(root, 'drizzle/control-plane/meta/_journal.json'), 'utf8')) as { entries: Array<{ when: number }> };
  return journal.entries.map((e) => e.when);
}
