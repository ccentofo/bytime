import { describe, it, expect } from 'vitest';
import postgres from 'postgres';
import { postgresJsUrl } from '@/lib/db/pg-url';

// url-fix (2026-11-18): postgres.js sends unknown URL query keys to the server as startup settings, and Postgres
// rejects Neon's `channel_binding` (42704). postgresJsUrl reduces the query to `sslmode`, keeping everything else exact.

/** What postgres.js itself parses from a URL. Building a client doesn't connect (connections are lazy). */
function parsed(url: string) {
  const o = postgres(url).options as unknown as {
    user: string; pass: string; host: string[]; port: number[]; database: string; ssl: unknown; connection: Record<string, string>;
  };
  return { user: o.user, pass: o.pass, host: o.host, port: o.port, database: o.database, ssl: o.ssl, connection: o.connection };
}

describe('postgresJsUrl', () => {
  it("reduces Neon's connection string to sslmode", () => {
    const neon = 'postgresql://neondb_owner:npg_AbC123xyz@ep-cool-cat-a1b2c3d4-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
    expect(postgresJsUrl(neon)).toBe('postgresql://neondb_owner:npg_AbC123xyz@ep-cool-cat-a1b2c3d4-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require');
  });

  it('strips channel_binding, keepalives*, sslrootcert, options and unknown keys, keeping sslmode', () => {
    const url = 'postgres://u:p@db.example.com:6543/app?channel_binding=require&keepalives=1&keepalives_idle=30&sslmode=verify-full&sslrootcert=system&options=-c%20x%3Dy&whatever=1';
    const out = postgresJsUrl(url);
    const q = new URL(out).searchParams;
    expect([...q.keys()]).toEqual(['sslmode']);
    expect(q.get('sslmode')).toBe('verify-full');
    expect(out).toBe('postgres://u:p@db.example.com:6543/app?sslmode=verify-full');
  });

  it('drops the query entirely when no sslmode is present', () => {
    expect(postgresJsUrl('postgresql://u:p@localhost:5432/bytime_test?channel_binding=require&keepalives=1'))
      .toBe('postgresql://u:p@localhost:5432/bytime_test');
  });

  it('removes every copy of a repeated key', () => {
    expect(postgresJsUrl('postgresql://u:p@h/d?channel_binding=require&sslmode=require&channel_binding=prefer'))
      .toBe('postgresql://u:p@h/d?sslmode=require');
  });

  it('preserves a percent-encoded user and password, host, port and database exactly', () => {
    const url = 'postgresql://us%40er:p%40%2F%3A%25%23%3Fw%20@ep-x-pooler.us-east-2.aws.neon.tech:5433/tenant_acme?sslmode=require&channel_binding=require&keepalives=1';
    const out = postgresJsUrl(url);
    expect(out).toBe('postgresql://us%40er:p%40%2F%3A%25%23%3Fw%20@ep-x-pooler.us-east-2.aws.neon.tech:5433/tenant_acme?sslmode=require');
    // And postgres.js decodes the same credentials from it, with no startup setting beyond its own application_name.
    expect(parsed(out)).toEqual({
      user: 'us@er',
      pass: 'p@/:%#?w ',
      host: ['ep-x-pooler.us-east-2.aws.neon.tech'],
      port: [5433],
      database: 'tenant_acme',
      ssl: 'require',
      connection: { application_name: 'postgres.js' },
    });
  });

  it('without it, postgres.js would forward channel_binding and keepalives to the server (the defect)', () => {
    const raw = 'postgresql://u:p@h/d?sslmode=require&channel_binding=require&keepalives=1';
    expect(parsed(raw).connection).toEqual({ application_name: 'postgres.js', channel_binding: 'require', keepalives: '1' });
    expect(parsed(postgresJsUrl(raw)).connection).toEqual({ application_name: 'postgres.js' });
  });

  it('returns an already-clean URL as the very same string', () => {
    for (const url of [
      'postgresql://bytime:bytime_dev@localhost:5432/bytime_test',
      'postgresql://u:p%40ss@ep-x.us-east-1.aws.neon.tech/cp_acme?sslmode=require',
      'postgres://u@h',
      'postgresql://u:p@h/d?',
    ]) expect(postgresJsUrl(url)).toBe(url);
  });

  it('passes an empty or unparseable URL through unchanged, so the callers\' existing error paths stay the same', () => {
    expect(postgresJsUrl('')).toBe('');
    expect(postgresJsUrl('not a url?channel_binding=require')).toBe('not a url?channel_binding=require');
    // A multi-host URL isn't WHATWG-parseable (postgres.js splits the hosts itself): unchanged.
    expect(postgresJsUrl('postgres://u:p@h1:5432,h2:5432/d?channel_binding=require')).toBe('postgres://u:p@h1:5432,h2:5432/d?channel_binding=require');
  });
});
