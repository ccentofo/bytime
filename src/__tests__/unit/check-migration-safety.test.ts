import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkMigrationSql, checkMigrations, parseAllow, ROOTS, REVIEWED_FINDINGS, type Journal } from '../../../scripts/lib/migration-safety';

/**
 * SWEEP-FINDINGS.md A3-D8: `db:safety`'s patterns, its named allow comments and the reviewed list for shipped migrations
 * (the lead's ruling 2026-11-19: shipped migrations are never edited; new migrations name the pattern they allow).
 */

const BP = '\n--> statement-breakpoint\n';
const sql = (...statements: string[]) => statements.join(BP);
const patterns = (r: { findings: Array<{ pattern: string }> }) => r.findings.map((f) => f.pattern);
const check = (content: string, reviewed: Parameters<typeof checkMigrationSql>[3] = []) => checkMigrationSql('tenant', '0099_new', content, reviewed);

describe('db:safety patterns (A3-D8)', () => {
  it.each([
    ['ADD CONSTRAINT', 'ALTER TABLE "users" ADD CONSTRAINT "users_x_check" CHECK ("users"."x" > 0);'],
    ['DROP INDEX', 'DROP INDEX "users_email_idx";'],
    ['DROP CONSTRAINT', 'ALTER TABLE "users" DROP CONSTRAINT "users_x_check";'],
    ['DROP TRIGGER', 'DROP TRIGGER "timesheet_entries_no_truncate" ON "timesheet_entries";'],
    ['TRUNCATE', 'TRUNCATE "login_attempts";'],
    ['TRUNCATE', 'truncate table login_attempts;'],
    ['DELETE', 'DELETE FROM "login_attempts" WHERE "created_at" < now();'],
    ['DROP TABLE', 'DROP TABLE "old";'],
    ['DROP COLUMN', 'ALTER TABLE "users" DROP COLUMN "x";'],
    ['RENAME', 'ALTER TABLE "users" RENAME COLUMN "x" TO "y";'],
    ['ALTER COLUMN ... TYPE', 'ALTER TABLE "users" ALTER COLUMN "x" SET DATA TYPE text;'],
    ['ALTER COLUMN ... SET NOT NULL', 'ALTER TABLE "users" ALTER COLUMN "x" SET NOT NULL;'],
    ['DROP TYPE', 'DROP TYPE "public"."old_enum";'],
  ])('flags %s', (name, statement) => {
    expect(patterns(check(statement))).toEqual([name]);
  });

  it('does not flag the trigger event clauses, ON DELETE in a foreign key, or words in comments', () => {
    const r = check(sql(
      'CREATE TRIGGER t_no_truncate\n  BEFORE TRUNCATE ON "timesheet_entries"\n  FOR EACH STATEMENT EXECUTE FUNCTION f();',
      'CREATE TRIGGER t_append_only\n  BEFORE UPDATE OR DELETE ON "period_events"\n  FOR EACH ROW EXECUTE FUNCTION f();',
      'CREATE TABLE "notes" ("id" uuid PRIMARY KEY, "user_id" uuid);',
      'ALTER TABLE "notes" ADD CONSTRAINT "notes_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      '-- a comment saying DELETE FROM x, TRUNCATE y and DROP INDEX z\nCREATE INDEX "notes_user_idx" ON "notes" ("user_id");',
    ));
    expect(r.findings).toEqual([]);
  });

  it('a constraint on a table created in the same file is exempt; on an existing table it is flagged', () => {
    const r = check(sql(
      'CREATE TABLE IF NOT EXISTS "public"."scopes" ("id" uuid PRIMARY KEY, "clin_id" uuid);',
      'ALTER TABLE "scopes" ADD CONSTRAINT "scopes_clin_fk" FOREIGN KEY ("clin_id") REFERENCES "public"."clins"("id");',
      'ALTER TABLE "clins" ADD CONSTRAINT "clins_scope_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id");',
    ));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ pattern: 'ADD CONSTRAINT' });
    expect(r.findings[0].statement).toContain('"clins"');
  });
});

describe('named allow comments (A3-D8)', () => {
  it('waives only the pattern it names', () => {
    const statement = [
      '-- migration-safety: allow ADD CONSTRAINT: the column is new and all NULL',
      'ALTER TABLE "users" ADD CONSTRAINT "users_x_fk" FOREIGN KEY ("x") REFERENCES "public"."users"("id"), DROP COLUMN "y";',
    ].join('\n');
    const r = check(statement);
    expect(patterns(r)).toEqual(['DROP COLUMN']);
    expect(r.allowances).toEqual([{ root: 'tenant', tag: '0099_new', pattern: 'ADD CONSTRAINT', reason: 'the column is new and all NULL' }]);
  });

  it('one allow line per pattern: two lines waive both', () => {
    const statement = [
      '-- migration-safety: allow add constraint: reviewed',
      '-- migration-safety: allow DROP COLUMN: added and never used in this change set',
      'ALTER TABLE "users" ADD CONSTRAINT "c" CHECK (true), DROP COLUMN "y";',
    ].join('\n');
    expect(check(statement).findings).toEqual([]);
  });

  it('applies to its own statement only', () => {
    const r = check(sql(
      '-- migration-safety: allow DROP INDEX: replaced below\nDROP INDEX "a";',
      'DROP INDEX "b";',
    ));
    expect(patterns(r)).toEqual(['DROP INDEX']);
    expect(r.findings[0].statement).toContain('"b"');
  });

  it.each([
    ['an old unnamed allow', '-- migration-safety: allow pre-launch, no tenants'],
    ['an unknown pattern', '-- migration-safety: allow DROP DATABASE: nope'],
    ['no reason', '-- migration-safety: allow DROP INDEX:'],
    ['no reason and no colon', '-- migration-safety: allow DROP INDEX'],
  ])('%s is itself a finding, and waives nothing', (_label, allowLine) => {
    const r = check(`${allowLine}\nDROP INDEX "a";`);
    expect(patterns(r).sort()).toEqual(['DROP INDEX', 'INVALID ALLOW']);
  });

  it('parseAllow matches pattern names exactly, case-insensitively', () => {
    expect(parseAllow(' ALTER COLUMN ... TYPE: why')).toEqual({ pattern: 'ALTER COLUMN ... TYPE', reason: 'why' });
    expect(parseAllow(' truncate: why')).toEqual({ pattern: 'TRUNCATE', reason: 'why' });
    expect(parseAllow(' ALTER COLUMN TYPE: why')).toHaveProperty('error');
  });
});

describe('the reviewed list for shipped migrations (A3-D8)', () => {
  const reviewed = [{ pattern: 'ADD CONSTRAINT', count: 1, reason: 'column added nullable here' }];
  const existingFk = 'ALTER TABLE "users" ADD CONSTRAINT "users_approver_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id");';

  it('waives its own file and pattern, up to its count', () => {
    expect(check(existingFk, reviewed).findings).toEqual([]);
    const two = check(sql(existingFk, existingFk.replace('users_approver_fk', 'users_other_fk')), reviewed);
    expect(patterns(two)).toEqual(['ADD CONSTRAINT']);
  });

  it('does not waive another pattern in the same file', () => {
    expect(patterns(check(sql(existingFk, 'DROP INDEX "x";'), reviewed))).toEqual(['DROP INDEX']);
  });

  it('a new migration with the same statement and no named allow is flagged', () => {
    const files = {
      readJournal: () => ({ entries: [{ idx: 19, when: 1, tag: '0019_huge_starfox' }, { idx: 20, when: 2, tag: '0020_new' }] }),
      readSql: () => 'ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_no_raw_ip" CHECK ("login_attempts"."ip_address" IS NULL);',
    };
    const r = checkMigrations([{ label: 'tenant', folder: 'x', baselineIdx: 9 }], files);
    expect(r.findings.map((f) => [f.tag, f.pattern])).toEqual([['0020_new', 'ADD CONSTRAINT']]);
  });

  it('only lists shipped migrations (each tag exists in its journal)', () => {
    for (const r of REVIEWED_FINDINGS) {
      const root = ROOTS.find((x) => x.label === r.root)!;
      const journal = JSON.parse(fs.readFileSync(path.join(root.folder, 'meta', '_journal.json'), 'utf8')) as Journal;
      expect(journal.entries.map((e) => e.tag)).toContain(r.tag);
    }
  });
});

describe('the repository passes db:safety', () => {
  it('every new migration in both roots: no finding, and every reviewed entry is used in full', () => {
    const r = checkMigrations(ROOTS, {
      readJournal: (folder) => JSON.parse(fs.readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8')) as Journal,
      readSql: (folder, tag) => fs.readFileSync(path.join(folder, `${tag}.sql`), 'utf8'),
    });
    expect(r.findings).toEqual([]);
    expect(r.notes.filter((n) => n.includes('more'))).toEqual([]);
    const reviewedUsed = r.allowances.filter((a) => a.reason.startsWith('reviewed: ')).length;
    expect(reviewedUsed).toBe(REVIEWED_FINDINGS.reduce((n, e) => n + e.count, 0));
  });
});
