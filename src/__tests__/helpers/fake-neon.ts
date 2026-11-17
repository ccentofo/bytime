/**
 * A fake Neon API v2 (feature-plan-disaster-restore.md §11), a local `node:http` server on 127.0.0.1. Never the real
 * Neon. It models what the disaster task relies on (impact analysis §3.1):
 *  - projects belong to one organisation; a list WITHOUT the right `org_id` comes back empty (the personal-key case);
 *  - cursor pagination (a small page size), `search` (substring of name or id), `recoverable=true`, and
 *    `unavailable_project_ids` on demand;
 *  - POST /projects with `project.org_id`; it can create a real local database `bkt_dr_*` and return Neon-shaped hosts
 *    (`ep-….us-east-1.aws.neon.tech`), with the test-only host map pointing them at the local server;
 *  - DELETE → 200 and the project moves to the recoverable list; its endpoint hosts then map to the Neon-proxy stand-in
 *    (28P01), as a deleted endpoint answers;
 *  - scripted statuses per route (404, 403, 5xx, 423, 429), a dropped socket, a lost create response (created, then 500),
 *    and operation status sequences. Error bodies deliberately name the project, so tests prove they never leak.
 */
import http from 'node:http';
import postgres from 'postgres';
import { randomToken } from '../../../scripts/backup/lib/keys';
import type { HostMap } from '../../../scripts/backup/lib/host-map';

export interface FakeProject {
  id: string;
  name: string;
  endpoints: Array<{ id: string; host: string }>;
  deleted: boolean;
  deletedAt: string | null;
  /** The local database created for it (POST with createDatabases), dropped on close. */
  localDb: string | null;
  connectionUri: string | null;
  pooledUri: string | null;
}

export type Scripted = number | 'drop' | 'lost';

export interface FakeNeon {
  url: string;
  orgId: string;
  apiKey: string;
  projects: Map<string, FakeProject>;
  hostMap: HostMap;
  requests: Array<{ method: string; path: string; body?: unknown }>;
  /** Queue statuses for a route key: 'GET /projects', 'GET /projects/:id', 'GET /projects/:id/endpoints', 'POST /projects',
   * 'DELETE /projects/:id', 'GET /projects/:id/operations/:op'. Optional id narrows to one project. */
  script(route: string, statuses: Scripted[], id?: string): void;
  /** Operation statuses returned in order for the next created project (default: finished). */
  operationStatuses: string[];
  /** Ids listed as unavailable on the next `calls` list calls, after skipping the next `skip` list calls (default none). */
  unavailable: { ids: string[]; calls: number; skip?: number };
  pageSize: number;
  addProject(o: { id?: string; name: string; host?: string; deleted?: boolean; mapTo?: { host: string; port: number } }): FakeProject;
  /** Mark a project deleted (recoverable) without an API call; its hosts map to the proxy. */
  markDeleted(id: string): void;
  /** Remove a project entirely (past the recovery window). */
  purge(id: string): void;
  close(): Promise<void>;
}

export const fakeHost = (token = randomToken(10)) => `ep-${token}.us-east-1.aws.neon.tech`;
export const poolerOf = (host: string) => host.replace(/^([^.]+)/, '$1-pooler');

export async function startFakeNeon(o: {
  orgId?: string;
  apiKey?: string;
  /** postgres:// URL of the local server: credentials and host:port for created databases. */
  serverUrl?: string;
  createDatabases?: boolean;
  /** Where deleted or unknown endpoints map (the 28P01 stand-in). */
  proxy?: { host: string; port: number };
  pageSize?: number;
} = {}): Promise<FakeNeon> {
  const orgId = o.orgId ?? 'org-test-1';
  const apiKey = o.apiKey ?? 'test-neon-key';
  const projects = new Map<string, FakeProject>();
  const hostMap: HostMap = {};
  const requests: FakeNeon['requests'] = [];
  const queues = new Map<string, Scripted[]>();
  const server0 = o.serverUrl ? new URL(o.serverUrl) : null;
  const local = server0 ? { host: server0.hostname, port: Number(server0.port || 5432) } : null;

  const fake: FakeNeon = {
    url: '', orgId, apiKey, projects, hostMap, requests,
    operationStatuses: [],
    unavailable: { ids: [], calls: 0 },
    pageSize: o.pageSize ?? 3,
    script(route, statuses, id) { queues.set(id ? `${route}#${id}` : route, [...statuses]); },
    addProject(p) {
      const id = p.id ?? `prj-${randomToken(10)}`;
      const host = p.host ?? fakeHost();
      const proj: FakeProject = { id, name: p.name, endpoints: [{ id: host.split('.')[0], host }], deleted: Boolean(p.deleted), deletedAt: p.deleted ? new Date().toISOString() : null, localDb: null, connectionUri: null, pooledUri: null };
      projects.set(id, proj);
      const target = p.deleted ? o.proxy : p.mapTo ?? local ?? undefined;
      if (target) { hostMap[host] = target; hostMap[poolerOf(host)] = target; }
      return proj;
    },
    markDeleted(id) {
      const p = projects.get(id);
      if (!p) return;
      p.deleted = true;
      p.deletedAt = new Date().toISOString();
      for (const e of p.endpoints) if (o.proxy) { hostMap[e.host] = o.proxy; hostMap[poolerOf(e.host)] = o.proxy; }
    },
    purge(id) {
      const p = projects.get(id);
      if (!p) return;
      projects.delete(id);
      for (const e of p.endpoints) if (o.proxy) { hostMap[e.host] = o.proxy; hostMap[poolerOf(e.host)] = o.proxy; }
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      if (o.serverUrl) {
        const admin = postgres(withDb(o.serverUrl, 'postgres'), { max: 1, onnotice: () => {} });
        try {
          for (const p of projects.values()) if (p.localDb && /^bkt_dr_[a-z0-9]{8}$/.test(p.localDb)) await admin.unsafe(`DROP DATABASE IF EXISTS "${p.localDb}" WITH (FORCE)`);
        } finally {
          await admin.end({ timeout: 5 });
        }
      }
    },
  };

  const take = (route: string, id?: string): Scripted | undefined => {
    for (const key of id ? [`${route}#${id}`, route] : [route]) {
      const q = queues.get(key);
      if (q && q.length) return q.shift();
    }
    return undefined;
  };

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  // Error bodies name the project on purpose: the client must never surface a body.
  const err = (res: http.ServerResponse, status: number, name = 'secret-project-name') => send(res, status, { code: `CODE_${status}`, message: `project ${name} said no` });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const path = u.pathname.replace(/^\/api\/v2/, '');
    requests.push({ method: req.method ?? '', path: path + u.search, body });
    if (req.headers.authorization !== `Bearer ${apiKey}`) return err(res, 401);
    const m = /^\/projects(?:\/([^/]+))?(?:\/(endpoints|operations)(?:\/([^/]+))?)?$/.exec(path);
    if (!m) return err(res, 404);
    const [, id, sub, opId] = m;
    const route = `${req.method} /projects${id ? '/:id' : ''}${sub ? `/${sub}` : ''}${opId ? '/:op' : ''}`;
    const scripted = take(route, id);
    if (scripted === 'drop') { req.socket.destroy(); return; }
    if (typeof scripted === 'number' && scripted >= 300) return err(res, scripted, id ? projects.get(id)?.name : undefined);

    if (req.method === 'GET' && !id) {
      if (u.searchParams.get('org_id') !== orgId) return send(res, 200, { projects: [], pagination: {} }); // personal key without org_id
      const recoverable = u.searchParams.get('recoverable') === 'true';
      const search = u.searchParams.get('search');
      const limit = Math.min(Number(u.searchParams.get('limit') ?? 10), fake.pageSize);
      const cursor = u.searchParams.get('cursor');
      const all = [...projects.values()].filter((p) => p.deleted === recoverable && (!search || p.name.includes(search) || p.id.includes(search)))
        .sort((a, b) => a.id.localeCompare(b.id));
      const start = cursor ? all.findIndex((p) => p.id > cursor) : 0;
      const page = start < 0 ? [] : all.slice(start, start + limit);
      let unavailable: string[] = [];
      if (fake.unavailable.skip && fake.unavailable.skip > 0) fake.unavailable.skip--;
      else if (fake.unavailable.calls > 0) { fake.unavailable.calls--; unavailable = fake.unavailable.ids; }
      return send(res, 200, {
        projects: page.map((p) => ({ id: p.id, name: p.name, ...(p.deleted ? { deleted_at: p.deletedAt, recoverable_until: new Date(Date.parse(p.deletedAt!) + 7 * 86400_000).toISOString() } : {}) })),
        pagination: page.length ? { cursor: page[page.length - 1].id } : {},
        ...(unavailable.length ? { unavailable_project_ids: unavailable } : {}),
      });
    }
    if (req.method === 'POST' && !id) {
      const p = body?.project ?? {};
      if (p.org_id !== orgId) return err(res, 400);
      const token = randomToken(8);
      const host = fakeHost();
      const proj: FakeProject = { id: `prj-${randomToken(10)}`, name: String(p.name ?? ''), endpoints: [{ id: host.split('.')[0], host }], deleted: false, deletedAt: null, localDb: null, connectionUri: null, pooledUri: null };
      if (o.createDatabases && o.serverUrl) {
        proj.localDb = `bkt_dr_${token}`;
        const admin = postgres(withDb(o.serverUrl, 'postgres'), { max: 1, onnotice: () => {} });
        try { await admin.unsafe(`CREATE DATABASE "${proj.localDb}"`); } finally { await admin.end({ timeout: 5 }); }
        const s = new URL(o.serverUrl);
        proj.connectionUri = `postgres://${s.username}:${s.password}@${host}/${proj.localDb}`;
        proj.pooledUri = `postgres://${s.username}:${s.password}@${poolerOf(host)}/${proj.localDb}`;
      } else {
        proj.connectionUri = `postgres://neondb_owner:pw@${host}/${p.branch?.database_name ?? 'neondb'}`;
        proj.pooledUri = `postgres://neondb_owner:pw@${poolerOf(host)}/${p.branch?.database_name ?? 'neondb'}`;
      }
      projects.set(proj.id, proj);
      if (local) { hostMap[host] = local; hostMap[poolerOf(host)] = local; }
      if (scripted === 'lost') return err(res, 500, proj.name);
      return send(res, 201, {
        project: { id: proj.id, name: proj.name },
        connection_uris: [{ connection_uri: proj.connectionUri, connection_parameters: { host, pooler_host: poolerOf(host), database: proj.localDb ?? 'neondb', role: 'neondb_owner', password: 'pw' } }],
        operations: [{ id: `op-${proj.id}`, status: 'running' }],
      });
    }
    const proj = id ? projects.get(id) : undefined;
    if (req.method === 'GET' && sub === 'operations') {
      const status = fake.operationStatuses.length ? fake.operationStatuses.shift()! : 'finished';
      return send(res, 200, { operation: { id: opId, status } });
    }
    if (!proj || proj.deleted) return err(res, 404, proj?.name);
    if (req.method === 'GET' && !sub) return send(res, 200, { project: { id: proj.id, name: proj.name } });
    if (req.method === 'GET' && sub === 'endpoints') return send(res, 200, { endpoints: proj.endpoints.map((e) => ({ id: e.id, host: e.host, type: 'read_write' })) });
    if (req.method === 'DELETE' && !sub) {
      fake.markDeleted(proj.id);
      return send(res, 200, { project: { id: proj.id, name: proj.name } });
    }
    return err(res, 404);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v2`;
  return fake;
}

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
