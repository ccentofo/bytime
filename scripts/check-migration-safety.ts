/**
 * CI guard for the expand/contract rule (see MIGRATIONS.md): migrations run BEFORE the new code
 * is deployed, so the currently-live code must keep working against the migrated schema. A
 * DROP, RENAME, type change, SET NOT NULL, a new constraint on existing rows, a DELETE or TRUNCATE
 * breaks production mid-deploy.
 *
 * The rules live in scripts/lib/migration-safety.ts (unit tested). A statement opts out of ONE
 * pattern with a comment naming it: `-- migration-safety: allow <PATTERN>: <reason>`; the reason is
 * printed so reviewers see exactly why it was judged safe.
 *
 * Usage: tsx scripts/check-migration-safety.ts
 * Exit 0 if every new migration is safe (or has an explicit, explained opt-out); exit 1 otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkMigrations, ROOTS, type Journal } from './lib/migration-safety';

function main() {
  console.log('Checking new migrations for backward-incompatible SQL…\n');
  const result = checkMigrations(ROOTS, {
    readJournal(folder) {
      const journalPath = path.join(folder, 'meta', '_journal.json');
      if (!fs.existsSync(journalPath)) return null;
      return JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal;
    },
    readSql(folder, tag) {
      const sqlPath = path.join(folder, `${tag}.sql`);
      return fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, 'utf8') : null;
    },
  });

  for (const line of result.log) console.log(line);

  if (result.allowances.length > 0) {
    console.log('\nExplicit opt-outs found:');
    for (const a of result.allowances) {
      console.log(`  • [${a.root}] ${a.tag} — ${a.pattern} — allowed: ${a.reason}`);
    }
  }
  if (result.notes.length > 0) {
    console.log('\nNotes:');
    for (const n of result.notes) console.log(`  • ${n}`);
  }

  if (result.findings.length > 0) {
    console.error('\n✗ Backward-incompatible migration statement(s) found:\n');
    for (const f of result.findings) {
      console.error(`  [${f.root}] ${f.tag} — ${f.pattern}`);
      console.error(`    ${f.statement}\n`);
    }
    console.error(
      'Migrations run BEFORE the new code deploys — the currently-live code must keep working\n' +
      'against the migrated schema. Split destructive changes across two deploys (see MIGRATIONS.md),\n' +
      'or, if a statement is genuinely safe, add `-- migration-safety: allow <PATTERN>: <reason>` above it\n' +
      '(one line per pattern, the pattern named exactly as listed above).'
    );
    process.exit(1);
  }

  console.log('\n✓ No backward-incompatible migration statements found.');
  process.exit(0);
}

main();
