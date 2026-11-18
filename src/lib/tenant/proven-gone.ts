import 'server-only';
import { appNeonFetch, type NeonFetch } from './disaster-status';
import { directNeonHost } from './neon';
// Approved detail D3 (feature-plan-control-plane-disaster.md §6.6 check 5): one definition of "a live project serves this
// host" and of the connection classes, shared with the disaster task. These modules are pure (postgres + URL); only CLI
// scripts reach this file (a static test keeps it out of the app's bundle).
import { candidateServes, pgConnector, tenantCandidateRule, type CandidateNeon, type Connector } from '../../../scripts/backup/lib/classify-endpoint';

/**
 * `tenant:delete --project-proven-gone` (feature-plan-control-plane-disaster.md §6.6, §7.4): the read-only proof that a
 * workspace's dedicated Neon project is gone, run before the "not found" refusal it replaces. Every check must hold, in
 * order, or the deletion is refused with the failed check named. Uses the app's NEON_API_KEY (an Organization key: the
 * organisation is inferred, so the app needs no org id) and the control plane in CONTROL_PLANE_DATABASE_URL.
 */

export interface ProvenGoneSeams {
  /** Tests only: the Neon API (the fake server) and the connection probe. Never read from the environment. */
  neon?: NeonFetch;
  connect?: Connector;
}

export type ProvenGoneResult =
  | { ok: true; provenAt: Date; recoverableUntil: string | null; recoverable: boolean }
  | { ok: false; check: string; reason: string };

/** The two calls candidateServes needs, over the app's Neon fetch (paginated; `unavailable_project_ids` reported). */
export function appCandidateNeon(neon: NeonFetch): CandidateNeon {
  return {
    async listProjects(q = {}) {
      const projects: Array<{ id: string; name: string }> = [];
      const unavailable: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const params = new URLSearchParams({ limit: '400' });
        if (q.search) params.set('search', q.search);
        if (q.recoverable) params.set('recoverable', 'true');
        if (cursor) params.set('cursor', cursor);
        const r = await neon(`/projects?${params}`);
        if (r.status !== 200 || !r.json) throw new Error(`neon list: HTTP ${r.status}`);
        const items = (Array.isArray(r.json.projects) ? r.json.projects : []) as Array<{ id: string; name: string }>;
        projects.push(...items.map((p) => ({ id: String(p.id), name: String(p.name ?? '') })));
        if (Array.isArray(r.json.unavailable_project_ids)) unavailable.push(...(r.json.unavailable_project_ids as unknown[]).map(String));
        const next = (r.json.pagination as { cursor?: string } | undefined)?.cursor;
        if (items.length === 0 || !next || next === cursor) break;
        cursor = next;
      }
      return { projects, unavailable };
    },
    async listEndpoints(projectId) {
      const r = await neon(`/projects/${encodeURIComponent(projectId)}/endpoints`);
      if (r.status !== 200 || !r.json || !Array.isArray(r.json.endpoints)) throw new Error(`neon endpoints: HTTP ${r.status}`);
      return (r.json.endpoints as Array<{ id?: string; host?: string }>).map((e) => ({ id: String(e.id ?? ''), host: String(e.host ?? '') }));
    },
  };
}

export async function proveProjectGone(o: {
  tenantId: string;
  slug: string;
  projectId: string;
  tenantDbUrl: string;
  env?: Record<string, string | undefined>;
  seams?: ProvenGoneSeams;
  now?: () => Date;
}): Promise<ProvenGoneResult> {
  const env = o.env ?? process.env;
  const refuse = (check: string, reason: string): ProvenGoneResult => ({ ok: false, check, reason });
  // 1. CONTROL_PLANE_PROJECT_ID (required for this flag).
  const cpProjectId = env.CONTROL_PLANE_PROJECT_ID;
  if (!cpProjectId) return refuse('control-plane-project-id', 'CONTROL_PLANE_PROJECT_ID is not set (add production\'s control-plane project id to your .env.local; RESTORE.md B.5)');
  const cpUrl = env.CONTROL_PLANE_DATABASE_URL;
  if (!cpUrl) return refuse('control-plane-project-id', 'CONTROL_PLANE_DATABASE_URL is not set');
  const fetchNeon = o.seams?.neon ?? (env.NEON_API_KEY ? appNeonFetch(env.NEON_API_KEY) : null);
  if (!fetchNeon) return refuse('positive-control', 'NEON_API_KEY is not set');
  const neon = appCandidateNeon(fetchNeon);

  // 2. The positive control, tied to the connected control plane: the org list is complete, it contains
  //    CONTROL_PLANE_PROJECT_ID, and that project's endpoints include the control plane's direct host.
  try {
    const all = await neon.listProjects();
    if (all.unavailable.length > 0) return refuse('positive-control', "the organisation's project list was incomplete");
    if (!all.projects.some((p) => p.id === cpProjectId)) return refuse('positive-control', `CONTROL_PLANE_PROJECT_ID ${cpProjectId} is not in the key's organisation (a wrong key or org)`);
    const cpHost = directNeonHost(new URL(cpUrl).hostname.toLowerCase());
    const eps = await neon.listEndpoints(cpProjectId);
    if (!eps.some((e) => directNeonHost(e.host.toLowerCase()) === cpHost)) {
      return refuse('positive-control', `project ${cpProjectId} doesn't serve CONTROL_PLANE_DATABASE_URL's host (is your .env.local repointed? RESTORE.md B.5)`);
    }
  } catch (e) {
    return refuse('positive-control', `a Neon call failed (${(e as Error).message.slice(0, 80)})`);
  }

  // 3. The workspace's project answers 404.
  const g = await fetchNeon(`/projects/${encodeURIComponent(o.projectId)}`).catch(() => ({ status: 0, json: null }));
  if (g.status === 200) return refuse('project-404', `Neon still has project ${o.projectId}: it isn't gone`);
  if (g.status !== 404) return refuse('project-404', `the project lookup didn't answer 404 (HTTP ${g.status})`);

  // 4. The workspace's URL fails with `auth` (28xxx): what Neon's proxy says for a deleted endpoint.
  const connect = o.seams?.connect ?? pgConnector();
  const c = await connect(o.tenantDbUrl);
  if (c.cls !== 'auth') return refuse('url-auth', `couldn't prove the database is gone: its address answered ${c.cls}${c.code ? ` (${c.code})` : ''}, not an authentication failure`);

  // 5. No live organisation project serves the tenant's host (a stale password on a live project).
  const served = await candidateServes(neon, o.tenantDbUrl, tenantCandidateRule(o.slug, o.tenantId));
  if (served === 'yes') return refuse('not-served', "a live project serves the workspace's address (a stale project id or password): it isn't gone");
  if (served === 'unproven') return refuse('not-served', "the served-elsewhere check couldn't be completed (a Neon call failed or a list was incomplete)");

  // Informational: Neon may still recover it (closing the workspace doesn't).
  let recoverable = false;
  let recoverableUntil: string | null = null;
  try {
    const r = await fetchNeon(`/projects?limit=400&recoverable=true&search=${encodeURIComponent(o.projectId)}`);
    const hit = (Array.isArray(r.json?.projects) ? r.json!.projects as Array<{ id: string; recoverable_until?: string }> : []).find((p) => p.id === o.projectId);
    if (hit) { recoverable = true; recoverableUntil = hit.recoverable_until ?? null; }
  } catch { /* informational only */ }
  return { ok: true, provenAt: (o.now ?? (() => new Date()))(), recoverable, recoverableUntil };
}
