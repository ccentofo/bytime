import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  stripComments,
  parseExportedFunctions,
  parameterNames,
  writePayloads,
} from '../helpers/source-scanner';

// ---------------------------------------------------------------------------
// Guard-coverage test.
//
// Every exported function in a `'use server'` file is a public HTTP endpoint —
// callable with arbitrary arguments by anyone who can reach the app, logged in
// or not. This test statically scans every file in src/server/actions/ (and
// fails if a 'use server' file exists anywhere else under src/) and
// asserts that each exported function either:
//   (a) calls one of the session guards (requireSession/requireAdmin/
//       requireApprover) or getTenantForBilling (which itself requires a
//       session) somewhere in its body, or
//   (b) is explicitly listed in PUBLIC_ACTIONS below, with a justification.
//
// It also asserts that no exported function's parameter list accepts an
// "acting identity" parameter (adminUserId/reviewedBy/createdByUserId/
// assignedBy) — identity must come from the session, never from the caller.
// ---------------------------------------------------------------------------

const ACTIONS_DIR = path.resolve(__dirname, '../../server/actions');

const GUARD_PATTERN = /\b(requireSession|requireAdmin|requireApprover|requireAdminFresh|requireApproverFresh|getTenantForBilling)\s*\(/;
const IDENTITY_PARAM_PATTERN = /\b(adminUserId|reviewedBy|createdByUserId|assignedBy)\s*(\?)?\s*:/;
const DB_QUERY_PATTERN = /\b(db|tx)\.(select|insert|update|delete|execute|transaction|query)\b/;
// §3.2 write gate: a DB write (insert/update/delete, direct or inside a transaction) must run
// against a client obtained from getDbForWrite() — the only accessor that enforces 'full' mode —
// unless the function is a security function on the getDbForAuth() allowlist below.
// Whitespace-tolerant: `db\n  .insert(` (a chain split across lines) is still a write. Raw SQL writes count too.
const DB_WRITE_PATTERN = /\b(?:db|tx)\s*\.\s*(?:insert|update|delete)\s*\(|\.execute\(\s*sql`\s*(?:insert|update|delete)\b/i;
const WRITE_GATE_PATTERN = /\bgetDbForWrite\s*\(/;
const AUTH_GATE_PATTERN = /\bgetDbForAuth\s*\(/;
const SRC_DIR = path.resolve(__dirname, '../..');


/**
 * Explicit allowlist of exported server actions that intentionally run without
 * a session guard, each with a justification. Keep this list in sync with
 * reality — a stale entry (name no longer exported) fails the test below.
 */
const PUBLIC_ACTIONS: Record<string, { names: string[]; reason: string }> = {
  'password-reset.ts': {
    names: ['requestPasswordReset', 'verifyResetToken', 'resetPassword'],
    reason:
      'Unauthenticated password-reset flow (forgot-password). Identity comes from a ' +
      'single-use, hashed, expiring token mailed to the account email, not from a caller-' +
      'supplied id — equivalent to a session for this purpose. Rate-limited.',
  },
  'signup.ts': {
    names: ['checkSlugAvailable', 'startSignup', 'resendSignupVerification'],
    reason:
      'Unauthenticated new-tenant signup flow — there is no session to require before a ' +
      'workspace exists. IP rate-limited; startSignup only mints a verification email, it ' +
      'does not provision anything. resendSignupVerification (feature-plan-launch-blockers.md P5, ' +
      'flag-gated) is Turnstile-gated, re-mails only a pending row matching email + slug, and ' +
      'always answers the same generic message (no enumeration).',
  },
  'login-attempts.ts': {
    names: ['checkLockout'],
    reason:
      'Pre-login lockout banner: the client calls this before any authentication has ' +
      'happened, so there is no session yet. Read-only, keyed by email, no sensitive data.',
  },
  'workspace-finder.ts': {
    names: ['goToWorkspace'],
    reason:
      'Apex "Find your workspace" (launch-blockers P2): runs on the apex, where no session exists. ' +
      'Read-only registry lookup; redirects only to <isValidSlug label>.<APP_ROOT_DOMAIN> + an exact ' +
      'allowlisted path; shares the signup availability check\'s rate-limit budget.',
  },
};

/**
 * §3.2: security functions that write auth/account credentials (password, MFA, notification
 * preferences) and must keep working in `read_only` and `billing_only` mode, not just `full` —
 * otherwise a suspended tenant's admin could be locked out of fixing their own billing issue, or
 * a user on an expired trial could never change a compromised password. These call getDbForAuth()
 * (rejects only `closed`) instead of getDbForWrite() (rejects anything but `full`). None of them
 * touch customer/business data (timesheets, contracts, charge codes, etc).
 */
const WRITE_GATE_AUTH_ALLOWLIST: Record<string, { names: string[]; reason: string }> = {
  'password.ts': {
    names: ['changePassword', 'adminResetPassword'],
    reason: 'Credential-only write (password hash + session version). Must keep working for a ' +
      'suspended tenant\'s admin managing accounts, and for any user changing a compromised password.',
  },
  'password-reset.ts': {
    names: ['requestPasswordReset', 'resetPassword'],
    reason: 'Unauthenticated forgot-password flow; must not be blocked by workspace mode — a ' +
      'locked-out user still needs to be able to reset their password.',
  },
  'mfa.ts': {
    names: ['completeMFASetup', 'disableMFA'],
    reason: 'Credential-only write (TOTP secret / recovery codes). Same rationale as password.ts.',
  },
  'notifications.ts': {
    names: ['updateNotificationPreferences'],
    reason: 'D5: users keep their normal role-scoped capabilities in read_only/billing_only. ' +
      'Not business/customer data, so it is allowlisted rather than blocked by the write gate.',
  },
};

/**
 * feature-plan-launch-blockers.md P3 (LB-D4): the cached `requireAdmin()` trusts the JWT role, which can be up to
 * 60 s stale — a demoted admin keeps admin powers until it refreshes. So `requireAdmin()` is BANNED in exported
 * actions; anything that writes uses `requireAdminFresh()`. The only exceptions are listed here: actions that
 * perform NO write and call NO writing helper (any DB write — including credential/token bookkeeping such as an
 * OAuth refresh or a login-attempt reset — disqualifies an action). Each entry is checked below: it must still be
 * exported, still use requireAdmin(), and contain no write.
 */
const ADMIN_READ_ONLY_ALLOWLIST: Record<string, Record<string, string>> = {
  'api-keys.ts': { getApiKeys: 'lists key metadata (name/prefix/dates); no write' },
  'assignments.ts': {
    getAssignments: 'reads CLIN assignments for the admin table; no write',
    getAssignmentsForUser: 'reads one user\'s CLIN assignments; no write',
  },
  'billing.ts': { getTenantBillingInfo: 'reads the control-plane billing fields; no write' },
  'charge-codes.ts': {
    listCostClasses: 'reads cost classes; no write',
    listChargeCodes: 'reads charge codes with joined labels; no write',
    getUserChargeCodeIds: 'reads one user\'s active charge-code ids; no write',
    getChargeCodeAssignments: 'reads user↔charge-code assignments; no write',
  },
  'clins.ts': { getClinsByContract: 'reads CLINs of a contract; no write' },
  'contracts.ts': {
    getContracts: 'reads contracts; no write',
    getContractById: 'reads one contract; no write',
  },
  'dashboard.ts': {
    getContractSummaries: 'aggregates hours/cost per contract; read-only queries',
    getPeriodCostReport: 'aggregates a period\'s cost; read-only queries',
  },
  'gusto.ts': { getBytimeEmployeesForGustoMapping: 'reads active employees for the mapping UI; no token refresh, no write' },
  'indirect-codes.ts': {
    getIndirectChargeCodes: 'reads indirect codes; no write',
    getActiveIndirectCodes: 'reads active indirect codes; no write',
  },
  'integrations.ts': {
    getAvailableConnectors: 'returns static connector metadata; no DB access',
    getConnections: 'reads connection rows (no tokens selected); no write',
    getMappings: 'reads entity mappings; no write',
    getSyncLogs: 'reads sync logs; no write',
    getSyncRecords: 'reads sync records; no write',
  },
  'labor-categories.ts': {
    getAllLaborCategories: 'reads labor categories; no write',
    getAssignableLaborCategories: 'reads assignable labor categories; no write',
    getLaborCategoriesByClin: 'reads a CLIN\'s labor categories; no write',
    getUserLaborCategoryAssignments: 'reads one user\'s LCAT assignments; no write',
  },
  'pay-period-config.ts': {
    getConfigHistory: 'reads schedule history; no write',
    getPendingConfigChange: 'reads the pending schedule change; no write',
    getValidScheduleChangeDates: 'computes valid change dates from reads; no write',
  },
  'payroll-export.ts': {
    getPayrollFormats: 'returns static format metadata; no DB access',
    getPayrollExportPreview: 'reads approved entries (getApprovedEntriesForSync is read-only); no write',
    generatePayrollExportCSV: 'builds a CSV from read-only approved entries; no write',
  },
  'qbo.ts': {
    getBytimeEmployeesForMapping: 'reads active employees; no token refresh, no write',
    getBytimeContractsForMapping: 'reads active contracts; no token refresh, no write',
    getBytimeClinsForMapping: 'reads active CLINs; no token refresh, no write',
  },
  'reports.ts': { getDetailedCostReport: 'reads cost report rows via the read-only internal reader; no write' },
  'setup.ts': { getSetupStatus: 'reads setup-checklist counts; no write' },
  'slins.ts': { getSlinsByClin: 'reads a CLIN\'s SLINs; no write' },
  'users.ts': { getUsers: 'reads users (SAFE_USER_COLUMNS); no write' },
};

/** Matches the cached guard only — `requireAdminFresh(` does not match (an "F" follows "requireAdmin"). */
const CACHED_ADMIN_PATTERN = /\brequireAdmin\s*\(/;

/**
 * Launch-blockers audit A1: in a userAction-wrapped action the FIRST awaited call must be the session guard. Anything
 * awaited before it (getDbForWrite above all) can throw a state-specific error — "suspended", "read-only", "on hold" —
 * that userAction returns to the caller, letting an anonymous POST to victim.<root> learn the workspace's billing state.
 */
const SESSION_GUARD_CALLEE = /^(?:requireSession|requireAdmin|requireApprover|requireAdminFresh|requireApproverFresh)$/;
const FIRST_AWAIT = /\bawait\s+([\w.]+)/;

function guardNotFirstAwait(fns: Array<{ name: string; bodyText: string }>, publicNames: string[]): string[] {
  return fns
    .filter((fn) => /\buserAction\s*\(/.test(fn.bodyText) && !publicNames.includes(fn.name))
    .map((fn) => ({ name: fn.name, first: FIRST_AWAIT.exec(fn.bodyText)?.[1] ?? '(no await)' }))
    .filter(({ first }) => !SESSION_GUARD_CALLEE.test(first))
    .map(({ name, first }) => `${name} (first await: ${first})`);
}
/** Helpers known to write (DB or credential bookkeeping) — calling one disqualifies a read-only allowlist entry. */
const WRITING_HELPER_PATTERN = /\b(?:getDbForWrite|getDbForAuth|executeSyncOperation|unlockAccount|ensureValidToken|ensureValidGustoToken)\s*\(/;

/**
 * Violations of the cached-admin ban in one actions file: an exported action using requireAdmin() without an
 * allowlist entry, or an allowlisted action that writes / calls a writing helper / calls a non-allowlisted action
 * of the same file.
 */
function cachedAdminViolations(source: string, allowed: Record<string, string>): string[] {
  const fns = parseExportedFunctions(source);
  const exported = new Set(fns.map((f) => f.name));
  const out: string[] = [];
  for (const fn of fns) {
    if (!CACHED_ADMIN_PATTERN.test(fn.bodyText)) continue;
    if (!(fn.name in allowed)) {
      out.push(`${fn.name}: uses cached requireAdmin() — use requireAdminFresh(), or allowlist a provably read-only action`);
      continue;
    }
    if (DB_WRITE_PATTERN.test(fn.bodyText) || WRITING_HELPER_PATTERN.test(fn.bodyText)) {
      out.push(`${fn.name}: allowlisted as read-only but writes (or calls a writing helper)`);
      continue;
    }
    const calledWriter = [...exported].find((other) => other !== fn.name && !(other in allowed) && new RegExp(`\\b${other}\\s*\\(`).test(fn.bodyText));
    if (calledWriter) out.push(`${fn.name}: allowlisted as read-only but calls ${calledWriter}`);
  }
  return out;
}





/**
 * Every file under src/ whose first statement is the 'use server' directive. All of them must
 * live in src/server/actions/ so the checks below see them — a server-action file anywhere else
 * is a public endpoint this test would silently skip.
 */
function findUseServerFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      found.push(...findUseServerFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      const head = stripComments(fs.readFileSync(full, 'utf-8')).trimStart();
      if (/^['"]use server['"]/.test(head)) found.push(full);
    }
  }
  return found;
}

describe('Server action guard coverage', () => {
  const files = fs.readdirSync(ACTIONS_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  expect(files.length).toBeGreaterThan(0);

  for (const file of files) {
    const rawSource = fs.readFileSync(path.join(ACTIONS_DIR, file), 'utf-8');
    const source = stripComments(rawSource);
    const fns = parseExportedFunctions(source);
    const allowlist = PUBLIC_ACTIONS[file]?.names ?? [];

    it(`${file}: no exported action uses the cached requireAdmin() unless allowlisted as read-only (P3)`, () => {
      const violations = cachedAdminViolations(source, ADMIN_READ_ONLY_ALLOWLIST[file] ?? {});
      expect(violations, `${file}: ${violations.join('; ')}`).toEqual([]);
    });

    it(`${file}: every exported action is guarded or explicitly public`, () => {
      const unguarded = fns
        .filter((fn) => !GUARD_PATTERN.test(fn.bodyText) && !allowlist.includes(fn.name))
        .map((fn) => fn.name);

      expect(
        unguarded,
        `${file} has exported action(s) with no session guard and no PUBLIC_ACTIONS entry: ${unguarded.join(', ')}`
      ).toEqual([]);
    });

    it(`${file}: in every userAction callback the first await is the session guard (audit A1)`, () => {
      const late = guardNotFirstAwait(fns, allowlist);
      expect(late, `${file}: ${late.join('; ')}`).toEqual([]);
    });

    it(`${file}: no exported action accepts an acting-identity parameter`, () => {
      const offenders = fns
        .filter((fn) => IDENTITY_PARAM_PATTERN.test(fn.paramText))
        .map((fn) => fn.name);

      expect(
        offenders,
        `${file} has exported action(s) accepting an identity parameter (adminUserId/reviewedBy/createdByUserId/assignedBy) instead of deriving it from the session: ${offenders.join(', ')}`
      ).toEqual([]);
    });

    // R2-12: a guard call appearing anywhere in the body isn't enough — it must run BEFORE the
    // first DB query, or data can already have been read/written by the time it fires.
    it(`${file}: the guard call (when present) runs before the first DB query`, () => {
      const offenders = fns
        .filter((fn) => {
          if (allowlist.includes(fn.name)) return false;
          const guardMatch = GUARD_PATTERN.exec(fn.bodyText);
          const queryMatch = DB_QUERY_PATTERN.exec(fn.bodyText);
          return Boolean(guardMatch && queryMatch && queryMatch.index < guardMatch.index);
        })
        .map((fn) => fn.name);

      expect(
        offenders,
        `${file} has exported action(s) where a DB query runs before the guard check: ${offenders.join(', ')}`
      ).toEqual([]);
    });

    // R2-6: a caller-supplied object passed straight into a DB write — whole (`.values(data)`)
    // or spread (`.set({ ...data })`) — lets the caller set columns the form never intended to
    // expose (role, passwordHash, isActive, userId, ...).
    it(`${file}: no DB write passes or spreads a raw caller-supplied parameter`, () => {
      const offenders: string[] = [];
      for (const fn of fns) {
        for (const param of parameterNames(fn.paramText)) {
          const whole = new RegExp(`^\\s*${param}\\s*(as\\b[\\s\\S]*)?$`);
          const spread = new RegExp(`\\.\\.\\.\\s*${param}\\b`);
          for (const payload of writePayloads(fn.bodyText)) {
            if (whole.test(payload) || spread.test(payload)) offenders.push(`${fn.name}(${param})`);
          }
        }
      }
      expect(
        offenders,
        `${file} writes a caller-supplied parameter directly into .values()/.set() — build an explicit allowlist instead: ${offenders.join(', ')}`
      ).toEqual([]);
    });

    // §3.2: a DB write must go through getDbForWrite() ('full' mode only), unless the function is
    // a documented security function allowed to use getDbForAuth() instead (rejects only 'closed').
    it(`${file}: every DB write uses the write gate (getDbForWrite), except allowlisted security functions`, () => {
      const authAllowlist = WRITE_GATE_AUTH_ALLOWLIST[file]?.names ?? [];
      const offenders = fns
        .filter((fn) => DB_WRITE_PATTERN.test(fn.bodyText))
        .filter((fn) => {
          if (WRITE_GATE_PATTERN.test(fn.bodyText)) return false;
          if (authAllowlist.includes(fn.name) && AUTH_GATE_PATTERN.test(fn.bodyText)) return false;
          return true;
        })
        .map((fn) => fn.name);

      expect(
        offenders,
        `${file} has exported action(s) with a DB write that doesn't call getDbForWrite() (or getDbForAuth() with a WRITE_GATE_AUTH_ALLOWLIST entry): ${offenders.join(', ')}`
      ).toEqual([]);
    });

    // The scanner only understands `export async function`. Any other export form would be a
    // public endpoint that none of the checks above ever look at.
    it(`${file}: every export is an \`export async function\` the scanner can check`, () => {
      // Also bans re-exports (`export { x }`, `export type { T }`): Turbopack's server-action
      // transform registers a re-exported TYPE as an action and the build fails. Consumers
      // should `import type` from the module that declares it.
      const otherExports = source.match(/export\s+(?:const|let|var|function|default|class|type\s*\{|\{|\*)[^\n]*/g) ?? [];
      expect(otherExports, `${file} has export(s) the guard scanner can't parse: ${otherExports.join(' | ')}`).toEqual([]);
    });
  }

  // §5.1: internal helpers and integration code aren't server actions, so the per-function rule above never
  // sees them. Writing through getDb() can't compile (it returns ReadDb, which has no insert/update/delete);
  // the remaining bypass is getDbForUrl(), which returns an unrestricted client. Business-data code here must
  // never use it — only infrastructure (auth, crons, provisioning, notices, export) may.
  it('src/server/internal and src/lib/integrations never use the unrestricted getDbForUrl() client', () => {
    const roots = [path.join(SRC_DIR, 'server/internal'), path.join(SRC_DIR, 'lib/integrations')];
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
    const offenders = roots.flatMap(walk)
      .filter((file) => /\bgetDbForUrl\s*\(/.test(stripComments(fs.readFileSync(file, 'utf-8'))))
      .map((f) => path.relative(SRC_DIR, f));
    expect(offenders, `getDbForUrl() used in business-data code: ${offenders.join(', ')}`).toEqual([]);
  });

  it('DB_WRITE_PATTERN catches multi-line chains and raw SQL writes (mutation check)', () => {
    expect(DB_WRITE_PATTERN.test('const rows = await db\n    .insert(userAssignments)')).toBe(true);
    expect(DB_WRITE_PATTERN.test('await tx .update(x)')).toBe(true);
    expect(DB_WRITE_PATTERN.test('await db.execute(sql`DELETE FROM users`)')).toBe(true);
    expect(DB_WRITE_PATTERN.test('await db.select().from(users)')).toBe(false);
  });

  it("every 'use server' file under src/ lives in src/server/actions/ (so this test scans it)", () => {
    const outside = findUseServerFiles(SRC_DIR)
      .filter((f) => path.dirname(f) !== ACTIONS_DIR)
      .map((f) => path.relative(SRC_DIR, f));
    expect(outside, `'use server' files outside src/server/actions/: ${outside.join(', ')}`).toEqual([]);
  });

  it('PUBLIC_ACTIONS allowlist has no stale entries (file/name must still exist and be exported)', () => {
    const staleEntries: string[] = [];
    for (const [file, { names }] of Object.entries(PUBLIC_ACTIONS)) {
      const fullPath = path.join(ACTIONS_DIR, file);
      if (!fs.existsSync(fullPath)) {
        staleEntries.push(`${file} (file does not exist)`);
        continue;
      }
      const source = fs.readFileSync(fullPath, 'utf-8');
      const exportedNames = new Set(parseExportedFunctions(source).map((fn) => fn.name));
      for (const name of names) {
        if (!exportedNames.has(name)) {
          staleEntries.push(`${file}: ${name}`);
        }
      }
    }
    expect(staleEntries, `Stale PUBLIC_ACTIONS entries: ${staleEntries.join(', ')}`).toEqual([]);
  });

  it('a missing guard inside userAction(...) is still caught (fixture, launch-blockers P4)', () => {
    const fixture = `
      export async function unguarded(id: string) {
        return userAction(async () => {
          const db = await getDbForWrite();
          await db.delete(contracts).where(eq(contracts.id, id));
        });
      }
      export async function guarded(id: string) {
        return userAction(async () => {
          await requireAdminFresh();
          const db = await getDbForWrite();
          await db.delete(contracts).where(eq(contracts.id, id));
        });
      }
      export async function queryFirst(id: string) {
        return userAction(async () => {
          const db = await getDbForWrite();
          const rows = await db.select().from(contracts).where(eq(contracts.id, id));
          await requireAdminFresh();
          return rows;
        });
      }`;
    const fns = parseExportedFunctions(stripComments(fixture));
    expect(fns.map((f) => f.name)).toEqual(['unguarded', 'guarded', 'queryFirst']);
    expect(fns.filter((fn) => !GUARD_PATTERN.test(fn.bodyText)).map((f) => f.name)).toEqual(['unguarded']);
    // The guard-before-first-query rule sees inside the callback too.
    const late = fns.filter((fn) => {
      const g = GUARD_PATTERN.exec(fn.bodyText);
      const q = DB_QUERY_PATTERN.exec(fn.bodyText);
      return Boolean(g && q && q.index < g.index);
    }).map((f) => f.name);
    expect(late).toEqual(['queryFirst']);
  });

  it('guard-first rule: getDbForWrite() (or any call) awaited before the guard is flagged (fixture, audit A1)', () => {
    const fixture = `
      export async function dbFirst(id: string) {
        return userAction(async () => {
          const db = await getDbForWrite();
          await requireAdminFresh();
          await db.delete(apiKeys).where(eq(apiKeys.id, id));
        });
      }
      export async function guardFirst(id: string) {
        return userAction(async () => {
          const actor = await requireApproverFresh();
          const db = await getDbForWrite();
          await db.delete(apiKeys).where(eq(apiKeys.id, actor.id));
        });
      }
      export async function parallel(id: string) {
        return userAction(async () => {
          const [actor, db] = await Promise.all([requireAdminFresh(), getDbForWrite()]);
          await db.delete(apiKeys).where(eq(apiKeys.id, actor.id + id));
        });
      }
      export async function publicOne(id: string) {
        return userAction(async () => {
          const db = await getDbForAuth();
          return db.select().from(apiKeys).where(eq(apiKeys.id, id));
        });
      }`;
    const fns = parseExportedFunctions(stripComments(fixture));
    expect(guardNotFirstAwait(fns, ['publicOne'])).toEqual(['dbFirst (first await: getDbForWrite)', 'parallel (first await: Promise.all)']);
  });

  it('cached-admin ban: adding requireAdmin() to a writer fails (mutation check)', () => {
    const writer = `
      export async function evilWriter(id: string) {
        await requireAdmin();
        const db = await getDbForWrite();
        await db.update(contracts).set({ name: 'x' }).where(eq(contracts.id, id));
      }`;
    expect(cachedAdminViolations(writer, {})).toEqual([expect.stringContaining('evilWriter: uses cached requireAdmin()')]);
    // Allowlisting a writer doesn't help: an allowlisted action that writes is still a violation.
    expect(cachedAdminViolations(writer, { evilWriter: 'claims read-only' })).toEqual([expect.stringContaining('allowlisted as read-only but writes')]);
    // …nor one that writes through a helper, or by calling a writing action in the same file.
    const viaHelper = `export async function refresher() { await requireAdmin(); return ensureValidToken('c'); }`;
    expect(cachedAdminViolations(viaHelper, { refresher: 'x' })).toHaveLength(1);
    const viaAction = `
      export async function bulk() { await requireAdmin(); await writeOne(); }
      export async function writeOne() { await requireAdminFresh(); }`;
    expect(cachedAdminViolations(viaAction, { bulk: 'x' })).toEqual([expect.stringContaining('calls writeOne')]);
    // The fresh guard is not matched.
    expect(cachedAdminViolations(`export async function ok() { await requireAdminFresh(); }`, {})).toEqual([]);
  });

  it('ADMIN_READ_ONLY_ALLOWLIST has no stale entries (must be exported and still use requireAdmin())', () => {
    const stale: string[] = [];
    for (const [file, entries] of Object.entries(ADMIN_READ_ONLY_ALLOWLIST)) {
      const fullPath = path.join(ACTIONS_DIR, file);
      if (!fs.existsSync(fullPath)) { stale.push(`${file} (file does not exist)`); continue; }
      const byName = new Map(parseExportedFunctions(stripComments(fs.readFileSync(fullPath, 'utf-8'))).map((fn) => [fn.name, fn]));
      for (const name of Object.keys(entries)) {
        const fn = byName.get(name);
        if (!fn) stale.push(`${file}: ${name} (not exported)`);
        else if (!CACHED_ADMIN_PATTERN.test(fn.bodyText)) stale.push(`${file}: ${name} (no longer uses requireAdmin() — remove)`);
      }
    }
    expect(stale, `Stale ADMIN_READ_ONLY_ALLOWLIST entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('WRITE_GATE_AUTH_ALLOWLIST has no stale entries (file/name must still exist, be exported, write, and call getDbForAuth)', () => {
    const staleEntries: string[] = [];
    for (const [file, { names }] of Object.entries(WRITE_GATE_AUTH_ALLOWLIST)) {
      const fullPath = path.join(ACTIONS_DIR, file);
      if (!fs.existsSync(fullPath)) {
        staleEntries.push(`${file} (file does not exist)`);
        continue;
      }
      const source = stripComments(fs.readFileSync(fullPath, 'utf-8'));
      const fnsByName = new Map(parseExportedFunctions(source).map((fn) => [fn.name, fn]));
      for (const name of names) {
        const fn = fnsByName.get(name);
        if (!fn) {
          staleEntries.push(`${file}: ${name} (not exported)`);
        } else if (!DB_WRITE_PATTERN.test(fn.bodyText)) {
          staleEntries.push(`${file}: ${name} (no longer performs a DB write — remove from allowlist)`);
        } else if (!AUTH_GATE_PATTERN.test(fn.bodyText)) {
          staleEntries.push(`${file}: ${name} (no longer calls getDbForAuth — remove from allowlist)`);
        }
      }
    }
    expect(staleEntries, `Stale WRITE_GATE_AUTH_ALLOWLIST entries: ${staleEntries.join(', ')}`).toEqual([]);
  });
});
