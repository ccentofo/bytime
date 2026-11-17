/**
 * The disaster task's Neon API v2 client (feature-plan-disaster-restore.md §4.1, §6.4 step 5; impact analysis §3.1).
 * Key-required: there is no local fallback (src/lib/tenant/neon.ts's createNeonDatabase falls back to a local database
 * without a key, so the task never uses it). Every call passes the organisation (`org_id`): a personal key (Q1's Viewer
 * member) sees only its own projects without it.
 *
 * - POST /projects: `project.org_id` in the body (SPEC: the body's only top-level key is `project`).
 * - GET /projects: `org_id` query parameter; cursor-paginated (limit ≤ 400); `unavailable_project_ids` = an incomplete list.
 * - Operations: `finished`/`skipped` succeed; `failed`, `error` and `cancelled` are terminal (docs/manage/operations;
 *   approved detail D4: `failed` is terminal even with a `retry_at`, which only says when it was last retried).
 * - 423 Locked and 429 are retried with backoff ("Any request that returns a 423 Locked response is safe to retry").
 * - DELETE answers 200 with the project body; a 404 on delete = already gone. Deletion is always verified by GET → 404.
 *
 * Errors carry ONLY the HTTP status and Neon's `code`, never a response body or message (which can name projects): the
 * disaster log group keeps ids only (invariant 6).
 */

export const NEON_API_BASE = 'https://console.neon.tech/api/v2';

export class NeonApiError extends Error {
  constructor(readonly op: string, readonly status: number, readonly code: string | null) {
    super(`neon ${op} failed: HTTP ${status}${code ? ` ${code}` : ''}`);
    this.name = 'NeonApiError';
  }
  /** A Neon 5xx, 423 or 429 (after backoff), or a network error: an infrastructure failure (§6.4 step 4). */
  get infrastructure(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 423 || this.status === 429;
  }
}

export interface NeonProject {
  id: string;
  name: string;
  deletedAt?: string | null;
  recoverableUntil?: string | null;
}

export interface NeonEndpoint {
  id: string;
  host: string;
}

export interface CreatedProject {
  projectId: string;
  /** The direct host's connection string (restores use it). */
  connectionUri: string;
  /** The same string on the pooled host (the app uses it). */
  pooledUri: string;
}

export interface NeonApiOptions {
  apiKey: string;
  orgId: string;
  /** Tests only: the fake Neon server. */
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Backoff tries for 423/429 (default 6: 2, 4, 8, 16, 30, 30 s). */
  retries?: number;
  backoffMs?: (attempt: number) => number;
  operationPollMs?: number;
  operationTimeoutMs?: number;
  requestTimeoutMs?: number;
  pageLimit?: number;
}

export interface NeonApi {
  getProject(id: string): Promise<{ found: true; project: NeonProject } | { found: false }>;
  /** Every page; `unavailable` non-empty = the list is incomplete (unproven). */
  listProjects(o?: { search?: string; recoverable?: boolean }): Promise<{ projects: NeonProject[]; unavailable: string[] }>;
  listEndpoints(projectId: string): Promise<NeonEndpoint[]>;
  /** `signal`: the operation wait stops at once on a stop or deadline (the error carries the created id, for cleanup). */
  createProject(o: { name: string; databaseName: string; historyRetentionSeconds: number; regionId: string }, signal?: AbortSignal): Promise<CreatedProject>;
  /** Returns once Neon has accepted the delete (200), or the project was already gone (404). */
  deleteProject(id: string): Promise<void>;
  /** Polls GET until 404 (true) or the tries run out (false). */
  verifyGone(id: string, tries?: number, delayMs?: number): Promise<boolean>;
  /** Projects named exactly `name` (search, then an exact filter). */
  findByName(name: string): Promise<{ projects: NeonProject[]; unavailable: string[] }>;
}

interface Operation { id: string; status: string }

const TERMINAL_OK = new Set(['finished', 'skipped']);
const TERMINAL_FAIL = new Set(['failed', 'error', 'cancelled']);

/** The endpoint host without the PgBouncer `-pooler` suffix on its first label (as src/lib/tenant/neon.ts directNeonHost). */
export function directHost(host: string): string {
  const [first, ...rest] = host.toLowerCase().split('.');
  return [first.replace(/-pooler$/, ''), ...rest].join('.');
}

function withHost(uri: string, host: string): string {
  const u = new URL(uri);
  u.hostname = host;
  return u.toString();
}

export function neonApi(o: NeonApiOptions): NeonApi {
  const base = (o.baseUrl ?? NEON_API_BASE).replace(/\/$/, '');
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = o.retries ?? 6;
  const backoff = o.backoffMs ?? ((a: number) => Math.min(30_000, 2_000 * 2 ** a));
  const pollMs = o.operationPollMs ?? 5_000;
  const opTimeout = o.operationTimeoutMs ?? 10 * 60_000;
  const reqTimeout = o.requestTimeoutMs ?? 30_000;
  const limit = o.pageLimit ?? 400;
  const headers = { Authorization: `Bearer ${o.apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' };

  /** One request with 423/429 backoff. Returns the status and the parsed JSON (never surfaced in errors). */
  async function call(op: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(reqTimeout),
        });
      } catch {
        throw new NeonApiError(op, 0, 'network');
      }
      let json: Record<string, unknown> | null = null;
      try { json = (await res.json()) as Record<string, unknown>; } catch { json = null; }
      if ((res.status === 423 || res.status === 429) && attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      return { status: res.status, json };
    }
  }
  const codeOf = (json: Record<string, unknown> | null) => (json && typeof json.code === 'string' && json.code ? json.code.slice(0, 60) : null);
  const fail = (op: string, r: { status: number; json: Record<string, unknown> | null }): never => { throw new NeonApiError(op, r.status, codeOf(r.json)); };

  const toProject = (p: Record<string, unknown>): NeonProject => ({
    id: String(p.id), name: String(p.name ?? ''),
    deletedAt: typeof p.deleted_at === 'string' ? p.deleted_at : null,
    recoverableUntil: typeof p.recoverable_until === 'string' ? p.recoverable_until : null,
  });

  async function listProjects(q: { search?: string; recoverable?: boolean } = {}) {
    const projects: NeonProject[] = [];
    const unavailable = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const params = new URLSearchParams({ org_id: o.orgId, limit: String(limit) });
      if (q.search) params.set('search', q.search);
      if (q.recoverable) params.set('recoverable', 'true');
      if (cursor) params.set('cursor', cursor);
      const r = await call('list-projects', 'GET', `/projects?${params}`);
      if (r.status !== 200 || !r.json) fail('list-projects', r);
      const items = Array.isArray(r.json!.projects) ? (r.json!.projects as Record<string, unknown>[]) : [];
      projects.push(...items.map(toProject));
      for (const id of (Array.isArray(r.json!.unavailable_project_ids) ? r.json!.unavailable_project_ids : []) as unknown[]) unavailable.add(String(id));
      const next = (r.json!.pagination as { cursor?: string } | undefined)?.cursor;
      // Stop only on an empty page or no new cursor (a short page isn't proof of the end: the docs don't promise it).
      if (items.length === 0 || !next || next === cursor) break;
      cursor = next;
    }
    return { projects, unavailable: [...unavailable] };
  }

  /** A sleep that ends early when `signal` aborts. */
  const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
    if (!signal) { void sleep(ms).then(resolve); return; }
    if (signal.aborted) { resolve(); return; }
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    void sleep(ms).then(() => { signal.removeEventListener('abort', onAbort); resolve(); });
  });

  async function waitOperations(projectId: string, ops: Operation[], signal?: AbortSignal) {
    const deadline = Date.now() + opTimeout;
    for (const op of ops) {
      if (TERMINAL_OK.has(op.status)) continue;
      for (;;) {
        // Fix round 1, FR10: a stop or deadline returns at once, so cleanup runs inside ECS's 120 s stop window.
        if (signal?.aborted) throw new NeonApiError('operation', 0, 'stopped');
        const r = await call('operation', 'GET', `/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(op.id)}`);
        if (r.status !== 200 || !r.json) fail('operation', r);
        const status = String((r.json!.operation as { status?: string } | undefined)?.status ?? '');
        if (TERMINAL_OK.has(status)) break;
        if (TERMINAL_FAIL.has(status)) throw new NeonApiError('operation', 500, `operation-${status}`);
        if (Date.now() > deadline) throw new NeonApiError('operation', 0, 'operation-timeout');
        await pause(pollMs, signal);
      }
    }
  }

  return {
    async getProject(id) {
      const r = await call('get-project', 'GET', `/projects/${encodeURIComponent(id)}`);
      if (r.status === 404) return { found: false };
      if (r.status !== 200 || !r.json?.project) fail('get-project', r);
      return { found: true, project: toProject(r.json!.project as Record<string, unknown>) };
    },
    listProjects,
    async listEndpoints(projectId) {
      const r = await call('list-endpoints', 'GET', `/projects/${encodeURIComponent(projectId)}/endpoints`);
      if (r.status !== 200 || !r.json || !Array.isArray(r.json.endpoints)) fail('list-endpoints', r);
      return (r.json!.endpoints as Array<Record<string, unknown>>).map((e) => ({ id: String(e.id), host: String(e.host ?? '') }));
    },
    async createProject(c, signal) {
      const r = await call('create-project', 'POST', '/projects', {
        project: {
          name: c.name, org_id: o.orgId, pg_version: 16, region_id: c.regionId,
          branch: { database_name: c.databaseName }, history_retention_seconds: c.historyRetentionSeconds,
        },
      });
      if (r.status !== 201 && r.status !== 200) fail('create-project', r);
      const projectId = (r.json?.project as { id?: string } | undefined)?.id;
      const uri = (r.json?.connection_uris as Array<{ connection_uri?: string; connection_parameters?: { pooler_host?: string } }> | undefined)?.[0];
      if (!projectId) throw new NeonApiError('create-project', r.status, 'no-project-id');
      if (!uri?.connection_uri || !uri.connection_parameters?.pooler_host) {
        // The project exists: report its id so the caller tracks and cleans it up.
        throw Object.assign(new NeonApiError('create-project', r.status, 'no-connection-uri'), { projectId });
      }
      try {
        await waitOperations(projectId, (r.json?.operations as Operation[] | undefined) ?? [], signal);
      } catch (e) {
        throw Object.assign(e as Error, { projectId });
      }
      return { projectId, connectionUri: uri.connection_uri, pooledUri: withHost(uri.connection_uri, uri.connection_parameters.pooler_host) };
    },
    async deleteProject(id) {
      const r = await call('delete-project', 'DELETE', `/projects/${encodeURIComponent(id)}`);
      if (r.status === 200 || r.status === 404) return;
      fail('delete-project', r);
    },
    async verifyGone(id, tries = 30, delayMs = 1_000) {
      for (let i = 0; i < tries; i++) {
        const r = await call('get-project', 'GET', `/projects/${encodeURIComponent(id)}`);
        if (r.status === 404) return true;
        if (i < tries - 1) await sleep(delayMs);
      }
      return false;
    },
    async findByName(name) {
      const l = await listProjects({ search: name });
      return { projects: l.projects.filter((p) => p.name === name), unavailable: l.unavailable };
    },
  };
}

/** The id a failed createProject may carry (the project exists even though the call failed). */
export function createdIdOf(err: unknown): string | null {
  const id = (err as { projectId?: unknown })?.projectId;
  return typeof id === 'string' && id ? id : null;
}
