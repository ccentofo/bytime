/**
 * `classifyEndpoint` (feature-plan-disaster-restore.md §6.4.1; approved detail D3). What a tenant's stored URL answers,
 * and whether a live organisation project still serves its endpoint.
 *
 * Neon's proxy answers an unknown or deleted endpoint with `28P01` (wildcard DNS; anti-enumeration, §4.1.7), so an
 * authentication error alone proves nothing. Connection results are classified by SQLSTATE, never by message wording
 * (postgres.js exposes no auth-stage signal; the proxy's wording isn't documented):
 *   - `3D000` → database-missing (checked first; on the gone path it is a post-authentication answer);
 *   - login succeeds, or a post-authentication class (`53xxx`, `57Pxx`, `42501`) → answers;
 *   - any `28xxx` → auth;
 *   - any other SQLSTATE → a proxy error;
 *   - a socket code or `CONNECT_TIMEOUT` → socket/timeout;
 *   - anything else → unknown, which falls to the refusing side (unproven / proof-failed).
 */
import postgres from 'postgres';
import { clientUrl } from './pg-url';
import { connectUrl, type HostMap } from './host-map';
import { directHost, type NeonApi } from './neon-api';

export type ConnectClass = 'ok' | 'database-missing' | 'post-auth' | 'auth' | 'proxy' | 'socket' | 'unknown';

export interface ConnectResult {
  cls: ConnectClass;
  /** The SQLSTATE or socket code, for the record (never a message). */
  code: string | null;
}

const SOCKET_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED',
]);

/** Classify a connection error (D3). Pure. */
export function classifyConnectError(err: unknown): ConnectResult {
  const e = (err ?? {}) as { name?: unknown; code?: unknown; errno?: unknown; cause?: { code?: unknown } };
  const code = typeof e.code === 'string' ? e.code : typeof e.cause?.code === 'string' ? e.cause.code : null;
  if (e.name === 'PostgresError' && code && /^[0-9A-Z]{5}$/.test(code)) {
    if (code === '3D000') return { cls: 'database-missing', code };
    if (code.startsWith('53') || code.startsWith('57P') || code === '42501') return { cls: 'post-auth', code };
    if (code.startsWith('28')) return { cls: 'auth', code };
    return { cls: 'proxy', code };
  }
  if (code && SOCKET_CODES.has(code)) return { cls: 'socket', code };
  return { cls: 'unknown', code: code && /^[A-Z_0-9]{2,40}$/.test(code) ? code : null };
}

export type Connector = (url: string) => Promise<ConnectResult>;

/**
 * Connect with the stored credentials and run `SELECT 1` (max 1 connection, 15 s connect timeout). A hard deadline on
 * top: postgres.js reconnects in a tight loop, ignoring `connect_timeout`, when a server closes the socket during startup
 * (measured: thousands of attempts in seconds), so the probe is abandoned at the deadline and counted as socket/timeout.
 */
export function pgConnector(o: { hostMap?: HostMap; connectTimeoutSeconds?: number } = {}): Connector {
  return async (url) => {
    const r = await pgQuery(url, async (sql) => { await sql`SELECT 1`; }, o);
    if (r.ok) return { cls: 'ok', code: null };
    return r.timedOut ? { cls: 'socket', code: 'CONNECT_TIMEOUT' } : classifyConnectError(r.error);
  };
}

/**
 * One query on a one-connection client with a HARD deadline (connect timeout + 2 s): the client is abandoned at the
 * deadline, so the postgres.js reconnect loop can't hang the caller. Used by pgConnector and the schema note (FR11).
 */
export async function pgQuery<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>, o: { hostMap?: HostMap; connectTimeoutSeconds?: number } = {}):
  Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean; error: unknown }> {
  const seconds = o.connectTimeoutSeconds ?? 15;
  const sql = postgres(clientUrl(connectUrl(url, o.hostMap)), { max: 1, connect_timeout: seconds, idle_timeout: 1, onnotice: () => {}, prepare: false });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<{ ok: false; timedOut: true; error: null }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true, error: null }), seconds * 1000 + 2_000);
  });
  try {
    return await Promise.race([
      fn(sql).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, timedOut: false, error })),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    await sql.end({ timeout: 0 }).catch(() => {});
  }
}

/** The projects that may legitimately hold a tenant's endpoint (§5 invariant 2(d)): a parameter so 3c-2 can pass its own. */
export interface CandidateRule {
  exactNames: string[];
  prefixes: string[];
}

/** `cadenzpoint-<slug>` (provisioning) and `cadenzpoint-r-<tenant id first 8>-` (this button's rebuilds). */
export function tenantCandidateRule(slug: string, tenantId: string): CandidateRule {
  return { exactNames: [`cadenzpoint-${slug}`], prefixes: [`cadenzpoint-r-${tenantId.slice(0, 8)}-`] };
}

export type Served = 'yes' | 'no' | 'unproven';

/**
 * Does any live candidate project list an endpoint on the URL's direct host? Any endpoints call that isn't 200, or a
 * list with `unavailable_project_ids`, → unproven (never "not served").
 */
export async function candidateServes(neon: NeonApi, url: string, rule: CandidateRule): Promise<Served> {
  const host = directHost(new URL(url).hostname);
  try {
    const seen = new Map<string, string>();
    for (const term of [...rule.exactNames, ...rule.prefixes]) {
      const l = await neon.listProjects({ search: term });
      if (l.unavailable.length > 0) return 'unproven';
      for (const p of l.projects) {
        if (rule.exactNames.includes(p.name) || rule.prefixes.some((pre) => p.name.startsWith(pre))) seen.set(p.id, p.name);
      }
    }
    for (const id of seen.keys()) {
      const eps = await neon.listEndpoints(id);
      if (eps.some((e) => directHost(e.host) === host)) return 'yes';
    }
    return 'no';
  } catch {
    return 'unproven';
  }
}

export type GoneEndpointClass = 'answers' | 'served' | 'doesnt-answer' | 'unproven';

/**
 * Proof (d), for a project that 404s: the §6.4.1 table. Login success or any post-authentication answer (including
 * 3D000) → answers; an auth, proxy or socket failure → doesn't answer only if no live candidate serves the endpoint.
 */
export async function classifyGoneEndpoint(o: { url: string; connect: Connector; neon: NeonApi; rule: CandidateRule }): Promise<{ cls: GoneEndpointClass; code: string | null }> {
  const r = await o.connect(o.url);
  if (r.cls === 'ok' || r.cls === 'post-auth' || r.cls === 'database-missing') return { cls: 'answers', code: r.code };
  if (r.cls === 'unknown') return { cls: 'unproven', code: r.code };
  const served = await candidateServes(o.neon, o.url, o.rule);
  return { cls: served === 'yes' ? 'served' : served === 'no' ? 'doesnt-answer' : 'unproven', code: r.code };
}

export type OverrideClass =
  | 'database-missing' // 3D000 inside a live project → refused:database-missing
  | 'answers' // login succeeds or a post-auth answer → refused:reachable
  | 'credentials' // the URL's endpoint is listed and answers 28xxx → refused:credentials
  | 'unreachable' // listed + proxy/socket error, or the endpoint is gone from the live project (endpoint-gone)
  | 'served-elsewhere' // not listed, but a live candidate serves it (a stale project id) → refused:reachable
  | 'proof-failed'; // a lookup failed, a 404, or an unknown error → refused:proof-failed

/** The override path (§6.4.1): the project answers 200, so the table above isn't used. */
export async function classifyOverride(o: { url: string; projectId: string; connect: Connector; neon: NeonApi; rule: CandidateRule }): Promise<{ cls: OverrideClass; reason?: 'endpoint-listed' | 'endpoint-gone'; code: string | null }> {
  const r = await o.connect(o.url);
  if (r.cls === 'database-missing') return { cls: 'database-missing', code: r.code };
  if (r.cls === 'ok' || r.cls === 'post-auth') return { cls: 'answers', code: r.code };
  if (r.cls === 'unknown') return { cls: 'proof-failed', code: r.code };
  let listed: boolean;
  try {
    const host = directHost(new URL(o.url).hostname);
    listed = (await o.neon.listEndpoints(o.projectId)).some((e) => directHost(e.host) === host);
  } catch {
    return { cls: 'proof-failed', code: r.code };
  }
  if (listed) {
    if (r.cls === 'auth') return { cls: 'credentials', code: r.code };
    return { cls: 'unreachable', reason: 'endpoint-listed', code: r.code };
  }
  const served = await candidateServes(o.neon, o.url, o.rule);
  if (served === 'yes') return { cls: 'served-elsewhere', code: r.code };
  if (served === 'unproven') return { cls: 'proof-failed', code: r.code };
  return { cls: 'unreachable', reason: 'endpoint-gone', code: r.code };
}
