// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';

/**
 * feature-plan-cloud-export.md §11 T8 (the page GET states; a GET never presigns; the headers; the Sentry scrub), T9
 * (the POST), T10 (misconfiguration → support text plus the deduped alert; resolved on success), T23 (the IP limit before
 * any token lookup; the per-delivery limit after), and the presign module (no real AWS: the presigner and the Vercel
 * provider are mocked).
 */

const h = vi.hoisted(() => ({
  calls: [] as string[],
  row: null as null | Record<string, unknown>,
  allow: { exportDownloadIp: true, exportDownload: true } as Record<string, boolean>,
  presign: null as null | { ok: true; url: string } | { ok: false; reason: 'misconfigured' | 'error'; errorName?: string },
  tenantSlug: '' as string | Error,
  whereArgs: [] as unknown[],
  alerts: [] as Array<Record<string, unknown>>,
  getSignedUrl: vi.fn(),
  provider: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/db/control-plane', () => {
  const chain = {
    from: () => chain, innerJoin: () => chain, where: (c: unknown) => { h.whereArgs.push(c); return chain; },
    limit: async () => { h.calls.push('lookup'); return h.row ? [h.row] : []; },
    set: () => chain,
  };
  return {
    controlDb: {
      select: () => chain,
      update: () => ({ set: () => ({ where: async () => { h.calls.push('count'); } }) }),
    },
  };
});
vi.mock('@/db/control-plane/locked', () => ({ withLockedPool: async (fn: (db: unknown) => unknown) => fn({}) }));
vi.mock('@/lib/tenant/lifecycle-store', () => ({ resolveAlert: async (_db: unknown, a: { kind: string }) => { h.calls.push(`resolve:${a.kind}`); } }));
vi.mock('@/lib/tenant/ops-alert-email', () => ({ raiseAlertWithEmail: async (a: { kind: string }) => { h.calls.push(`alert:${a.kind}`); h.alerts.push(a); return { opened: true, emailed: true }; } }));
vi.mock('@/lib/rate-limit/store', () => ({
  consume: async (name: string, id: string) => { h.calls.push(`consume:${name}:${id}`); return { allowed: h.allow[name], retryAfterMs: 0, source: 'memory', resetAt: 0 }; },
}));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => { if (h.tenantSlug instanceof Error) throw h.tenantSlug; return h.tenantSlug; } }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { to }); } }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: h.getSignedUrl }));
vi.mock('@vercel/oidc-aws-credentials-provider', () => ({ awsCredentialsProvider: h.provider }));
vi.mock('@/server/actions/export-download', () => ({ prepareExportDownload: async () => ({ status: 'idle' }) }));

import { prepareDownload, readDeliveryByToken, TOKEN_RE } from '@/lib/export/delivery-access';
import { presignDeliveryUrl, __resetDownloadClientForTests } from '@/lib/export/download-url';
import { EXPIRED_TEXT } from '@/lib/export/format';
import { deepScrub, scrubString, FILTERED } from '@/lib/sentry-scrub';
import { PgDialect } from 'drizzle-orm/pg-core';
import ExportDownloadPage from '@/app/export/[token]/page';

const ROOT = path.resolve(__dirname, '../../..');
const TOKEN = 'Abc_-' + 'x'.repeat(38);
const NOW = new Date('2026-11-20T12:00:00Z');
const valid = (o: Record<string, unknown> = {}) => ({
  id: 'd1', s3Key: 'delivery/d1/acme-export-20261118.zip', bytes: 12_345_678, expiresAt: new Date('2026-11-25T12:00:00Z'), revokedAt: null, erasedAt: null,
  extraOnly: false, timeZone: 'America/Chicago', tenantName: 'Acme Corp', suspensionReason: null, policyExportAllowed: false, ...o,
});

beforeEach(() => {
  h.calls = [];
  h.row = valid();
  h.allow = { exportDownloadIp: true, exportDownload: true };
  h.tenantSlug = '';
  h.whereArgs = [];
  h.alerts = [];
  h.getSignedUrl.mockReset();
  h.provider.mockReset();
  h.provider.mockImplementation(() => async () => ({ accessKeyId: 'AKIA', secretAccessKey: 's', sessionToken: 't' }));
  h.getSignedUrl.mockResolvedValue('https://cadenzpoint-exports-1.s3.us-east-1.amazonaws.com/delivery/d1/acme.zip?X-Amz-Signature=sig');
  __resetDownloadClientForTests();
  process.env.EXPORT_DOWNLOAD_ROLE_ARN = 'arn:aws:iam::111122223333:role/cadenzpoint-backup/cadenzpoint-backup-export-download';
  process.env.EXPORT_BUCKET = 'cadenzpoint-exports-111122223333';
});

describe('T8: token states (GET)', () => {
  it('a malformed token is "unavailable" without a database read', async () => {
    for (const t of ['short', `${TOKEN}x`, TOKEN.replace('A', '.'), '', `${'a'.repeat(42)}=`]) {
      expect(await readDeliveryByToken(t, NOW)).toEqual({ state: 'unavailable' });
    }
    expect(h.calls).toEqual([]);
    expect(TOKEN_RE.test(TOKEN)).toBe(true);
  });

  it('valid; expired; revoked; erased; unknown', async () => {
    expect(await readDeliveryByToken(TOKEN, NOW)).toMatchObject({ state: 'valid', delivery: { deliveryId: 'd1', filename: 'acme-export-20261118.zip', tenantName: 'Acme Corp' } });
    for (const o of [{ expiresAt: new Date('2026-11-20T12:00:00Z') }, { revokedAt: NOW }, { erasedAt: NOW }]) {
      h.row = valid(o);
      expect(await readDeliveryByToken(TOKEN, NOW)).toEqual({ state: 'unavailable' });
    }
    h.row = null;
    expect(await readDeliveryByToken(TOKEN, NOW)).toEqual({ state: 'unavailable' });
  });

  it('A1: under a policy hold an extra_only=false delivery is unavailable (whatever the status); extra_only=true works; re-enabled export works', async () => {
    h.row = valid({ suspensionReason: 'policy', policyExportAllowed: false });
    expect((await readDeliveryByToken(TOKEN, NOW)).state).toBe('unavailable');
    h.row = valid({ suspensionReason: 'policy', policyExportAllowed: false, extraOnly: true });
    expect((await readDeliveryByToken(TOKEN, NOW)).state).toBe('valid');
    h.row = valid({ suspensionReason: 'policy', policyExportAllowed: true });
    expect((await readDeliveryByToken(TOKEN, NOW)).state).toBe('valid');
    h.row = valid({ suspensionReason: 'payment', policyExportAllowed: false });
    expect((await readDeliveryByToken(TOKEN, NOW)).state).toBe('valid');
  });
});

describe('T8: the page', () => {
  const render = async (token: string) => renderToStaticMarkup(<MantineProvider env="test">{await ExportDownloadPage({ params: Promise.resolve({ token }) })}</MantineProvider>);

  it('valid: the workspace, the size and the expiry in the stored zone, and the Prepare form (disabled without JavaScript); a GET never presigns', async () => {
    const html = await render(TOKEN);
    expect(html).toContain('Workspace export for <strong>Acme Corp</strong>');
    expect(html).toContain('11.8 MB');
    expect(html).toContain('November 25, 2026 at 6:00 AM CST');
    expect(html).toContain('Turn on JavaScript to download');
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain(`name="token" value="${TOKEN}"`);
    expect(h.getSignedUrl).not.toHaveBeenCalled();
    expect(h.provider).not.toHaveBeenCalled();
    expect(h.calls.filter((c) => c.startsWith('consume') || c === 'count')).toEqual([]);
  });

  it('expired, revoked, erased, unknown and malformed all show the same text', async () => {
    for (const row of [valid({ revokedAt: NOW }), null]) {
      h.row = row;
      expect(await render(TOKEN)).toContain(EXPIRED_TEXT);
    }
    expect(await render('not-a-token')).toContain(EXPIRED_TEXT);
  });

  it('a workspace host redirects to the apex page', async () => {
    h.tenantSlug = 'acme';
    process.env.NEXT_PUBLIC_APP_URL = 'https://cadenzpoint.example';
    await expect(render(TOKEN)).rejects.toMatchObject({ to: `https://cadenzpoint.example/export/${TOKEN}` });
    await expect(render('bad')).rejects.toMatchObject({ to: 'https://cadenzpoint.example/export/' });
  });

  it('T-5: getTenantSlug throwing (a host/header mismatch) also sends the visitor to the apex page', async () => {
    h.tenantSlug = new Error('host mismatch');
    process.env.NEXT_PUBLIC_APP_URL = 'https://cadenzpoint.example';
    await expect(render(TOKEN)).rejects.toMatchObject({ to: `https://cadenzpoint.example/export/${TOKEN}` });
    expect(h.calls).toEqual([]); // nothing read
  });

  it('metadata: no-referrer and noindex; force-dynamic', async () => {
    const mod = await import('@/app/export/[token]/page');
    expect(mod.metadata).toMatchObject({ referrer: 'no-referrer', robots: { index: false, follow: false } });
    expect(mod.dynamic).toBe('force-dynamic');
  });
});

describe('T9/T23: the POST', () => {
  it('T23: the IP limit is checked before any token lookup; refused there → no lookup at all', async () => {
    h.allow.exportDownloadIp = false;
    expect(await prepareDownload(TOKEN, '203.0.113.9', NOW)).toEqual({ status: 'rate-limited' });
    expect(h.calls).toEqual(['consume:exportDownloadIp:ip:203.0.113.9']);
  });

  it('T23: the per-delivery limit after the token check', async () => {
    h.allow.exportDownload = false;
    expect(await prepareDownload(TOKEN, '203.0.113.9', NOW)).toEqual({ status: 'rate-limited' });
    expect(h.calls).toEqual(['consume:exportDownloadIp:ip:203.0.113.9', 'lookup', 'consume:exportDownload:delivery:d1']);
    expect(h.getSignedUrl).not.toHaveBeenCalled();
  });

  it('T9: re-checks the token (expired → refused, no presign); valid → a 5-minute attachment URL, counted, the alert resolved', async () => {
    h.row = valid({ expiresAt: NOW });
    expect(await prepareDownload(TOKEN, '203.0.113.9', NOW)).toEqual({ status: 'unavailable' });
    expect(h.getSignedUrl).not.toHaveBeenCalled();
    h.row = valid();
    h.calls = [];
    const r = await prepareDownload(TOKEN, '203.0.113.9', NOW);
    expect(r).toEqual({ status: 'ready', url: expect.stringContaining('X-Amz-Signature') });
    expect(h.calls).toEqual(['consume:exportDownloadIp:ip:203.0.113.9', 'lookup', 'consume:exportDownload:delivery:d1', 'count', 'resolve:export-download-misconfigured']);
    const [, command, opts] = h.getSignedUrl.mock.calls[0];
    expect(opts).toEqual({ expiresIn: 300 });
    expect(command.input).toEqual({ Bucket: 'cadenzpoint-exports-111122223333', Key: 'delivery/d1/acme-export-20261118.zip', ResponseContentDisposition: 'attachment; filename="acme-export-20261118.zip"' });
    expect(h.provider).toHaveBeenCalledWith({ roleArn: process.env.EXPORT_DOWNLOAD_ROLE_ARN, clientConfig: { region: 'us-east-1' } });
    expect(h.provider.mock.calls[0][0]).not.toHaveProperty('audience');
  });
});

describe('T10: misconfiguration', () => {
  for (const [name, prep] of [
    ['EXPORT_DOWNLOAD_ROLE_ARN missing', () => { delete process.env.EXPORT_DOWNLOAD_ROLE_ARN; }],
    ['EXPORT_BUCKET missing', () => { process.env.EXPORT_BUCKET = ' '; }],
    ['an assume-role error', () => { h.getSignedUrl.mockRejectedValue(Object.assign(new Error('Not authorized to perform sts:AssumeRoleWithWebIdentity'), { name: 'AccessDenied' })); }],
    ['a presign error', () => { h.getSignedUrl.mockRejectedValue(new TypeError('bad')); }],
  ] as const) {
    it(`${name} → the support text and the immediate (deduped) alert; nothing counted`, async () => {
      prep();
      expect(await prepareDownload(TOKEN, '203.0.113.9', NOW)).toEqual({ status: 'misconfigured' });
      expect(h.calls).toContain('alert:export-download-misconfigured');
      expect(h.calls).not.toContain('count');
      expect(h.calls).not.toContain('resolve:export-download-misconfigured');
    });
  }

  it('T-3: EXPORT_DOWNLOAD_ROLE_ARN alone missing → misconfigured; the provider is never built; the alert says why', async () => {
    delete process.env.EXPORT_DOWNLOAD_ROLE_ARN;
    expect(await prepareDownload(TOKEN, '203.0.113.9', NOW)).toEqual({ status: 'misconfigured' });
    expect(h.provider).not.toHaveBeenCalled();
    expect(h.getSignedUrl).not.toHaveBeenCalled();
    expect(h.alerts).toEqual([expect.objectContaining({ tenantId: null, kind: 'export-download-misconfigured', detail: expect.objectContaining({ reason: 'misconfigured', deliveryId: 'd1' }) })]);
    expect(String(h.alerts[0].summary)).toContain('EXPORT_DOWNLOAD_ROLE_ARN');
  });

  it('with an env value missing the provider is never built (no CLI token refresh locally, D11)', async () => {
    delete process.env.EXPORT_BUCKET;
    expect(await presignDeliveryUrl('delivery/x/y.zip', 'y.zip')).toEqual({ ok: false, reason: 'misconfigured' });
    expect(h.provider).not.toHaveBeenCalled();
  });

  it('only a valid token can raise it (an expired link never alerts)', async () => {
    delete process.env.EXPORT_BUCKET;
    h.row = valid({ revokedAt: NOW });
    expect(await prepareDownload(TOKEN, '203.0.113.9', NOW)).toEqual({ status: 'unavailable' });
    expect(h.calls.some((c) => c.startsWith('alert:'))).toBe(false);
  });
});

describe('T8: headers and the Sentry scrub', () => {
  it('next.config: the /export/:path* entry comes after the global one, with no-store, no-referrer and noindex', async () => {
    const config = (await import('../../../next.config')).default as { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> };
    const entries = await config.headers();
    const i = entries.findIndex((e) => e.source === '/:path*');
    const j = entries.findIndex((e) => e.source === '/export/:path*');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThan(i);
    expect(entries[j].headers).toEqual([
      { key: 'Cache-Control', value: 'no-store' }, { key: 'Referrer-Policy', value: 'no-referrer' }, { key: 'X-Robots-Tag', value: 'noindex' },
    ]);
    expect(entries[i].headers.some((x) => x.key === 'Referrer-Policy')).toBe(true); // the last match wins for the same key
  });

  it('the scrub replaces the token in every string field, keys included, and leaves other strings and non-plain objects alone', () => {
    const url = `https://cadenzpoint.com/export/${TOKEN}`;
    const event = {
      request: { url, headers: { Referer: url } },
      transaction: `GET /export/${TOKEN}`,
      spans: [{ description: `POST /export/${TOKEN}`, data: { 'http.url': url, nested: [{ deep: url }] } }],
      breadcrumbs: [{ category: 'navigation', data: { from: url, to: '/' } }],
      tags: { [`/export/${TOKEN}`]: 'x' },
      extra: { when: new Date(0), plain: 'nothing here', other: '/export/short' },
    };
    const out = deepScrub(event);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.request.url).toBe('https://cadenzpoint.com/export/[token]');
    expect(out.extra.when).toBeInstanceOf(Date);
    expect(out.extra.other).toBe('/export/short');
    expect(JSON.stringify(event)).toContain(TOKEN); // a copy: the input isn't mutated
    const cyclic: Record<string, unknown> = { url };
    cyclic.self = cyclic;
    expect(() => deepScrub(cyclic)).not.toThrow();
    expect(scrubString(`a /export/${TOKEN} b /export/${TOKEN}`)).toBe('a /export/[token] b /export/[token]');
  });

  it('FR1 (a): the router-state, next-url and referer headers lose their values in request.headers and in span attributes (any case, - or _)', () => {
    // What Next sends with the "Prepare download" POST: the URL-encoded router tree, holding the BARE token.
    const tree = encodeURIComponent(JSON.stringify(['', { children: ['export', { children: [['token', TOKEN, 'd', null], { children: ['__PAGE__', {}, null, null] }, null, null] }, null, null] }, null, null, true]));
    expect(tree).toContain(TOKEN);
    const event = {
      request: { url: 'https://cadenzpoint.com/export/[token]', headers: { 'Next-Router-State-Tree': tree, 'next-url': `/export/${TOKEN}`, Referer: 'https://mail.example/inbox', accept: 'text/x-component' } },
      spans: [{ data: { 'http.request.header.next_router_state_tree': [tree], 'http.request.header.next-url': `/export/${TOKEN}`, 'http.request.header.referer': ['x'], 'http.request.header.accept': ['text/x-component'] } }],
      contexts: { trace: { data: { 'http.request.header.Next-Router-State-Tree': tree } } },
    };
    const out = deepScrub(event);
    expect(out.request.headers).toEqual({ 'Next-Router-State-Tree': FILTERED, 'next-url': FILTERED, Referer: FILTERED, accept: 'text/x-component' });
    expect(out.spans[0].data).toEqual({ 'http.request.header.next_router_state_tree': FILTERED, 'http.request.header.next-url': FILTERED, 'http.request.header.referer': FILTERED, 'http.request.header.accept': ['text/x-component'] });
    expect(out.contexts.trace.data['http.request.header.Next-Router-State-Tree']).toBe(FILTERED);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('FR1 (b): defence in depth in every string and key: the decoded tree, the URL-encoded path and quoted forms, a standalone token', () => {
    const encodedTree = encodeURIComponent(JSON.stringify([['token', TOKEN, 'd', null]]));
    const event = {
      extra: { decoded: JSON.stringify(['token', TOKEN, 'd', null]), encodedPath: `https%3A%2F%2Fcadenzpoint.com%2Fexport%2F${TOKEN}`, encodedTree, bare: TOKEN, [TOKEN]: 'as a key' },
      message: `state ${TOKEN}.`,
    };
    const out = deepScrub(event);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.extra.bare).toBe('[token]');
    expect(out.extra.encodedPath).toBe('https%3A%2F%2Fcadenzpoint.com/export/[token]');
    // A 42- or 44-character run isn't the token's shape and is left alone.
    expect(scrubString('a'.repeat(42))).toBe('a'.repeat(42));
    expect(scrubString('a'.repeat(44))).toBe('a'.repeat(44));
  });

  it('all three Sentry inits wire the scrub into beforeSend, beforeSendTransaction and beforeBreadcrumb', () => {
    for (const f of ['sentry.server.config.ts', 'sentry.edge.config.ts', 'src/instrumentation-client.ts']) {
      const text = readFileSync(path.join(ROOT, f), 'utf8');
      expect(text, f).toMatch(/beforeSend: scrubEvent,/);
      expect(text, f).toMatch(/beforeSendTransaction: scrubEvent,/);
      expect(text, f).toMatch(/beforeBreadcrumb: scrubBreadcrumb,/);
    }
  });

  it('T-2: the lookup uses sha256(token) as its parameter, never the plain token (the task stores the same hash)', async () => {
    await readDeliveryByToken(TOKEN, NOW);
    const { params } = new PgDialect().sqlToQuery(h.whereArgs[0] as Parameters<PgDialect['sqlToQuery']>[0]);
    expect(params).toEqual([createHash('sha256').update(TOKEN).digest('hex')]);
    expect(JSON.stringify(params)).not.toContain(TOKEN);
  });
});
