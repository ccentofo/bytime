import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

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
const DB_WRITE_PATTERN = /\b(db|tx)\.(insert|update|delete)\s*\(/;
const WRITE_GATE_PATTERN = /\bgetDbForWrite\s*\(/;
const AUTH_GATE_PATTERN = /\bgetDbForAuth\s*\(/;
// R2-6: start of a DB write's payload — `.values(` or `.set(`. Its argument must never be a
// caller-supplied parameter, whole or spread, or the caller can set columns the form never offered.
const DB_WRITE_CALL_PATTERN = /\.(values|set)\s*\(/g;
const SRC_DIR = path.resolve(__dirname, '../..');

/**
 * R2-12: strip comments before matching, so a comment that happens to mention a guard name or
 * a banned identity parameter can't fool these checks into thinking real code is present.
 * Doesn't special-case comment-like text inside string/template literals — none of the guard
 * calls, DB queries, or spreads this file looks for occur inside this codebase's string
 * literals, so that's an acceptable simplification.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

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
    names: ['checkSlugAvailable', 'startSignup'],
    reason:
      'Unauthenticated new-tenant signup flow — there is no session to require before a ' +
      'workspace exists. IP rate-limited; startSignup only mints a verification email, it ' +
      'does not provision anything.',
  },
  'login-attempts.ts': {
    names: ['checkLockout'],
    reason:
      'Pre-login lockout banner: the client calls this before any authentication has ' +
      'happened, so there is no session yet. Read-only, keyed by email, no sensitive data.',
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

// ---------------------------------------------------------------------------
// Minimal brace-matching source scanner. We can't pull in a real TS parser
// dependency just for this, and regex-per-line is too fragile given multi-line
// parameter object types — so walk the source char-by-char.
// ---------------------------------------------------------------------------

interface ParsedFunction {
  name: string;
  paramText: string;
  bodyText: string;
}

function parseExportedFunctions(source: string): ParsedFunction[] {
  const results: ParsedFunction[] = [];
  const fnRegex = /export\s+async\s+function\s+(\w+)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = fnRegex.exec(source)) !== null) {
    const name = match[1];
    const parenStart = match.index + match[0].length - 1; // index of the opening '('

    // Find the matching close paren for the parameter list.
    let depth = 0;
    let i = parenStart;
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const paramText = source.slice(parenStart + 1, i);

    // Find the function body's opening brace. Can't just take the first '{' after the
    // param list — a return type like `Promise<{ secret: string }>` has its own braces.
    // Walk forward tracking <>/()/[] nesting so a brace is only "the body" when none of
    // those are open and we're not already inside a nested {} from the type annotation.
    let angleDepth = 0;
    let parenDepth2 = 0;
    let bracketDepth = 0;
    let typeBraceDepth = 0;
    let bodyStart = -1;
    for (let k = i + 1; k < source.length; k++) {
      const ch = source[k];
      if (ch === '<') angleDepth++;
      else if (ch === '>') {
        if (angleDepth > 0) angleDepth--;
      } else if (ch === '(') parenDepth2++;
      else if (ch === ')') parenDepth2--;
      else if (ch === '[') bracketDepth++;
      else if (ch === ']') bracketDepth--;
      else if (ch === '{') {
        if (angleDepth === 0 && parenDepth2 === 0 && bracketDepth === 0 && typeBraceDepth === 0) {
          bodyStart = k;
          break;
        }
        typeBraceDepth++;
      } else if (ch === '}') {
        typeBraceDepth--;
      }
    }
    if (bodyStart === -1) continue;

    // Find the matching close brace for the body.
    let braceDepth = 0;
    let j = bodyStart;
    for (; j < source.length; j++) {
      if (source[j] === '{') braceDepth++;
      else if (source[j] === '}') {
        braceDepth--;
        if (braceDepth === 0) break;
      }
    }
    const bodyText = source.slice(bodyStart, j + 1);

    results.push({ name, paramText, bodyText });
  }

  return results;
}


/** Top-level parameter names of a function's parameter list (`a: T, b?: { x: U } = {}` → a, b). */
function parameterNames(paramText: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of paramText + ',') {
    if ('({[<'.includes(ch)) depth++;
    else if (')}]>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      const m = current.trim().match(/^(\w+)/);
      if (m) names.push(m[1]);
      current = '';
    } else {
      current += ch;
    }
  }
  return names;
}

/** The argument text of every `.values(...)` / `.set(...)` call in a function body. */
function writePayloads(bodyText: string): string[] {
  const payloads: string[] = [];
  let match: RegExpExecArray | null;
  DB_WRITE_CALL_PATTERN.lastIndex = 0;
  while ((match = DB_WRITE_CALL_PATTERN.exec(bodyText)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < bodyText.length; i++) {
      if (bodyText[i] === '(') depth++;
      else if (bodyText[i] === ')' && --depth === 0) break;
    }
    payloads.push(bodyText.slice(open + 1, i));
  }
  return payloads;
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

    it(`${file}: every exported action is guarded or explicitly public`, () => {
      const unguarded = fns
        .filter((fn) => !GUARD_PATTERN.test(fn.bodyText) && !allowlist.includes(fn.name))
        .map((fn) => fn.name);

      expect(
        unguarded,
        `${file} has exported action(s) with no session guard and no PUBLIC_ACTIONS entry: ${unguarded.join(', ')}`
      ).toEqual([]);
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
