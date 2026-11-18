import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { neonApi, NeonApiError } from '../../../scripts/backup/lib/neon-api';
import { parseRebuildLine, realDisasterLogReader, realLogReader } from '../../../scripts/backup/lib/log-reader';
import { startFakeNeon, type FakeNeon } from '../helpers/fake-neon';

/**
 * feature-plan-control-plane-disaster.md §5 (the external facts) and C2's plumbing: the new Neon client calls against the
 * fake Neon server, including how each reports an error (status and code only, never a body), the exact rebuild-line
 * parser (§6.4 R2), and the two log readers' filters and pagination.
 */

const T = '0a1b2c3d-1111-4222-8333-444455556666';
const SHA = 'b'.repeat(64);
const KEY = 'v1/prod/tenant/0a1b2c3d-1111-4222-8333-444455556666/2026/11/18/ecs-1-abcd1234.dump.enc';

describe('the Neon client: created_at, branches, databases, connection_uri', () => {
  let neon: FakeNeon;
  const api = () => neonApi({ apiKey: neon.apiKey, orgId: neon.orgId, baseUrl: neon.url, sleep: async () => {}, retries: 1 });
  beforeAll(async () => { neon = await startFakeNeon(); });
  afterAll(async () => { await neon.close(); });

  it('listProjects carries created_at as createdAt', async () => {
    const at = new Date('2026-11-17T03:04:05Z');
    const p = neon.addProject({ name: 'cadenzpoint-acme', createdAt: at });
    const l = await api().listProjects({ search: 'cadenzpoint-acme' });
    expect(l.projects.find((x) => x.id === p.id)?.createdAt).toBe(at.toISOString());
  });

  it('the owner lookup: the default branch, its databases with owner_name, then the pooled URI exactly as Neon returns it', async () => {
    const p = neon.addProject({ name: 'cadenzpoint-r-0a1b2c3d-20261118090807-1', databaseName: 'tenant_acme', owner: 'tenant_owner' });
    const branches = await api().listBranches(p.id);
    expect(branches).toEqual([{ id: `br-${p.id}`, isDefault: true }]);
    expect(await api().listDatabases(p.id, branches[0].id)).toEqual([{ name: 'tenant_acme', ownerName: 'tenant_owner' }]);
    const uri = await api().getConnectionUri({ projectId: p.id, branchId: branches[0].id, databaseName: 'tenant_acme', roleName: 'tenant_owner', pooled: true });
    expect(new URL(uri).hostname).toMatch(/-pooler\.us-east-1\.aws\.neon\.tech$/);
    expect(new URL(uri).searchParams.get('channel_binding')).toBe('require'); // returned as-is: the caller strips it (D5)
    const req = neon.requests.filter((r) => r.path.includes('/connection_uri')).at(-1)!;
    expect(new URL(`http://x${req.path}`).searchParams.get('pooled')).toBe('true');
  });

  it('errors carry the status and code only (403, 404, 503), never the body', async () => {
    const p = neon.addProject({ name: 'cadenzpoint-secret' });
    for (const [route, call] of [
      ['GET /projects/:id/branches', () => api().listBranches(p.id)],
      ['GET /projects/:id/branches/:branch/databases', () => api().listDatabases(p.id, `br-${p.id}`)],
      ['GET /projects/:id/connection_uri', () => api().getConnectionUri({ projectId: p.id, databaseName: 'neondb', roleName: 'neondb_owner', pooled: true })],
    ] as const) {
      for (const status of [403, 404, 503]) {
        neon.script(route, [status], p.id);
        const e = await call().then(() => null, (x: unknown) => x);
        expect(e, `${route} ${status}`).toBeInstanceOf(NeonApiError);
        expect((e as NeonApiError).status).toBe(status);
        expect((e as Error).message).not.toContain('secret');
        expect((e as NeonApiError).infrastructure).toBe(status >= 500);
      }
    }
  });

  it('a deleted project 404s on every new call; a wrong role 404s on connection_uri', async () => {
    const p = neon.addProject({ name: 'cadenzpoint-gone' });
    const st = async (f: () => Promise<unknown>) => ((await f().then(() => null, (x: NeonApiError) => x))?.status ?? 200);
    expect(await st(() => api().getConnectionUri({ projectId: p.id, databaseName: 'neondb', roleName: 'someone_else', pooled: true }))).toBe(404);
    neon.markDeleted(p.id);
    expect(await st(() => api().listBranches(p.id))).toBe(404);
    expect(await st(() => api().listDatabases(p.id, `br-${p.id}`))).toBe(404);
  });
});

describe('parseRebuildLine (§6.4 R2: exact re-parse)', () => {
  it('SWITCHING, LINKED, the healed LINKED and RELINKED', () => {
    expect(parseRebuildLine(`SWITCHING ${T} prj-old prj-new ${KEY} ${SHA}`, 5)).toEqual({ kind: 'SWITCHING', tenantId: T, oldProjectId: 'prj-old', newProjectId: 'prj-new', healed: false, at: 5 });
    expect(parseRebuildLine(`LINKED ${T} prj-old prj-new ${KEY} ${SHA}`, 6)).toEqual({ kind: 'LINKED', tenantId: T, oldProjectId: 'prj-old', newProjectId: 'prj-new', healed: false, at: 6 });
    expect(parseRebuildLine(`LINKED ${T} prj-old prj-new ${KEY} ${SHA} (healed by the re-read)`, 7)).toMatchObject({ kind: 'LINKED', oldProjectId: 'prj-old', healed: true });
    expect(parseRebuildLine(`LINKED ${T} - prj-new - - (healed by the re-read)`, 8)).toMatchObject({ kind: 'LINKED', oldProjectId: null, healed: true });
    expect(parseRebuildLine(`RELINKED ${T} prj-old prj-end`, 9)).toEqual({ kind: 'RELINKED', tenantId: T, oldProjectId: 'prj-old', newProjectId: 'prj-end', healed: false, at: 9 });
  });
  it('anything else is not a rebuild line', () => {
    for (const bad of [
      `SWITCHING ${T} prj-old prj-new ${KEY} ${SHA} (healed by the re-read)`, // only LINKED heals
      `LINKED ${T} - prj-new ${KEY} ${SHA}`, // a missing old id only in the healed form
      `LINKED ${T} prj-old - ${KEY} ${SHA}`,
      `LINKED acme prj-old prj-new ${KEY} ${SHA}`,
      `LINKED ${T} PRJ-OLD prj-new ${KEY} ${SHA}`,
      `RELINKED ${T} prj-old`,
      `RELINKED ${T} prj-old prj-end extra`,
      `xLINKED ${T} prj-old prj-new ${KEY} ${SHA}`,
      `  ${T}: linked`,
    ]) expect(parseRebuildLine(bad, 1), bad).toBeNull();
  });
});

describe('the log readers', () => {
  type Cmd = { input: { filterPattern?: string; startTime?: number; nextToken?: string; logGroupName?: string } };
  const client = (pages: Array<{ events: Array<{ message: string; timestamp?: number }>; nextToken?: string }>) => {
    const calls: Cmd['input'][] = [];
    let i = 0;
    return { calls, send: async (c: unknown) => { calls.push((c as Cmd).input); return pages[i++] ?? { events: [] }; } };
  };

  it('controlPlaneLines: the exact phrase filter; empty pages with a token are followed; only exact control-plane lines', async () => {
    const line = (cp: string) => `BACKUP ${cp} control-plane control-plane control-plane ecs-1 v1/${cp}/control-plane/control-plane/2026/11/18/ecs-1-abcd1234.dump.enc ${SHA} 10`;
    const c = client([{ events: [], nextToken: 'a' }, { events: [{ message: line('prod') }, { message: `${line('prod')} row-failed` }, { message: line('staging') }, { message: 'BACKUP prod control-plane garbage' },
      // L11: a page can carry other lines (the phrase filter is CloudWatch's, not ours): a tenant line and another id are dropped.
      { message: `BACKUP prod tenant ${T} acme ecs-1 v1/prod/tenant/${T}/2026/11/18/ecs-1-abcd1234.dump.enc ${SHA} 10` },
      { message: `BACKUP prod control-plane other-id control-plane ecs-1 v1/prod/control-plane/other-id/2026/11/18/ecs-1-abcd1234.dump.enc ${SHA} 10` }], nextToken: 'b' }, { events: [] }]);
    const r = await realLogReader({ region: 'us-east-1', logGroup: '/cadenzpoint/backup/backup', client: c as never }).controlPlaneLines('prod');
    expect(r.map((l) => l.cp)).toEqual(['prod', 'prod']);
    expect(c.calls.map((x) => x.filterPattern)).toEqual(Array(3).fill('"BACKUP prod control-plane control-plane"'));
    expect(c.calls.map((x) => x.nextToken)).toEqual([undefined, 'a', 'b']);
  });

  it('rebuildLines: startTime is the window start; both terms; event timestamps kept; non-lines dropped', async () => {
    const since = new Date('2026-11-17T00:00:00Z');
    const c = client([{ events: [{ message: `LINKED ${T} a1 a2 ${KEY} ${SHA}`, timestamp: 100 }, { message: `${T}: linked`, timestamp: 101 }], nextToken: 'n' }, { events: [{ message: `RELINKED ${T} a1 a3`, timestamp: 102 }] }]);
    const r = await realDisasterLogReader({ region: 'us-east-1', logGroup: '/cadenzpoint/backup/disaster', client: c as never }).rebuildLines(since);
    expect(r.map((l) => [l.kind, l.at])).toEqual([['LINKED', 100], ['RELINKED', 102]]);
    expect(c.calls[0]).toMatchObject({ logGroupName: '/cadenzpoint/backup/disaster', filterPattern: '?"LINKED" ?"SWITCHING"', startTime: since.getTime() });
  });
});
