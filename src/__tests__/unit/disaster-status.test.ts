import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { disasterFindings, observeNeon, isDisasterKind, DISASTER_ALERT_KINDS, type DisasterFacts, type NeonView, type ProjectGroup, type NeonFetch } from '@/lib/tenant/disaster-status';
import { FINDING_KINDS, BACKUP_ALERT_PREFIXES } from '@/lib/tenant/backup-status';

/**
 * feature-plan-disaster-restore.md §11 D6: the §6.8 findings (and the §7.2 watch), pure, plus the Neon observation
 * (the personal-key check; any failure leaves Neon-based alerts as they are).
 */

const NOW = new Date('2026-12-20T13:00:00Z');
const H = 3600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const facts = (o: Partial<DisasterFacts> = {}): DisasterFacts => ({ runs: [], firstCpOkAt: null, projects: [], deploy: [], watches: [], ...o });
const view = (o: Partial<NeonView> = {}): NeonView => ({ failed: false, keyOk: true, exists: new Map(), byName: new Map(), recoverable: new Map(), ...o });
const group = (o: Partial<ProjectGroup>): ProjectGroup => ({ name: 'cadenzpoint-r-aaaaaaaa-20261219000000-1', id: 'prj-n', latestStatus: 'created', latestAt: ago(7 * H), tenantId: 'T1', slug: 'acme-x', oldProjectId: 'prj-o', referencedBy: null, ...o });
const kinds = (r: ReturnType<typeof disasterFindings>) => r.raise.map((x) => x.kind);

describe('D6: leftover projects', () => {
  it('a project left intended/created/failed for over 6 h, referenced by no tenant, still alive → rebuild-orphan-project (detail has tenant id and slug)', () => {
    const r = disasterFindings(facts({ projects: [group({})] }), view({ exists: new Map([['prj-n', true]]) }), NOW);
    expect(r.raise).toEqual([expect.objectContaining({ kind: 'rebuild-orphan-project', dedupKey: 'prj-n', detail: expect.objectContaining({ tenantId: 'T1', slug: 'acme-x', todo: 'delete it in the Neon console' }) })]);
  });
  it('within 6 h, or finished (deleted/linked/rehearsed-deleted/gone-confirmed) → nothing', () => {
    for (const g of [group({ latestAt: ago(5 * H) }), group({ latestStatus: 'deleted' }), group({ latestStatus: 'linked' }), group({ latestStatus: 'gone-confirmed' }), group({ latestStatus: 'rehearsed-deleted' })]) {
      expect(disasterFindings(facts({ projects: [g] }), view({ exists: new Map([['prj-n', true]]) }), NOW).raise).toEqual([]);
    }
  });
  it('resolved by a 404 alone: gone-confirmed is appended (so it isn\'t re-checked); a name-only leftover is looked up by name', () => {
    const r = disasterFindings(facts({ projects: [group({})] }), view({ exists: new Map([['prj-n', false]]) }), NOW);
    expect(r.raise).toEqual([]);
    expect(r.goneConfirmed.map((g) => g.name)).toEqual(['cadenzpoint-r-aaaaaaaa-20261219000000-1']);
    const nameOnly = group({ id: null, latestStatus: 'intended' });
    expect(kinds(disasterFindings(facts({ projects: [nameOnly] }), view({ byName: new Map([[nameOnly.name, 'prj-found']]) }), NOW))).toEqual(['rebuild-orphan-project']);
    expect(disasterFindings(facts({ projects: [nameOnly] }), view({ byName: new Map([[nameOnly.name, null]]) }), NOW).goneConfirmed).toHaveLength(1);
  });
  it('a `failed` project a tenant row references (a commit that landed) is healed to linked and gets the watch', () => {
    const r = disasterFindings(facts({ projects: [group({ latestStatus: 'failed', referencedBy: 'T1' })] }), view(), NOW);
    expect(r.healed).toHaveLength(1);
    expect(r.raise).toEqual([]);
  });
  it('a Neon failure keeps the orphan alert open (never resolved on an unknown)', () => {
    expect(kinds(disasterFindings(facts({ projects: [group({})] }), view({ failed: true }), NOW))).toEqual(['rebuild-orphan-project', 'rebuild-watch-check-failed']);
  });
});

describe('D6: workspace-needs-deploy', () => {
  const d = (o: Record<string, unknown>) => ({ tenantId: 'T1', slug: 'acme-x', status: 'active', hasUrl: true, skippedAt: null, migratedAt: null, linkedAt: null, lastOkAt: null, ...o });
  it('skip → 3b ok after it → raised; a migrated row newer than the skip → resolved', () => {
    expect(kinds(disasterFindings(facts({ deploy: [d({ skippedAt: ago(30 * H), lastOkAt: ago(10 * H) })] }), view(), NOW))).toEqual(['workspace-needs-deploy']);
    expect(disasterFindings(facts({ deploy: [d({ skippedAt: ago(30 * H), lastOkAt: ago(10 * H), migratedAt: ago(5 * H) })] }), view(), NOW).raise).toEqual([]);
    expect(disasterFindings(facts({ deploy: [d({ skippedAt: ago(30 * H) })] }), view(), NOW).raise).toEqual([]); // still lost: no ok since
  });
  it('a rebuild (linked) with no deploy since, at least 1 hour old → raised; under an hour → not yet; then any migration resolves it', () => {
    expect(kinds(disasterFindings(facts({ deploy: [d({ linkedAt: ago(2 * H) })] }), view(), NOW))).toEqual(['workspace-needs-deploy']);
    expect(disasterFindings(facts({ deploy: [d({ linkedAt: ago(0.5 * H) })] }), view(), NOW).raise).toEqual([]);
    expect(disasterFindings(facts({ deploy: [d({ linkedAt: ago(2 * H), migratedAt: ago(1 * H) })] }), view(), NOW).raise).toEqual([]);
  });
  it('no longer migratable (deleted) → resolved', () => {
    expect(disasterFindings(facts({ deploy: [d({ linkedAt: ago(2 * H), status: 'deleted', hasUrl: false })] }), view(), NOW).raise).toEqual([]);
  });
});

describe('D6: runs and rehearsals', () => {
  const run = (o: Record<string, unknown>) => ({ id: 'r1', runId: 'gh-1-1', mode: 'workspace', status: 'running', startedAt: ago(346 * 60_000), finishedAt: null, ...o });
  it('a run `running` for over 345 minutes → disaster-run-stuck AND closed as abandoned in the same run; at 344 → nothing', () => {
    const r = disasterFindings(facts({ runs: [run({})] }), view(), NOW);
    expect(kinds(r)).toEqual(['disaster-run-stuck']);
    expect(r.closeRuns).toEqual(['r1']);
    expect(disasterFindings(facts({ runs: [run({ startedAt: ago(344 * 60_000) })] }), view(), NOW).raise).toEqual([]);
  });
  it('rehearse-failed: the newest rehearsal failed; or none passed in 40 days, anchored to the first control-plane ok backup; resolved when the newest passes', () => {
    const reh = (status: string, days: number) => run({ id: `r${days}`, runId: `task-${days}`, mode: 'rehearse', status, startedAt: ago(days * D) });
    expect(kinds(disasterFindings(facts({ runs: [reh('fail', 1), reh('pass', 10)] }), view(), NOW))).toEqual(['disaster-rehearse-failed']);
    expect(disasterFindings(facts({ runs: [reh('pass', 1), reh('fail', 10)] }), view(), NOW).raise).toEqual([]);
    expect(kinds(disasterFindings(facts({ runs: [], firstCpOkAt: ago(41 * D) }), view(), NOW))).toEqual(['disaster-rehearse-failed']); // never recorded a row
    expect(disasterFindings(facts({ runs: [], firstCpOkAt: ago(39 * D) }), view(), NOW).raise).toEqual([]);
    expect(kinds(disasterFindings(facts({ runs: [reh('pass', 41)], firstCpOkAt: ago(100 * D) }), view(), NOW))).toEqual(['disaster-rehearse-failed']);
  });
});

describe('D6: the original watch (§7.2)', () => {
  const watch = (o: Record<string, unknown> = {}) => ({ oldProjectId: 'prj-o', tenantId: 'T1', slug: 'acme-x', watchStartedAt: ago(10 * D), everReturned: false, detail: { tenantId: 'T1', slug: 'acme-x' }, ...o });
  it('200 → rebuild-original-returned (detail has the tenant id tenant:delete matches on); 404 → not raised (resolved on 404 alone)', () => {
    const r = disasterFindings(facts({ watches: [watch()] }), view({ exists: new Map([['prj-o', true]]) }), NOW);
    expect(r.raise).toEqual([expect.objectContaining({ kind: 'rebuild-original-returned', dedupKey: 'prj-o', detail: expect.objectContaining({ tenantId: 'T1' }) })]);
    expect(disasterFindings(facts({ watches: [watch()] }), view({ exists: new Map([['prj-o', false]]) }), NOW).raise).toEqual([]);
  });
  it('404 and recoverable → rebuild-original-recoverable with recoverable_until; suppressed once it was ever reported returned (the founder deleted it)', () => {
    const v = view({ exists: new Map([['prj-o', false]]), recoverable: new Map([['prj-o', '2026-12-25T00:00:00Z']]) });
    const r = disasterFindings(facts({ watches: [watch()] }), v, NOW);
    expect(r.raise).toEqual([expect.objectContaining({ kind: 'rebuild-original-recoverable', detail: expect.objectContaining({ recoverableUntil: '2026-12-25T00:00:00Z' }) })]);
    expect(disasterFindings(facts({ watches: [watch({ everReturned: true })] }), v, NOW).raise).toEqual([]);
  });
  it('the watch lasts at least 30 days: done only when ≥ 30 days, 404 and not recoverable (also for an override\'s watch)', () => {
    expect(disasterFindings(facts({ watches: [watch({ watchStartedAt: ago(31 * D) })] }), view({ exists: new Map([['prj-o', false]]) }), NOW).watchesDone).toEqual(['prj-o']);
    expect(disasterFindings(facts({ watches: [watch({ watchStartedAt: ago(29 * D) })] }), view({ exists: new Map([['prj-o', false]]) }), NOW).watchesDone).toEqual([]);
    expect(disasterFindings(facts({ watches: [watch({ watchStartedAt: ago(31 * D) })] }), view({ exists: new Map([['prj-o', false]]), recoverable: new Map([['prj-o', null]]) }), NOW).watchesDone).toEqual([]);
    expect(disasterFindings(facts({ watches: [watch({ watchStartedAt: ago(31 * D), detail: { override: true } })] }), view({ exists: new Map([['prj-o', true]]) }), NOW).watchesDone).toEqual([]);
  });
  it('a failed check or a key that can\'t see the organisation → rebuild-watch-check-failed (and nothing watch-related is decided)', () => {
    expect(kinds(disasterFindings(facts({ watches: [watch()] }), view({ failed: true }), NOW))).toEqual(['rebuild-watch-check-failed']);
    expect(kinds(disasterFindings(facts(), view({ keyOk: false }), NOW))).toEqual(['rebuild-watch-check-failed']);
  });
});

describe('D6: the Neon observation (the app\'s organisation key)', () => {
  const fake = (o: { projects?: Array<{ id: string; name: string }>; status?: Record<string, number>; unavailable?: boolean } = {}): NeonFetch => async (path) => {
    if (path.startsWith('/projects?')) return { status: 200, json: { projects: path.includes('cursor=') ? [] : o.projects ?? [], pagination: { cursor: 'c1' }, ...(o.unavailable ? { unavailable_project_ids: ['x'] } : {}) } };
    const id = decodeURIComponent(path.split('/')[2]);
    return { status: o.status?.[id] ?? 404, json: {} };
  };
  it('a personal key (the control-plane project not in the list) or no CONTROL_PLANE_PROJECT_ID → keyOk false, daily', async () => {
    expect((await observeNeon(facts(), NOW, fake({ projects: [{ id: 'prj-cp', name: 'cp' }] }), 'prj-cp')).keyOk).toBe(true);
    expect((await observeNeon(facts(), NOW, fake({ projects: [] }), 'prj-cp')).keyOk).toBe(false);
    expect((await observeNeon(facts(), NOW, fake({ projects: [{ id: 'prj-cp', name: 'cp' }] }), undefined)).keyOk).toBe(false);
  });
  it('any failure (a 5xx, an incomplete list, no key) → failed', async () => {
    const f = facts({ watches: [{ oldProjectId: 'prj-o', tenantId: 'T1', slug: 's', watchStartedAt: ago(D), everReturned: false, detail: {} }] });
    expect((await observeNeon(f, NOW, fake({ projects: [{ id: 'prj-cp', name: 'cp' }], status: { 'prj-o': 500 } }), 'prj-cp')).failed).toBe(true);
    expect((await observeNeon(f, NOW, fake({ unavailable: true }), 'prj-cp')).failed).toBe(true);
    expect((await observeNeon(f, NOW, null, 'prj-cp')).failed).toBe(true);
    const ok = await observeNeon(f, NOW, fake({ projects: [{ id: 'prj-cp', name: 'cp' }] }), 'prj-cp');
    expect(ok).toMatchObject({ failed: false, keyOk: true });
    expect(ok.exists.get('prj-o')).toBe(false);
  });
});

describe('D6: separation from 3b', () => {
  it('none of these kinds is in FINDING_KINDS or matches 3b\'s "monitoring off" prefixes; resolve-alert\'s refusal covers them all', () => {
    for (const k of DISASTER_ALERT_KINDS) {
      expect((FINDING_KINDS as readonly string[]).includes(k), k).toBe(false);
      expect(BACKUP_ALERT_PREFIXES.some((p) => k.startsWith(p)), k).toBe(false);
      // resolve-alert refuses rebuild-*/disaster-* (§6.8); workspace-needs-deploy is a plain condition alert.
      expect(isDisasterKind(k), k).toBe(k !== 'workspace-needs-deploy');
    }
  });
});

describe('fix round 1 (D6 additions)', () => {
  it('M32: the 6-hour leftover boundary: 5 h 54 min → nothing; 6 h 06 min → raised', () => {
    const v = view({ exists: new Map([['prj-n', true]]) });
    expect(disasterFindings(facts({ projects: [group({ latestAt: ago(5.9 * H) })] }), v, NOW).raise).toEqual([]);
    expect(kinds(disasterFindings(facts({ projects: [group({ latestAt: ago(6.1 * H) })] }), v, NOW))).toEqual(['rebuild-orphan-project']);
  });

  it('M58: the gate: BACKUPS_EXPECTED unset in production ("not configured") or 0 → the sync never runs', async () => {
    const { syncDisasterAlerts } = await import('@/lib/tenant/disaster-status');
    const neon = async () => { throw new Error('Neon must not be called'); };
    expect(await syncDisasterAlerts(NOW, { neon, env: { NODE_ENV: 'production' } })).toEqual({ synced: false, findings: 0 });
    expect(await syncDisasterAlerts(NOW, { neon, env: { BACKUPS_EXPECTED: '0' } })).toEqual({ synced: false, findings: 0 });
    expect(await syncDisasterAlerts(NOW, { neon, env: {} })).toEqual({ synced: false, findings: 0 });
  });
});
