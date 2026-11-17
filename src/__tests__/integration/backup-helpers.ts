/**
 * Scratch databases for the backup suites (impact analysis G2, approved): every backup, restore-test, lock and
 * migrate-all-handshake suite creates and drops its own `bkt_cp_*` (control plane) and `bkt_t_*` (tenant) databases on
 * the local/CI server, and never reads the developer's control plane. Only S9/U9/U10 use the app's control plane.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomToken } from '../../../scripts/backup/lib/keys';
import { withDatabase } from '../../../scripts/backup/lib/pg-url';

export const SERVER_URL = process.env.CONTROL_PLANE_DATABASE_URL;

export function adminUrl(): string {
  if (!SERVER_URL) throw new Error('CONTROL_PLANE_DATABASE_URL is not set');
  return withDatabase(SERVER_URL, 'postgres');
}

const SCRATCH_RE = /^bkt_(cp|t)_[a-z0-9]{8}$/;

export async function createScratchDb(kind: 'cp' | 't', opts: { migrateControlPlane?: boolean; tenantSchema?: boolean } = {}): Promise<{ name: string; url: string }> {
  const name = `bkt_${kind}_${randomToken(8)}`;
  const admin = postgres(adminUrl(), { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = withDatabase(SERVER_URL!, name);
  if (opts.migrateControlPlane) {
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await migrate(drizzle(sql), { migrationsFolder: './drizzle/control-plane' });
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  if (opts.tenantSchema) {
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(`CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL);
        CREATE TABLE timesheet_entries (id serial PRIMARY KEY, user_id int REFERENCES users(id), hours numeric(5,2) NOT NULL, note text);
        CREATE SCHEMA audit; CREATE TABLE audit.events (id bigserial PRIMARY KEY, kind text);
        INSERT INTO users (email) SELECT 'user' || g || '@test.invalid' FROM generate_series(1, 25) g;
        INSERT INTO timesheet_entries (user_id, hours, note) SELECT 1 + (g % 25), 7.5, repeat('n', 200) FROM generate_series(1, 400) g;
        INSERT INTO audit.events (kind) SELECT 'k' FROM generate_series(1, 7);`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  return { name, url };
}

/** Drop a scratch database (only names this helper makes), terminating any leftover session first. */
export async function dropScratchDb(name: string): Promise<void> {
  if (!SCRATCH_RE.test(name)) throw new Error(`refusing to drop ${name}`);
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** Drop any rt_ databases left on the server by a failed test run (pattern-checked). */
export async function listRtDatabases(): Promise<string[]> {
  const admin = postgres(adminUrl(), { max: 1 });
  try {
    const rows = await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname ~ '^rt_[0-9]{14}_[a-z0-9]{8}$'`;
    return rows.map((r) => r.datname);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** Count unhandled rejections and uncaught exceptions during a test (S21: "no uncaught exception"). */
export function trackUncaught(): { count: () => number; stop: () => void } {
  let n = 0;
  const onErr = () => { n++; };
  process.on('unhandledRejection', onErr);
  process.on('uncaughtExceptionMonitor', onErr);
  return { count: () => n, stop: () => { process.off('unhandledRejection', onErr); process.off('uncaughtExceptionMonitor', onErr); } };
}

/** The backend pid holding an advisory lock key in a database. */
export async function lockHolderPid(url: string, key: number): Promise<number | null> {
  const sql = postgres(url, { max: 1 });
  try {
    const rows = await sql<{ pid: number }[]>`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${key} AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    return rows[0]?.pid ?? null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function terminate(url: string, pid: number): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`SELECT pg_terminate_backend(${pid})`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs = 10_000, stepMs = 50): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(stepMs);
  }
  throw new Error('waitUntil timed out');
}
