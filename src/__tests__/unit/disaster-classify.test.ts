import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  classifyConnectError, pgConnector, candidateServes, classifyGoneEndpoint, classifyOverride, tenantCandidateRule, type ConnectResult, type Connector,
} from '../../../scripts/backup/lib/classify-endpoint';
import { neonApi, NeonApiError, createdIdOf, type NeonApi } from '../../../scripts/backup/lib/neon-api';
import { labelFor, summarizeError } from '../../../scripts/backup/lib/summarize-error';
import { startFakePgProxy, NEON_PROXY_ERRORS, type FakePgProxy } from '../helpers/fake-pg-proxy';
import { startFakeNeon, fakeHost, poolerOf, type FakeNeon } from '../helpers/fake-neon';

/**
 * feature-plan-disaster-restore.md §11 D1: the connection classes (approved detail D3: by SQLSTATE), the §6.4.1 table
 * for proof (d), the override classes, the candidate check, the Neon API client against the fake Neon server, and
 * 3b's labels for Neon's proxy wording. The local Neon-proxy stand-in answers 28P01 after asking for a password, as
 * Neon's proxy does for an unknown or deleted endpoint.
 */

const pgErr = (code: string, message = 'x') => Object.assign(new Error(message), { name: 'PostgresError', code });

describe('D1: classifyConnectError (by SQLSTATE, D3)', () => {
  it('3D000 → database-missing; 53xxx/57Pxx/42501 → post-auth; 28xxx → auth; other SQLSTATE → proxy; socket codes → socket; anything else → unknown', () => {
    expect(classifyConnectError(pgErr('3D000')).cls).toBe('database-missing');
    for (const c of ['53300', '53100', '57P03', '57P01', '42501']) expect(classifyConnectError(pgErr(c)).cls, c).toBe('post-auth');
    for (const c of ['28P01', '28000']) expect(classifyConnectError(pgErr(c)).cls, c).toBe('auth');
    for (const c of ['XX000', '08006', '08001']) expect(classifyConnectError(pgErr(c)).cls, c).toBe('proxy');
    for (const c of ['ECONNREFUSED', 'ENOTFOUND', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'ECONNRESET']) expect(classifyConnectError(Object.assign(new Error('x'), { code: c })).cls, c).toBe('socket');
    expect(classifyConnectError(new Error('weird')).cls).toBe('unknown');
    expect(classifyConnectError(Object.assign(new Error('x'), { code: '28P01' })).cls).toBe('unknown'); // not a PostgresError: refusing side
  });
});

describe('D1: pgConnector against the Neon-proxy stand-in and the real local Postgres', () => {
  let proxy: FakePgProxy;
  const at = (p: FakePgProxy, db = 'tenant_x') => `postgres://neondb_owner:pw@127.0.0.1:${p.port}/${db}`;
  beforeAll(async () => { proxy = await startFakePgProxy(); });
  afterAll(async () => { await proxy.close(); });

  it('28P01 after a password request (Neon\'s answer for an unknown or deleted endpoint) → auth', async () => {
    proxy.setMode({ kind: 'auth-fail' });
    expect(await pgConnector()(at(proxy))).toEqual({ cls: 'auth', code: '28P01' });
  });

  it('each Neon proxy error before authentication → proxy', async () => {
    for (const e of Object.values(NEON_PROXY_ERRORS)) {
      proxy.setMode({ kind: 'startup-error', ...e });
      expect((await pgConnector()(at(proxy))).cls, e.message).toBe('proxy');
    }
  });

  it('53300 and 57P03 sent before authentication → answers (post-auth class), never unreachable', async () => {
    for (const code of ['53300', '57P03']) {
      proxy.setMode({ kind: 'startup-error', code, message: 'too many connections / starting up' });
      expect((await pgConnector()(at(proxy))).cls, code).toBe('post-auth');
    }
  });

  it('a socket closed after startup → socket; no answer → socket (CONNECT_TIMEOUT)', async () => {
    proxy.setMode({ kind: 'close' });
    expect((await pgConnector({ connectTimeoutSeconds: 2 })(at(proxy))).cls).toBe('socket');
    proxy.setMode({ kind: 'hang' });
    expect(await pgConnector({ connectTimeoutSeconds: 1 })(at(proxy))).toEqual({ cls: 'socket', code: 'CONNECT_TIMEOUT' });
  }, 15_000);

  it.skipIf(!process.env.CONTROL_PLANE_DATABASE_URL)('the real local server: login succeeds → ok; a missing database (after authentication) → 3D000', async () => {
    const url = process.env.CONTROL_PLANE_DATABASE_URL!;
    expect((await pgConnector()(url)).cls).toBe('ok');
    const u = new URL(url);
    u.pathname = '/bkt_dr_doesnotexist';
    expect(await pgConnector()(u.toString())).toEqual({ cls: 'database-missing', code: '3D000' });
  });

  it('the host map rewrites only the connection target', async () => {
    proxy.setMode({ kind: 'auth-fail' });
    const host = fakeHost();
    const r = await pgConnector({ hostMap: { [host]: { host: '127.0.0.1', port: proxy.port } } })(`postgres://u:p@${host}/db`);
    expect(r.cls).toBe('auth');
  });
});

/** An in-memory NeonApi for the classification tables. */
function memNeon(o: { projects?: Array<{ id: string; name: string; hosts: string[] }>; unavailable?: boolean; endpointsFail?: string[]; listFails?: boolean } = {}): NeonApi {
  const projects = o.projects ?? [];
  return {
    async getProject(id) { const p = projects.find((x) => x.id === id); return p ? { found: true, project: { id, name: p.name } } : { found: false }; },
    async listProjects(q = {}) {
      if (o.listFails) throw new NeonApiError('list-projects', 500, null);
      return { projects: projects.filter((p) => !q.search || p.name.includes(q.search)).map((p) => ({ id: p.id, name: p.name })), unavailable: o.unavailable ? ['prj-x'] : [] };
    },
    async listEndpoints(id) {
      if (o.endpointsFail?.includes(id)) throw new NeonApiError('list-endpoints', 503, null);
      const p = projects.find((x) => x.id === id);
      if (!p) throw new NeonApiError('list-endpoints', 404, null);
      return p.hosts.map((h) => ({ id: h.split('.')[0], host: h }));
    },
    createProject: async () => { throw new Error('unused'); },
    deleteProject: async () => {},
    verifyGone: async () => true,
    findByName: async () => ({ projects: [], unavailable: [] }),
  };
}

const TID = 'abcdef12-3456-4789-8abc-def012345678';
const rule = tenantCandidateRule('acme-x', TID);
const H = 'ep-quiet-sea-111.us-east-1.aws.neon.tech';
const URL_ = `postgres://u:p@${poolerOf(H)}/tenant_acme_x?sslmode=require`;
const fixed = (r: ConnectResult): Connector => async () => r;

describe('D1: proof (d), the §6.4.1 table (the project 404s)', () => {
  it('login succeeds, or any post-authentication answer (3D000 included) → answers (refuse reachable)', async () => {
    for (const r of [{ cls: 'ok', code: null }, { cls: 'database-missing', code: '3D000' }, { cls: 'post-auth', code: '53300' }] as ConnectResult[]) {
      expect((await classifyGoneEndpoint({ url: URL_, connect: fixed(r), neon: memNeon(), rule })).cls).toBe('answers');
    }
  });

  it('28P01 with no live project serving the endpoint → doesn\'t answer (gone); with `cadenzpoint-<slug>` serving it → served', async () => {
    const auth = fixed({ cls: 'auth', code: '28P01' });
    expect((await classifyGoneEndpoint({ url: URL_, connect: auth, neon: memNeon(), rule })).cls).toBe('doesnt-answer');
    const neon = memNeon({ projects: [{ id: 'prj-new', name: 'cadenzpoint-acme-x', hosts: [H] }] });
    expect((await classifyGoneEndpoint({ url: URL_, connect: auth, neon, rule })).cls).toBe('served');
  });

  it('a rebuilt-named project (`cadenzpoint-r-<id8>-…`) serving the endpoint → served', async () => {
    const neon = memNeon({ projects: [{ id: 'prj-r', name: `cadenzpoint-r-${TID.slice(0, 8)}-20261117120000-1`, hosts: [H] }] });
    expect((await classifyGoneEndpoint({ url: URL_, connect: fixed({ cls: 'proxy', code: 'XX000' }), neon, rule })).cls).toBe('served');
  });

  it('a proxy or socket error: served when a candidate lists it, otherwise doesn\'t answer', async () => {
    for (const r of [{ cls: 'proxy', code: 'XX000' }, { cls: 'socket', code: 'ECONNREFUSED' }] as ConnectResult[]) {
      expect((await classifyGoneEndpoint({ url: URL_, connect: fixed(r), neon: memNeon(), rule })).cls).toBe('doesnt-answer');
    }
  });

  it('an endpoints lookup failure, a failed list, or a partial list → unproven (never "not served"); an unknown error → unproven', async () => {
    const auth = fixed({ cls: 'auth', code: '28P01' });
    const cand = [{ id: 'prj-c', name: 'cadenzpoint-acme-x', hosts: ['ep-other.us-east-1.aws.neon.tech'] }];
    expect((await classifyGoneEndpoint({ url: URL_, connect: auth, neon: memNeon({ projects: cand, endpointsFail: ['prj-c'] }), rule })).cls).toBe('unproven');
    expect((await classifyGoneEndpoint({ url: URL_, connect: auth, neon: memNeon({ unavailable: true }), rule })).cls).toBe('unproven');
    expect((await classifyGoneEndpoint({ url: URL_, connect: auth, neon: memNeon({ listFails: true }), rule })).cls).toBe('unproven');
    expect((await classifyGoneEndpoint({ url: URL_, connect: fixed({ cls: 'unknown', code: null }), neon: memNeon(), rule })).cls).toBe('unproven');
  });

  it('only exact `cadenzpoint-<slug>` names and the `cadenzpoint-r-<id8>-` prefix are candidates', async () => {
    const neon = memNeon({ projects: [{ id: 'prj-o', name: 'cadenzpoint-acme-x-old', hosts: [H] }] });
    expect(await candidateServes(neon, URL_, rule)).toBe('no');
  });
});

describe('D1: the override classes (the project answers 200)', () => {
  const live = (hosts: string[]) => memNeon({ projects: [{ id: 'prj-orig', name: 'cadenzpoint-acme-x', hosts }] });
  const cls = async (r: ConnectResult, neon: NeonApi) => classifyOverride({ url: URL_, projectId: 'prj-orig', connect: fixed(r), neon, rule });

  it('3D000 is checked first → database-missing', async () => {
    expect((await cls({ cls: 'database-missing', code: '3D000' }, live([H]))).cls).toBe('database-missing');
  });
  it('login succeeds or a post-auth answer → answers', async () => {
    expect((await cls({ cls: 'ok', code: null }, live([H]))).cls).toBe('answers');
    expect((await cls({ cls: 'post-auth', code: '57P03' }, live([H]))).cls).toBe('answers');
  });
  it('endpoint listed + 28P01 → credentials (skippable, data intact)', async () => {
    expect((await cls({ cls: 'auth', code: '28P01' }, live([H]))).cls).toBe('credentials');
  });
  it('endpoint listed + a proxy or socket error → unreachable (endpoint-listed)', async () => {
    expect(await cls({ cls: 'proxy', code: 'XX000' }, live([H]))).toMatchObject({ cls: 'unreachable', reason: 'endpoint-listed' });
    expect(await cls({ cls: 'socket', code: 'CONNECT_TIMEOUT' }, live([H]))).toMatchObject({ cls: 'unreachable', reason: 'endpoint-listed' });
  });
  it('endpoint not listed + no candidate → unreachable (endpoint-gone), whatever the error, even 28P01', async () => {
    expect(await cls({ cls: 'auth', code: '28P01' }, live(['ep-new.us-east-1.aws.neon.tech']))).toMatchObject({ cls: 'unreachable', reason: 'endpoint-gone' });
  });
  it('endpoint not listed + a candidate serves it → served-elsewhere (refuse reachable)', async () => {
    const neon = memNeon({ projects: [{ id: 'prj-orig', name: 'cadenzpoint-acme-x', hosts: ['ep-new.us-east-1.aws.neon.tech'] }, { id: 'prj-r', name: `cadenzpoint-r-${TID.slice(0, 8)}-x`, hosts: [H] }] });
    expect((await cls({ cls: 'auth', code: '28P01' }, neon)).cls).toBe('served-elsewhere');
  });
  it('an endpoints lookup failure (or a 404) → proof-failed', async () => {
    expect((await cls({ cls: 'proxy', code: 'XX000' }, memNeon({ projects: [{ id: 'prj-orig', name: 'n', hosts: [H] }], endpointsFail: ['prj-orig'] }))).cls).toBe('proof-failed');
    expect((await cls({ cls: 'proxy', code: 'XX000' }, memNeon())).cls).toBe('proof-failed');
  });
});

describe('D1: the Neon API client against the fake Neon server', () => {
  let neon: FakeNeon;
  const api = (o: Partial<Parameters<typeof neonApi>[0]> = {}) => neonApi({ apiKey: neon.apiKey, orgId: neon.orgId, baseUrl: neon.url, sleep: async () => {}, operationPollMs: 1, ...o });
  beforeAll(async () => { neon = await startFakeNeon(); });
  afterAll(async () => { await neon.close(); });

  it('lists every page with org_id; a personal key without the right org sees an empty list', async () => {
    for (let i = 0; i < 8; i++) neon.addProject({ name: `cadenzpoint-t${i}` });
    const l = await api().listProjects();
    expect(l.projects.length).toBe(8);
    expect(neon.requests.filter((r) => r.path.startsWith('/projects?')).length).toBeGreaterThanOrEqual(3); // page size 3
    expect(neon.requests.every((r) => !r.path.startsWith('/projects?') || r.path.includes(`org_id=${neon.orgId}`))).toBe(true);
    expect((await api({ orgId: 'org-other' }).listProjects()).projects).toEqual([]);
  });

  it('collects unavailable_project_ids across pages', async () => {
    neon.unavailable = { ids: ['prj-slow'], calls: 1 };
    expect((await api().listProjects()).unavailable).toEqual(['prj-slow']);
  });

  it('get: 404 → not found; 403/5xx → an error carrying only the status and code (never the body)', async () => {
    expect(await api().getProject('prj-missing')).toEqual({ found: false });
    for (const status of [403, 500, 401]) {
      neon.script('GET /projects/:id', [status]);
      const e = (await api().getProject('prj-any').catch((x) => x)) as NeonApiError;
      expect(e).toBeInstanceOf(NeonApiError);
      expect(e.status).toBe(status);
      expect(String(e.message)).not.toContain('secret-project-name');
      expect(String(e.message)).not.toContain('said no');
    }
  });

  it('423 and 429 are retried with backoff, then succeed', async () => {
    const p = neon.addProject({ name: 'cadenzpoint-retry' });
    neon.script('GET /projects/:id', [423, 429, 423]);
    expect((await api().getProject(p.id)).found).toBe(true);
  });

  it('create: project.org_id in the body; waits for operations; returns direct and pooled URIs', async () => {
    neon.operationStatuses = ['running', 'scheduling', 'finished'];
    const c = await api().createProject({ name: 'cadenzpoint-r-abcdef12-20261117120000-1', databaseName: 'tenant_x', historyRetentionSeconds: 604800, regionId: 'aws-us-east-1' });
    const post = neon.requests.find((r) => r.method === 'POST')!;
    expect(post.body).toMatchObject({ project: { org_id: neon.orgId, pg_version: 16, region_id: 'aws-us-east-1', history_retention_seconds: 604800, branch: { database_name: 'tenant_x' } } });
    expect(c.pooledUri).toContain('-pooler.');
    expect(c.connectionUri).not.toContain('-pooler.');
  });

  it('an operation that ends `failed` (even with no retry_at) is terminal (D4): an infrastructure error carrying the created id', async () => {
    neon.operationStatuses = ['running', 'failed'];
    const e = await api().createProject({ name: 'cadenzpoint-r-x-1', databaseName: 'd', historyRetentionSeconds: 3600, regionId: 'aws-us-east-1' }).catch((x) => x);
    expect(e).toBeInstanceOf(NeonApiError);
    expect((e as NeonApiError).infrastructure).toBe(true);
    expect(createdIdOf(e)).toMatch(/^prj-/);
  });

  it('a lost create response: an error with no id; findByName finds the project by its exact name', async () => {
    neon.script('POST /projects', ['lost']);
    const e = await api().createProject({ name: 'cadenzpoint-r-lost-1', databaseName: 'd', historyRetentionSeconds: 3600, regionId: 'aws-us-east-1' }).catch((x) => x);
    expect(createdIdOf(e)).toBeNull();
    const f = await api().findByName('cadenzpoint-r-lost-1');
    expect(f.projects.map((p) => p.name)).toEqual(['cadenzpoint-r-lost-1']);
  });

  it('delete → 200; verifyGone sees the 404; the project is in the recoverable list (with recoverable_until)', async () => {
    const p = neon.addProject({ name: 'cadenzpoint-del' });
    await api().deleteProject(p.id);
    expect(await api().verifyGone(p.id, 2, 1)).toBe(true);
    const rec = await api().listProjects({ recoverable: true });
    expect(rec.projects.find((x) => x.id === p.id)?.recoverableUntil).toBeTruthy();
    await api().deleteProject(p.id); // already gone → fine
  });

  it('a dropped socket is a network error (infrastructure)', async () => {
    neon.script('GET /projects/:id', ['drop']);
    const e = (await api().getProject('prj-x').catch((x) => x)) as NeonApiError;
    expect(e.status).toBe(0);
    expect(e.infrastructure).toBe(true);
  });
});

describe('D1: 3b labels learn Neon\'s proxy wording (override evidence)', () => {
  it('each proxy message → connection-refused; a 28P01 stays auth-failed', () => {
    for (const e of Object.values(NEON_PROXY_ERRORS)) expect(labelFor(new Error(e.message)), e.message).toBe('connection-refused');
    expect(labelFor(pgErr('28P01', 'password authentication failed for user "x"'))).toBe('auth-failed');
    expect(summarizeError('connect', new Error("Couldn't connect to compute node"))).toBe('connect label=connection-refused');
  });
});

describe('fix round 1 (D1 additions)', () => {
  it('M09: on the override path, an endpoint not listed whose candidate check can\'t complete (a partial list) → proof-failed, never unreachable', async () => {
    const neon = memNeon({ projects: [{ id: 'prj-orig', name: 'cadenzpoint-acme-x', hosts: ['ep-new.us-east-1.aws.neon.tech'] }], unavailable: true });
    const r = await classifyOverride({ url: URL_, projectId: 'prj-orig', connect: fixed({ cls: 'auth', code: '28P01' }), neon, rule });
    expect(r.cls).toBe('proof-failed');
  });

  it('FR10: the create-operation wait stops at once on a stop; the error carries the created project id', async () => {
    const fake = await startFakeNeon();
    try {
      fake.operationStatuses = Array.from({ length: 1000 }, () => 'running');
      const stop = new AbortController();
      const api = neonApi({ apiKey: fake.apiKey, orgId: fake.orgId, baseUrl: fake.url, operationPollMs: 50 });
      setTimeout(() => stop.abort('stopped'), 120);
      const t0 = Date.now();
      const e = await api.createProject({ name: 'cadenzpoint-r-stop-1', databaseName: 'd', historyRetentionSeconds: 3600, regionId: 'aws-us-east-1' }, stop.signal).catch((x) => x);
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(e).toBeInstanceOf(NeonApiError);
      expect((e as NeonApiError).code).toBe('stopped');
      expect(createdIdOf(e)).toMatch(/^prj-/);
    } finally {
      await fake.close();
    }
  });
});
