/**
 * Environment checks (feature-plan-database-backups.md §6.4 "Environment", §6.7, U5). Each required value is fatal when
 * missing OR empty. No dotenv is loaded by the bundle; `scripts/backup/local.ts` loads it for the local dry run only.
 */
import { execFile } from 'node:child_process';

export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }
}

export type Env = Record<string, string | undefined>;

export function requireEnv(env: Env, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === '') throw new FatalError(`${name} is not set`);
  return v;
}

/** `ENCRYPTION_KEY` must be 64 hex characters: elsewhere a non-hex key is silently derived (src/lib/encryption.ts). */
export function requireHexKey(env: Env, name = 'ENCRYPTION_KEY'): string {
  const v = requireEnv(env, name);
  if (!/^[0-9a-f]{64}$/i.test(v)) throw new FatalError(`${name} must be 64 hex characters`);
  return v;
}

export function intEnv(env: Env, name: string, fallback: number, min = 1): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new FatalError(`${name} must be an integer ≥ ${min}`);
  return n;
}

/** The image's PGDG install location, used by `--self-check` when the *_BIN variables are unset. */
export const DEFAULT_PG_BIN_DIR = '/usr/lib/postgresql/16/bin';

export type PgTool = 'pg_dump' | 'pg_restore';

export function defaultToolPath(env: Env, tool: PgTool): string {
  const fromEnv = tool === 'pg_dump' ? env.BACKUP_PG_DUMP_BIN : env.BACKUP_PG_RESTORE_BIN;
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : `${DEFAULT_PG_BIN_DIR}/${tool}`;
}

export type VersionRunner = (bin: string) => Promise<string>;

export const runVersion: VersionRunner = (bin) => new Promise((resolve, reject) => {
  execFile(bin, ['--version'], { env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv, timeout: 15_000 }, (err: Error | null, stdout: string | Buffer) => {
    if (err) reject(err);
    else resolve(String(stdout).trim());
  });
});

/** `<tool> --version` must start with `<tool> (PostgreSQL) 16.` Returns the version line. */
export async function checkToolVersion(bin: string, tool: PgTool, run: VersionRunner = runVersion): Promise<string> {
  let out: string;
  try {
    out = await run(bin);
  } catch {
    throw new FatalError(`${tool} could not be run (check BACKUP_PG_${tool === 'pg_dump' ? 'DUMP' : 'RESTORE'}_BIN)`);
  }
  if (!out.startsWith(`${tool} (PostgreSQL) 16.`)) throw new FatalError(`${tool} must be version 16 (got "${out.slice(0, 60)}")`);
  return out;
}

/** True inside an ECS task (the agent sets this for every container). */
export function isInEcs(env: Env): boolean {
  return Boolean(env.ECS_CONTAINER_METADATA_URI_V4);
}

/** A comma-separated list (empty entries dropped). */
export function listEnv(env: Env, name: string): string[] {
  return (env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
