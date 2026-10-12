/**
 * CI guard for the expand/contract rule (see MIGRATIONS.md): migrations run BEFORE the new code
 * is deployed, so the currently-live code must keep working against the migrated schema. A
 * DROP, RENAME, type change, or SET NOT NULL on a populated column breaks production mid-deploy.
 *
 * Scans only NEW migration files — journal entries past the baseline index below — for SQL
 * statements that aren't backward-compatible. A statement can opt out with a comment on the line
 * immediately above it: `-- migration-safety: allow <reason>`; the reason is printed so reviewers
 * see exactly why it was judged safe.
 *
 * Usage: tsx scripts/check-migration-safety.ts
 * Exit 0 if every new migration is safe (or has an explicit, explained opt-out); exit 1 otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';

type JournalEntry = { idx: number; when: number; tag: string };
type Journal = { entries: JournalEntry[] };

type MigrationRoot = {
  label: string;
  folder: string;
  /** Last idx that existed before this guard was introduced — those migrations are exempt
   *  because they already shipped; only migrations authored AFTER this baseline are checked. */
  baselineIdx: number;
};

// Tenant migrations (./drizzle) run up through 0009_dry_tempest.sql (idx 9) as of this guard's
// introduction. Control-plane migrations (./drizzle/control-plane) run through
// 0001_lucky_leper_queen.sql (idx 1). Bump these only if you are deliberately re-baselining —
// never to silence a real finding.
const ROOTS: MigrationRoot[] = [
  { label: 'tenant', folder: './drizzle', baselineIdx: 9 },
  { label: 'control-plane', folder: './drizzle/control-plane', baselineIdx: 1 },
];

const ALLOW_COMMENT_RE = /--\s*migration-safety:\s*allow\s+(.+)/i;

const UNSAFE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'DROP TABLE', re: /\bDROP\s+TABLE\b/i },
  { name: 'DROP COLUMN', re: /\bDROP\s+COLUMN\b/i },
  { name: 'RENAME', re: /\bRENAME\b/i },
  { name: 'ALTER COLUMN ... TYPE', re: /ALTER\s+COLUMN\s+"?[\w]+"?\s+(?:SET\s+DATA\s+)?TYPE\b/i },
  { name: 'ALTER COLUMN ... SET NOT NULL', re: /ALTER\s+COLUMN\s+"?[\w]+"?\s+SET\s+NOT\s+NULL\b/i },
  { name: 'DROP TYPE', re: /\bDROP\s+TYPE\b/i },
];

type Finding = { root: string; tag: string; pattern: string; statement: string };
type Allowance = { root: string; tag: string; pattern: string; reason: string };

function readJournal(folder: string): Journal | null {
  const journalPath = path.join(folder, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) return null;
  return JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal;
}

function checkRoot(root: MigrationRoot, findings: Finding[], allowances: Allowance[]) {
  const journal = readJournal(root.folder);
  if (!journal) {
    console.log(`• ${root.label}: no journal at ${root.folder} — skipping.`);
    return;
  }

  const newEntries = journal.entries.filter((e) => e.idx > root.baselineIdx);
  if (newEntries.length === 0) {
    console.log(`• ${root.label}: no new migrations past baseline idx ${root.baselineIdx}.`);
    return;
  }

  for (const entry of newEntries) {
    const sqlPath = path.join(root.folder, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlPath)) {
      findings.push({ root: root.label, tag: entry.tag, pattern: 'MISSING FILE', statement: sqlPath });
      continue;
    }
    const content = fs.readFileSync(sqlPath, 'utf8');
    const statements = content.split('--> statement-breakpoint');

    for (const statement of statements) {
      const allowMatch = statement.match(ALLOW_COMMENT_RE);
      for (const { name, re } of UNSAFE_PATTERNS) {
        if (!re.test(statement)) continue;
        if (allowMatch) {
          allowances.push({ root: root.label, tag: entry.tag, pattern: name, reason: allowMatch[1].trim() });
        } else {
          findings.push({ root: root.label, tag: entry.tag, pattern: name, statement: statement.trim().slice(0, 200) });
        }
      }
    }
  }
}

function main() {
  const findings: Finding[] = [];
  const allowances: Allowance[] = [];

  console.log('Checking new migrations for backward-incompatible SQL…\n');
  for (const root of ROOTS) checkRoot(root, findings, allowances);

  if (allowances.length > 0) {
    console.log('\nExplicit opt-outs found:');
    for (const a of allowances) {
      console.log(`  • [${a.root}] ${a.tag} — ${a.pattern} — allowed: ${a.reason}`);
    }
  }

  if (findings.length > 0) {
    console.error('\n✗ Backward-incompatible migration statement(s) found:\n');
    for (const f of findings) {
      console.error(`  [${f.root}] ${f.tag} — ${f.pattern}`);
      console.error(`    ${f.statement}\n`);
    }
    console.error(
      'Migrations run BEFORE the new code deploys — the currently-live code must keep working\n' +
      'against the migrated schema. Split destructive changes across two deploys (see MIGRATIONS.md),\n' +
      'or add `-- migration-safety: allow <reason>` on the line above the statement if it is genuinely safe.'
    );
    process.exit(1);
  }

  console.log('\n✓ No backward-incompatible migration statements found.');
  process.exit(0);
}

main();
