/**
 * The expand/contract guard's rules (see MIGRATIONS.md), pure so they can be unit tested
 * (src/__tests__/unit/check-migration-safety.test.ts). The CLI is scripts/check-migration-safety.ts.
 *
 * Migrations run BEFORE the new code is deployed, so the currently-live code must keep working against the migrated
 * schema. Only NEW migration files (journal entries past each root's baseline idx) are scanned, statement by statement
 * (`--> statement-breakpoint` chunks), for SQL that isn't backward-compatible.
 *
 * Opting out (SWEEP-FINDINGS.md A3-D8): a statement waives ONE pattern per comment, by name:
 *   -- migration-safety: allow <PATTERN NAME>: <reason>
 * e.g. `-- migration-safety: allow ADD CONSTRAINT: the column is added in this migration and is all NULL`. A statement
 * with two unsafe patterns needs two allow lines. An allow naming an unknown pattern, or with no reason, is itself a
 * finding. Shipped migrations are never edited: findings already reviewed in them are listed in REVIEWED_FINDINGS.
 */

export type JournalEntry = { idx: number; when: number; tag: string };
export type Journal = { entries: JournalEntry[] };

export type MigrationRoot = {
  label: string;
  folder: string;
  /** Last idx that existed before this guard was introduced — those migrations are exempt because they already
   *  shipped; only migrations authored AFTER this baseline are checked. */
  baselineIdx: number;
};

// Tenant migrations (./drizzle) ran up through 0009_dry_tempest.sql (idx 9) when this guard was introduced; control-plane
// migrations (./drizzle/control-plane) through 0001_lucky_leper_queen.sql (idx 1). Bump these only to re-baseline
// deliberately — never to silence a real finding.
export const ROOTS: MigrationRoot[] = [
  { label: 'tenant', folder: './drizzle', baselineIdx: 9 },
  { label: 'control-plane', folder: './drizzle/control-plane', baselineIdx: 1 },
];

export const UNSAFE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'DROP TABLE', re: /\bDROP\s+TABLE\b/i },
  { name: 'DROP COLUMN', re: /\bDROP\s+COLUMN\b/i },
  { name: 'RENAME', re: /\bRENAME\b/i },
  { name: 'ALTER COLUMN ... TYPE', re: /ALTER\s+COLUMN\s+"?[\w]+"?\s+(?:SET\s+DATA\s+)?TYPE\b/i },
  { name: 'ALTER COLUMN ... SET NOT NULL', re: /ALTER\s+COLUMN\s+"?[\w]+"?\s+SET\s+NOT\s+NULL\b/i },
  { name: 'DROP TYPE', re: /\bDROP\s+TYPE\b/i },
  // A3-D8: a new constraint can fail on existing rows, or refuse a write the live code still makes. Not flagged on a
  // table created in the same migration file (no rows, no live code): drizzle's normal FK output for a new table.
  { name: 'ADD CONSTRAINT', re: /\bADD\s+CONSTRAINT\b/i },
  { name: 'DROP INDEX', re: /\bDROP\s+INDEX\b/i },
  { name: 'DROP CONSTRAINT', re: /\bDROP\s+CONSTRAINT\b/i },
  { name: 'DROP TRIGGER', re: /\bDROP\s+TRIGGER\b/i },
  // Not the trigger event clause `BEFORE TRUNCATE ON "t"` (the append-only guards, 0013/0014/0017).
  { name: 'TRUNCATE', re: /\bTRUNCATE\b(?!\s+ON\b)/i },
  // A statement, not `ON DELETE cascade` (every FK) or `BEFORE UPDATE OR DELETE ON`.
  { name: 'DELETE', re: /\bDELETE\s+FROM\b/i },
];

/**
 * Findings in SHIPPED migrations that were reviewed as safe when the pattern was added (SWEEP-FINDINGS.md A3-D8; the
 * lead's ruling 2026-11-19: shipped migrations are never edited, not even their comments). Each entry waives exactly
 * `count` statements of ONE pattern in ONE file; anything more in that file is still a finding. Never add a new
 * migration here — new migrations use the named allow comment.
 */
export const REVIEWED_FINDINGS: ReadonlyArray<{ root: string; tag: string; pattern: string; count: number; reason: string }> = [
  {
    root: 'tenant', tag: '0011_solid_gideon', pattern: 'ALTER COLUMN ... TYPE', count: 10,
    reason: 'pre-launch type change to calendar date; no production tenants (feature-plan-calendar-dates.md §2)',
  },
  {
    root: 'tenant', tag: '0014_certified_outputs', pattern: 'ADD CONSTRAINT', count: 5,
    reason: 'FKs period_events.import_batch_id, timesheet_entries.import_batch_id, users.approver_id and the CHECKs on '
      + 'indirect_charge_codes.leave_pay_type and workspace_settings.workweek_start_day: every column is added nullable '
      + '(all NULL) in this same migration, and both CHECKs accept NULL',
  },
  {
    root: 'tenant', tag: '0019_huge_starfox', pattern: 'ADD CONSTRAINT', count: 1,
    reason: 'login_attempts_no_raw_ip (ip_address IS NULL): nothing writes the column; the pre-check counts 0 rows '
      + '(feature-plan-upstash-rate-limiting.md §6.8)',
  },
];

const ALLOW_LINE_RE = /--\s*migration-safety:\s*allow\b(.*)$/gim;

export type Finding = { root: string; tag: string; pattern: string; statement: string };
export type Allowance = { root: string; tag: string; pattern: string; reason: string };
export type CheckResult = { findings: Finding[]; allowances: Allowance[]; notes: string[] };

/** Tables a migration file creates (`CREATE TABLE [IF NOT EXISTS] ["schema".]"name"`). */
export function createdTables(content: string): Set<string> {
  const out = new Set<string>();
  for (const m of content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi)) out.add(m[1].toLowerCase());
  return out;
}

/** The statement without its comment-only lines: patterns never match inside comments. */
function codeOnly(statement: string): string {
  return statement.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
}

/** `allow <PATTERN>: <reason>` → the pattern's canonical name and the reason, or an error. */
export function parseAllow(rest: string): { pattern: string; reason: string } | { error: string } {
  const text = rest.trim();
  for (const { name } of UNSAFE_PATTERNS) {
    if (text.toUpperCase().startsWith(`${name.toUpperCase()}:`)) {
      const reason = text.slice(name.length + 1).trim();
      return reason ? { pattern: name, reason } : { error: `allow ${name}: has no reason` };
    }
  }
  return { error: `allow names no known pattern (expected "allow <PATTERN>: <reason>", PATTERN one of: ${UNSAFE_PATTERNS.map((p) => p.name).join(', ')})` };
}

/** Scans one migration file's SQL. `reviewed` are this file's REVIEWED_FINDINGS entries. */
export function checkMigrationSql(
  root: string,
  tag: string,
  content: string,
  reviewed: ReadonlyArray<{ pattern: string; count: number; reason: string }> = [],
): CheckResult {
  const result: CheckResult = { findings: [], allowances: [], notes: [] };
  const newTables = createdTables(content);
  const reviewLeft = new Map(reviewed.map((r) => [r.pattern, r.count]));

  for (const statement of content.split('--> statement-breakpoint')) {
    const code = codeOnly(statement);
    const allowed = new Map<string, string>();
    for (const m of statement.matchAll(ALLOW_LINE_RE)) {
      const parsed = parseAllow(m[1]);
      if ('error' in parsed) {
        // A shipped file with a reviewed list keeps its old, unnamed allow lines; the list replaces them.
        if (reviewed.length > 0) result.notes.push(`[${root}] ${tag} — legacy allow comment (covered by the reviewed list)`);
        else result.findings.push({ root, tag, pattern: 'INVALID ALLOW', statement: `${parsed.error}: ${m[0].trim()}` });
      } else {
        allowed.set(parsed.pattern, parsed.reason);
      }
    }

    for (const { name, re } of UNSAFE_PATTERNS) {
      if (!re.test(code)) continue;
      if (name === 'ADD CONSTRAINT') {
        const table = code.match(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:"?\w+"?\.)?"?(\w+)"?/i)?.[1]?.toLowerCase();
        if (table && newTables.has(table)) continue;
      }
      const allowReason = allowed.get(name);
      if (allowReason !== undefined) {
        result.allowances.push({ root, tag, pattern: name, reason: allowReason });
        allowed.delete(name);
        continue;
      }
      const left = reviewLeft.get(name) ?? 0;
      if (left > 0) {
        reviewLeft.set(name, left - 1);
        const entry = reviewed.find((r) => r.pattern === name)!;
        result.allowances.push({ root, tag, pattern: name, reason: `reviewed: ${entry.reason}` });
        continue;
      }
      result.findings.push({ root, tag, pattern: name, statement: code.trim().slice(0, 200) });
    }
    for (const name of allowed.keys()) result.notes.push(`[${root}] ${tag} — unused allow for ${name}`);
  }
  for (const [pattern, left] of reviewLeft) {
    if (left > 0) result.notes.push(`[${root}] ${tag} — reviewed list expects ${left} more ${pattern} statement(s) than found`);
  }
  return result;
}

export interface MigrationFiles {
  readJournal(folder: string): Journal | null;
  /** The file's content, or null when it doesn't exist. */
  readSql(folder: string, tag: string): string | null;
}

/** Every root's new migrations. Pure over `files`; the CLI passes the real file system. */
export function checkMigrations(roots: ReadonlyArray<MigrationRoot>, files: MigrationFiles, reviewedList = REVIEWED_FINDINGS): CheckResult & { log: string[] } {
  const out: CheckResult & { log: string[] } = { findings: [], allowances: [], notes: [], log: [] };
  for (const root of roots) {
    const journal = files.readJournal(root.folder);
    if (!journal) {
      out.log.push(`• ${root.label}: no journal at ${root.folder} — skipping.`);
      continue;
    }
    const newEntries = journal.entries.filter((e) => e.idx > root.baselineIdx);
    if (newEntries.length === 0) {
      out.log.push(`• ${root.label}: no new migrations past baseline idx ${root.baselineIdx}.`);
      continue;
    }
    for (const entry of newEntries) {
      const content = files.readSql(root.folder, entry.tag);
      if (content === null) {
        out.findings.push({ root: root.label, tag: entry.tag, pattern: 'MISSING FILE', statement: `${root.folder}/${entry.tag}.sql` });
        continue;
      }
      const reviewed = reviewedList.filter((r) => r.root === root.label && r.tag === entry.tag);
      const r = checkMigrationSql(root.label, entry.tag, content, reviewed);
      out.findings.push(...r.findings);
      out.allowances.push(...r.allowances);
      out.notes.push(...r.notes);
    }
  }
  return out;
}
