import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-launch-blockers.md P6 §3 / §4, §9 "Heartbeat": the daily digest is ALWAYS sent (a short "all quiet"
 * version without news) and lists overdue / never-run crons; an immediate-email alert emails once per incident.
 */

const h = vi.hoisted(() => ({
  sends: [] as Array<{ to: string; subject: string; html: string }>,
  sendResult: { data: { id: 'msg-1' }, error: null } as { data: { id: string } | null; error: { message: string } | null },
  cronRows: [] as Array<{ name: string; lastStartedAt: Date | null; lastSucceededAt: Date | null; lastSummary: unknown }>,
  opened: true,
  sentryMessages: [] as string[],
  waitlisted: [] as Array<{ id: string; slug: string; email: string; waitlistedAt: Date }>,
}));

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureMessage: (m: string) => { h.sentryMessages.push(m); }, captureException: () => {} }));
vi.mock('@/lib/email/client', () => ({
  EMAIL_FROM: 'CadenzPoint <noreply@example.com>',
  resend: { emails: { send: async (p: { to: string; subject: string; html: string }) => { h.sends.push(p); return h.sendResult; } } },
}));

/** A drizzle-shaped stub: every query chain resolves to no rows. */
function emptyChain(): unknown {
  const fn = () => proxy;
  const proxy: unknown = new Proxy(fn, {
    get: (_t, key) => (key === 'then' ? (resolve: (v: unknown[]) => void) => resolve([]) : () => proxy),
  });
  return proxy;
}
vi.mock('@/db/control-plane/locked', () => ({ withLockedPool: async (fn: (db: unknown) => unknown) => fn({ select: () => emptyChain() }) }));
vi.mock('@/lib/tenant/lifecycle-store', () => ({
  raiseAlert: async () => ({ opened: h.opened }),
  resolveAlert: async () => {},
}));
vi.mock('@/lib/signup/maintenance', () => ({ waitlistedSignups: async () => h.waitlisted, signupsDueForDeletion: async () => [] }));
vi.mock('@/lib/cron/heartbeat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cron/heartbeat')>()),
  readCronRuns: async () => h.cronRows,
}));

import { sendOpsDigest } from '@/lib/tenant/ops-digest';
import { raiseAlertWithEmail } from '@/lib/tenant/ops-alert-email';
import { CRON_NAMES } from '@/lib/cron/heartbeat';

const NOW = new Date('2026-10-21T13:00:00Z');
const allFresh = () => CRON_NAMES.map((name) => ({ name, lastStartedAt: NOW, lastSucceededAt: new Date(NOW.getTime() - 5 * 60_000), lastSummary: {} }));

beforeEach(() => {
  h.sends = [];
  h.sendResult = { data: { id: 'msg-1' }, error: null };
  h.cronRows = allFresh();
  h.opened = true;
  h.sentryMessages = [];
  h.waitlisted = [];
  process.env.OPS_ALERT_EMAIL = 'ops@example.com';
});
afterEach(() => { delete process.env.OPS_ALERT_EMAIL; });

describe('daily digest', () => {
  it('is sent even with no news — a short "all quiet" version', async () => {
    expect(await sendOpsDigest([], NOW, false)).toBe('sent');
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].subject).toBe('CadenzPoint ops digest — 2026-10-21 (all quiet)');
    expect(h.sends[0].html).toContain('All quiet');
  });

  it('lists a stale cron (its own limit) and one that never ran — and is then not "all quiet"', async () => {
    h.cronRows = allFresh()
      .filter((r) => r.name !== 'daily-reminder')
      .map((r) => (r.name === 'notice-delivery' ? { ...r, lastSucceededAt: new Date(NOW.getTime() - 3 * 3_600_000) } : r));
    expect(await sendOpsDigest([], NOW, false)).toBe('sent');
    const { subject, html } = h.sends[0];
    expect(subject).not.toContain('all quiet');
    expect(html).toContain('Crons overdue or never run');
    expect(html).toMatch(/notice-delivery — last success 2026-10-21T10:00:00\.000Z \(limit 1 h\)/);
    expect(html).toMatch(/daily-reminder — <strong>never ran<\/strong>/);
    expect(html).not.toContain('All quiet');
  });
});

describe('daily digest — signups (P5)', () => {
  it('lists waitlisted signups with the provision command', async () => {
    h.waitlisted = [{ id: 'sig-1', slug: 'newco', email: 'a@newco.com', waitlistedAt: NOW }];
    await sendOpsDigest([], NOW, false);
    expect(h.sends[0].subject).not.toContain('all quiet');
    expect(h.sends[0].html).toMatch(/Waitlisted signups[\s\S]*newco — a@newco\.com[\s\S]*id sig-1/);
  });
});

describe('immediate-email alert', () => {
  it('a newly opened alert emails OPS_ALERT_EMAIL and notifies Sentry', async () => {
    const r = await raiseAlertWithEmail({ tenantId: null, kind: 'cron-incomplete', dedupKey: 'daily-reminder', summary: 'stopped early' }, NOW);
    expect(r).toEqual({ opened: true, emailed: true });
    expect(h.sends).toEqual([expect.objectContaining({ to: 'ops@example.com', subject: 'CadenzPoint alert: cron-incomplete:daily-reminder' })]);
    expect(h.sentryMessages).toEqual(['ops alert cron-incomplete:daily-reminder: stopped early']);
  });

  it('a bump of an already-open alert sends nothing (one email per incident)', async () => {
    h.opened = false;
    expect(await raiseAlertWithEmail({ tenantId: null, kind: 'cron-incomplete', dedupKey: 'daily-reminder', summary: 'x' }, NOW))
      .toEqual({ opened: false, emailed: false });
    expect(h.sends).toEqual([]);
  });

  it('an email failure is reported, never thrown', async () => {
    h.sendResult = { data: null, error: { message: 'rate limited' } };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(raiseAlertWithEmail({ tenantId: null, kind: 'k', summary: 'x' }, NOW)).resolves.toEqual({ opened: true, emailed: false });
    spy.mockRestore();
  });
});
