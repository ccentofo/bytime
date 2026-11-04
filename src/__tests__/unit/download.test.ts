// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * feature-plan-ux-page-fixes.md C15 / T-C15a: downloadFile — the filename from Content-Disposition (RFC 5987
 * `filename*`, a malformed escape falling back, the quoted form, none); the status → message map, incl. 429's
 * `retryAfter` and the Retry-After header fallback; a non-JSON 500 → the generic message; a network error.
 */

import { downloadFile, downloadErrorMessage, filenameFromDisposition, saveBlob } from '@/lib/download';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const response = (status: number, body: BodyInit | null, headers: Record<string, string> = {}) => new Response(body, { status, headers });
const stubFetch = (impl: () => Promise<Response>) => { const f = vi.fn(impl); vi.stubGlobal('fetch', f); return f; };

describe('filenameFromDisposition', () => {
  it('filename* (RFC 5987) wins and is decoded', () => {
    expect(filenameFromDisposition(`attachment; filename="timesheet-Zo_.pdf"; filename*=UTF-8''timesheet-Zo%C3%AB-%22Z%22-O%27Brien.pdf`, 'f.pdf'))
      .toBe(`timesheet-Zoë-"Z"-O'Brien.pdf`);
  });
  it('a malformed %-escape in filename* falls back to the quoted filename', () => {
    expect(filenameFromDisposition(`attachment; filename="plain.pdf"; filename*=UTF-8''bad%E0%A4%A.pdf`, 'f.pdf')).toBe('plain.pdf');
  });
  it('the quoted form; then the fallback when there is none', () => {
    expect(filenameFromDisposition('attachment; filename="cost-report-2026-01-01-to-2026-01-31.csv"', 'f.csv')).toBe('cost-report-2026-01-01-to-2026-01-31.csv');
    expect(filenameFromDisposition('attachment', 'f.csv')).toBe('f.csv');
    expect(filenameFromDisposition(null, 'f.csv')).toBe('f.csv');
  });
});

describe('downloadErrorMessage', () => {
  it('maps each status', () => {
    expect(downloadErrorMessage(400, null)).toBe('Check the dates and try again.');
    expect(downloadErrorMessage(401, null)).toBe('Your session has expired. Sign in again.');
    expect(downloadErrorMessage(403, null)).toBe("You don't have access to this report.");
    expect(downloadErrorMessage(404, null)).toBe("That employee wasn't found.");
    expect(downloadErrorMessage(429, 42)).toBe('Too many downloads. Try again in 42 seconds.');
    expect(downloadErrorMessage(429, null)).toBe('Too many downloads. Try again in 60 seconds.');
    expect(downloadErrorMessage(500, null)).toBe("The report couldn't be generated. Try again in a moment.");
  });
});

describe('downloadFile', () => {
  it('429: retryAfter from the JSON body, else the Retry-After header', async () => {
    stubFetch(async () => response(429, JSON.stringify({ error: 'Too many requests', retryAfter: 37 }), { 'content-type': 'application/json', 'retry-after': '50' }));
    expect(await downloadFile('/api/reports/x', 'x.pdf')).toEqual({ ok: false, error: 'Too many downloads. Try again in 37 seconds.' });
    stubFetch(async () => response(429, 'slow down', { 'content-type': 'text/plain', 'retry-after': '50' }));
    expect(await downloadFile('/api/reports/x', 'x.pdf')).toEqual({ ok: false, error: 'Too many downloads. Try again in 50 seconds.' });
  });

  it('a non-JSON 500 (an HTML error page) → the generic message, never a throw', async () => {
    stubFetch(async () => response(500, '<html>Internal Server Error</html>', { 'content-type': 'text/html' }));
    expect(await downloadFile('/api/reports/x', 'x.pdf')).toEqual({ ok: false, error: "The report couldn't be generated. Try again in a moment." });
  });

  it('a network error → "Couldn\'t reach the server…"', async () => {
    stubFetch(async () => { throw new TypeError('Failed to fetch'); });
    expect(await downloadFile('/api/reports/x', 'x.pdf')).toEqual({ ok: false, error: "Couldn't reach the server. Check your connection and try again." });
  });

  it('ok: fetches same-origin, downloads with the header\'s name through an anchor appended to document.body', async () => {
    const f = stubFetch(async () => response(200, 'pdf-bytes', { 'content-disposition': `attachment; filename="a.pdf"; filename*=UTF-8''Zo%C3%AB.pdf` }));
    const created = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: created, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { expect(this.isConnected).toBe(true); });
    expect(await downloadFile('/api/reports/x', 'fallback.pdf')).toEqual({ ok: true });
    const clicked = click.mock.contexts[0] as HTMLAnchorElement;
    expect(f).toHaveBeenCalledWith('/api/reports/x', { credentials: 'same-origin' });
    expect(clicked.download).toBe('Zoë.pdf');
    expect(clicked.isConnected).toBe(false);          // removed after the click
  });
});

// feature-plan-ux-kit-contracts.md §3.9, R4 ---------------------------------------------------------------------------
describe('downloadFile: 422 and per-status messages (kit §3.9)', () => {
  it('a 422 shows the route\'s JSON error in place; a non-JSON 422 falls back to the generic message', async () => {
    stubFetch(async () => response(422, JSON.stringify({ error: 'No hours recorded between Oct 16 – 31, 2026.' }), { 'content-type': 'application/json' }));
    expect(await downloadFile('/api/x', 'x.xlsx')).toEqual({ ok: false, error: 'No hours recorded between Oct 16 – 31, 2026.' });
    stubFetch(async () => response(422, '<html>oops</html>', { 'content-type': 'text/html' }));
    expect(await downloadFile('/api/x', 'x.xlsx')).toEqual({ ok: false, error: downloadErrorMessage(500, null) });
  });

  it('opts.messages overrides a status\'s standard copy', async () => {
    stubFetch(async () => response(404, JSON.stringify({ error: 'nope' }), { 'content-type': 'application/json' }));
    expect(await downloadFile('/api/x', 'x.pdf', { messages: { 404: 'No such timesheet.' } })).toEqual({ ok: false, error: 'No such timesheet.' });
    stubFetch(async () => response(403, null));
    expect(await downloadFile('/api/x', 'x.pdf', { messages: { 404: 'x' } })).toEqual({ ok: false, error: downloadErrorMessage(403, null) });
  });

  it('saveBlob clicks an anchor attached to the body, then removes it', () => {
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => 'blob:y', revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { expect(this.isConnected).toBe(true); });
    saveBlob(new Blob(['a']), 'file.csv');
    const a = click.mock.contexts[0] as HTMLAnchorElement;
    expect(a.download).toBe('file.csv');
    expect(a.isConnected).toBe(false);
  });
});

