import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * feature-plan-terms-compliance-fixes.md §5.1: the write gate is a compile-time rule only if no code reaches for a
 * write-capable client outside the gate. `getDbForUrl` returns an unrestricted client (never in server actions);
 * `getDbForAuth` is write-capable in read_only/billing_only modes, so it is limited to the credential modules.
 */

const SRC = path.resolve(__dirname, '../..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : files(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/');
const all = files(SRC);

const GET_DB_FOR_AUTH_ALLOWED = new Set([
  'db/index.ts',
  'auth.ts',
  'lib/session.ts',
  'server/internal/login-attempts.ts',
  'server/actions/login-attempts.ts',
  'server/actions/password.ts',
  'server/actions/password-reset.ts',
  'server/actions/mfa.ts',
  'server/actions/notifications.ts',
]);

/**
 * Files allowed getDbForAuth in ONE named function only (feature-plan-launch-blockers.md P4: internal writers take
 * their client from the caller, so the action now obtains it). unlockUserAccount writes login-attempt bookkeeping —
 * the same credential client it always used, so an admin can unlock a user in any non-closed mode.
 */
const GET_DB_FOR_AUTH_SINGLE_FUNCTION: Record<string, string> = {
  'server/actions/users.ts': 'unlockUserAccount',
};

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  if (start === -1) return '';
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return '';
}

describe('write-gate boundaries (§5.1)', () => {
  it('server actions never use getDbForUrl (an unrestricted client)', () => {
    const offenders = all.filter((f) => rel(f).startsWith('server/actions/') && /\bgetDbForUrl\s*\(/.test(readFileSync(f, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('getDbForAuth is used only by the credential / security modules', () => {
    const offenders = all.filter((f) => {
      const src = readFileSync(f, 'utf8');
      if (!/\bgetDbForAuth\s*\(/.test(src) || GET_DB_FOR_AUTH_ALLOWED.has(rel(f))) return false;
      const only = GET_DB_FOR_AUTH_SINGLE_FUNCTION[rel(f)];
      if (!only) return true;
      // Allowed only inside that one function: remove its body and nothing may remain.
      return /\bgetDbForAuth\s*\(/.test(src.replace(functionBody(src, only), ''));
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it('readSql runs inside a READ ONLY transaction', () => {
    const src = readFileSync(path.join(SRC, 'db/index.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function readSql'));
    expect(body.slice(0, 600)).toMatch(/SET TRANSACTION READ ONLY/);
  });
});
