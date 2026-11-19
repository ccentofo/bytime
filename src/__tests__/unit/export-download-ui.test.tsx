// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';

/**
 * feature-plan-cloud-export.md §6.6, audit round 1: T-1 (the action passes the REAL client IP and the token to the rules)
 * and T-4 (the Prepare form's rendered states: ready with the Download link, rate-limited, misconfigured, unavailable).
 */

const h = vi.hoisted(() => ({
  prepared: [] as Array<[string, string]>,
  headers: new Headers(),
  state: { status: 'idle' } as Record<string, unknown>,
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => h.headers }));
vi.mock('@/lib/export/delivery-access', () => ({
  prepareDownload: async (token: string, ip: string) => { h.prepared.push([token, ip]); return { status: 'unavailable' }; },
}));
vi.mock('react', async (orig) => {
  const real = await orig<typeof import('react')>();
  return { ...real, default: real, useActionState: () => [h.state, () => {}, false] };
});

import { prepareExportDownload } from '@/server/actions/export-download';
import { PrepareDownload } from '@/app/export/[token]/PrepareDownload';
import { EXPIRED_TEXT } from '@/lib/export/format';

const TOKEN = 'T'.repeat(43);
const form = (token: string) => { const f = new FormData(); f.set('token', token); return f; };
const render = () => renderToStaticMarkup(<MantineProvider env="test"><PrepareDownload token={TOKEN} /></MantineProvider>);

beforeEach(() => {
  h.prepared = [];
  h.state = { status: 'idle' };
});

describe('T-1: the action wrapper', () => {
  it('passes the form\'s token and the client IP from x-forwarded-for (first hop) to prepareDownload', async () => {
    h.headers = new Headers({ 'x-forwarded-for': '198.51.100.23, 10.0.0.1' });
    expect(await prepareExportDownload({ status: 'idle' }, form(TOKEN))).toEqual({ status: 'unavailable' });
    h.headers = new Headers({ 'x-forwarded-for': '203.0.113.77' });
    await prepareExportDownload({ status: 'idle' }, form(`${TOKEN.slice(1)}x`));
    expect(h.prepared).toEqual([[TOKEN, '198.51.100.23'], [`${TOKEN.slice(1)}x`, '203.0.113.77']]);
  });
});

describe('T-4: the Prepare form\'s states', () => {
  it('idle: the token in a hidden field; server-rendered (no JavaScript) the button is disabled and says so', () => {
    const html = render();
    expect(html).toContain(`name="token" value="${TOKEN}"`);
    expect(html).toContain('Turn on JavaScript to download');
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it('ready: a plain Download link to the URL with rel="noreferrer", and "valid for 5 minutes"', () => {
    h.state = { status: 'ready', url: 'https://s3.example/delivery/d1/a.zip?X-Amz-Signature=abc&X-Amz-Expires=300' };
    const html = render();
    expect(html).toMatch(/<a[^>]*href="https:\/\/s3\.example\/delivery\/d1\/a\.zip\?X-Amz-Signature=abc&amp;X-Amz-Expires=300"[^>]*>/);
    expect(html).toMatch(/<a[^>]*rel="noreferrer"[^>]*>[\s\S]*?Download/);
    expect(html).toContain('valid for 5 minutes');
    expect(html).toContain('prepare it again');
  });

  it('rate-limited, misconfigured and unavailable each show their text', () => {
    h.state = { status: 'rate-limited' };
    expect(render()).toContain('Too many download attempts. Try again later.');
    h.state = { status: 'misconfigured' };
    expect(render()).toContain('Downloads aren&#x27;t available right now. Contact support@cadenzpoint.com.');
    h.state = { status: 'unavailable' };
    const html = render();
    expect(html).toContain(EXPIRED_TEXT);
    expect(html).not.toContain('name="token"');
  });
});
