import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Guard-coverage test.
//
// Every exported function in a `'use server'` file is a public HTTP endpoint —
// callable with arbitrary arguments by anyone who can reach the app, logged in
// or not. This test statically scans every file in src/server/actions/ and
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

const GUARD_PATTERN = /\b(requireSession|requireAdmin|requireApprover|getTenantForBilling)\s*\(/;
const IDENTITY_PARAM_PATTERN = /\b(adminUserId|reviewedBy|createdByUserId|assignedBy)\s*(\?)?\s*:/;

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

describe('Server action guard coverage', () => {
  const files = fs.readdirSync(ACTIONS_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  expect(files.length).toBeGreaterThan(0);

  for (const file of files) {
    const source = fs.readFileSync(path.join(ACTIONS_DIR, file), 'utf-8');
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
  }

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
});
