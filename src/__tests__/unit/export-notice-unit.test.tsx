import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('server-only', () => ({}));

import { ExportReadyEmail } from '@/lib/email/templates/export-ready';
import { fmtDateTime, redactExportPayload, LINK_REMOVED } from '@/lib/tenant/notices';
import { isNoticeSuperseded, type LifecycleFacts } from '@/lib/tenant/lifecycle';

/**
 * feature-plan-cloud-export.md §11 T7 (unit half): the isNoticeSuperseded backstop (before the deleting/deleted line), the
 * template's text, `fmtDateTime` in the stored zone, the redaction, and the static exclusions (set-exempt, register-tenant).
 */
const ROOT = path.resolve(__dirname, '../../..');
const TOKEN = 'A'.repeat(20) + '_-' + 'b'.repeat(21);

describe('T7 (unit): export-ready', () => {
  it('isNoticeSuperseded returns false for export-ready, even for a deleting or deleted workspace', () => {
    for (const status of ['active', 'suspended', 'deleting', 'deleted'] as const) {
      expect(isNoticeSuperseded('export-ready', new Date(), { status } as unknown as LifecycleFacts, new Date()), status).toBe(false);
    }
    expect(isNoticeSuperseded('trial-ended', new Date(), { status: 'deleted' } as unknown as LifecycleFacts, new Date())).toBe(true);
  });

  it('the email: the heading, the workspace name, the link, the expiry, the support line', () => {
    const link = `https://cadenzpoint.com/export/${TOKEN}`;
    const html = renderToStaticMarkup(<ExportReadyEmail tenantName="Acme" link={link} worksUntilFormatted="November 25, 2026, 3:04 PM CST" />);
    expect(html).toContain('Your CadenzPoint workspace export is ready');
    expect(html).toContain('<strong>Acme</strong>');
    expect(html).toContain(`href="${link}"`);
    expect(html).toContain('<strong>November 25, 2026, 3:04 PM CST</strong>');
    expect(html).toContain('support@cadenzpoint.com');
  });

  it('fmtDateTime: the date and time in the stored zone', () => {
    const at = new Date('2026-11-25T21:04:00Z');
    expect(fmtDateTime(at, 'America/Chicago')).toBe('November 25, 2026 at 3:04 PM CST');
    expect(fmtDateTime(at, 'Europe/London')).toBe('November 25, 2026 at 9:04 PM GMT');
  });

  it('redactExportPayload removes every copy of the token; null and non-html payloads pass through', () => {
    const p = { to: ['a@b.c'], subject: 's', html: `<a href="https://x/export/${TOKEN}">https://x/export/${TOKEN}</a>`, stated: {} };
    const r = redactExportPayload(p);
    expect(r.html).not.toContain(TOKEN);
    expect(r.html.split(`/export/${LINK_REMOVED}`).length - 1).toBe(2);
    expect(redactExportPayload(null)).toBeNull();
  });

  it('set-exempt and register-tenant exclude export-ready from their blanket supersedes', () => {
    expect(readFileSync(path.join(ROOT, 'src/lib/tenant/admin-commands.ts'), 'utf8')).toMatch(/ne\(tenantNotices\.kind, 'export-ready'\)/);
    expect(readFileSync(path.join(ROOT, 'scripts/register-tenant.ts'), 'utf8')).toMatch(/and kind <> 'export-ready'/);
  });
});
