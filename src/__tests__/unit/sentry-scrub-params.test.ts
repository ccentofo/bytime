import { describe, it, expect } from 'vitest';
import { deepScrub, scrubBreadcrumb, scrubEvent, scrubString, FILTERED } from '@/lib/sentry-scrub';

/**
 * SWEEP-FINDINGS.md A1-D1: set-password, password-reset and signup-verify links carry a 64-hex token and the email in
 * the page address (`/reset-password?token=…&email=…&welcome=1` takes over a new workspace's admin for 72 hours), and
 * OAuth callbacks carry `code` and `state`. The scrub filters the value of `token`, any `*token` name, `email`, `code`
 * and `state` after `?`, `&` or `#`, plain or URL-encoded, wherever a string reaches Sentry. A1-G25: null-prototype
 * objects are scrubbed like plain ones. The export-token cases stay in export-download-unit.test.tsx.
 */

const HEX = 'f'.repeat(16) + '0123456789abcdef'.repeat(3); // 64 hex characters
const RESET = `https://acme.cadenzpoint.com/reset-password?token=${HEX}&email=jane%40acme.com`;
const SET_PASSWORD = `https://acme.cadenzpoint.com/reset-password?token=${HEX}&email=owner%40acme.com&welcome=1`;
const VERIFY = `https://cadenzpoint.com/signup/verify?token=${HEX}&email=owner@acme.com`;
const OAUTH = 'https://acme.cadenzpoint.com/api/integrations/callback/quickbooks?code=AB11-secret&state=st4te-value&realmId=9130';

const leaks = (s: string) => [HEX, 'jane', 'owner', 'AB11-secret', 'st4te-value', 'AT-secret', 'ID-secret', 'RT-secret'].filter((x) => s.includes(x));

describe('A1-D1: secret and personal query parameters are filtered', () => {
  it('a reset, a set-password, a verify and an OAuth URL keep their shape, lose only the values', () => {
    expect(scrubString(RESET)).toBe(`https://acme.cadenzpoint.com/reset-password?token=${FILTERED}&email=${FILTERED}`);
    expect(scrubString(SET_PASSWORD)).toBe(`https://acme.cadenzpoint.com/reset-password?token=${FILTERED}&email=${FILTERED}&welcome=1`);
    expect(scrubString(VERIFY)).toBe(`https://cadenzpoint.com/signup/verify?token=${FILTERED}&email=${FILTERED}`);
    expect(scrubString(OAUTH)).toBe(`https://acme.cadenzpoint.com/api/integrations/callback/quickbooks?code=${FILTERED}&state=${FILTERED}&realmId=9130`);
  });

  it('any name ending in "token", any case, and the fragment form', () => {
    expect(scrubString('/cb?access_token=AT-secret&id_token=ID-secret&Refresh_Token=RT-secret&page=2'))
      .toBe(`/cb?access_token=${FILTERED}&id_token=${FILTERED}&Refresh_Token=${FILTERED}&page=2`);
    expect(scrubString('/cb#access_token=AT-secret&state=st4te-value')).toBe(`/cb#access_token=${FILTERED}&state=${FILTERED}`);
    expect(scrubString('/x?TOKEN=abc&EMAIL=a@b.c')).toBe(`/x?TOKEN=${FILTERED}&EMAIL=${FILTERED}`);
  });

  it('URL-encoded forms (%3F, %26, %23 with = or %3D) are filtered too', () => {
    const encoded = encodeURIComponent(SET_PASSWORD); // …reset-password%3Ftoken%3D<hex>%26email%3Downer%2540acme.com%26welcome%3D1
    const out = scrubString(`/login?next=${encoded}`);
    expect(leaks(out)).toEqual([]);
    expect(out).toContain(`%3Ftoken%3D${FILTERED}%26email%3D${FILTERED}%26welcome%3D1`);
    expect(scrubString('/a?next=%2Fcb%23access_token%3DAT-secret%26x%3D1')).toBe(`/a?next=%2Fcb%23access_token%3D${FILTERED}%26x%3D1`);
    expect(scrubString('/a%3fcode=AB11-secret')).toBe(`/a%3fcode=${FILTERED}`);
  });

  it('other parameters and look-alike names are left alone', () => {
    expect(scrubString('/r?welcome=1&page=2&zipcode=21201&statement=x&emailed=yes')).toBe('/r?welcome=1&page=2&zipcode=21201&statement=x&emailed=yes');
    expect(scrubString('token=abc without a separator')).toBe('token=abc without a separator');
  });

  it('the value ends at a quote or whitespace (a URL inside a message or JSON)', () => {
    expect(scrubString(`GET "${RESET}" 200`)).toBe(`GET "https://acme.cadenzpoint.com/reset-password?token=${FILTERED}&email=${FILTERED}" 200`);
  });

  it('in request.url, a breadcrumb and a span, through the hooks Sentry calls', () => {
    const event = scrubEvent({
      request: { url: SET_PASSWORD, query_string: `token=${HEX}&email=owner%40acme.com`, headers: { host: 'acme.cadenzpoint.com' } },
      breadcrumbs: [{ category: 'navigation', data: { from: '/', to: RESET } }],
      spans: [{ description: `GET ${VERIFY}`, data: { 'http.url': OAUTH, 'url.full': RESET } }],
    });
    expect(leaks(JSON.stringify(event))).toEqual([]);
    expect(event.request.url).toBe(`https://acme.cadenzpoint.com/reset-password?token=${FILTERED}&email=${FILTERED}&welcome=1`);
    expect(event.request.query_string).toBe(`token=${FILTERED}&email=${FILTERED}`); // Sentry's query has no leading "?"
    expect(event.request.headers.host).toBe('acme.cadenzpoint.com');
    const crumb = scrubBreadcrumb({ category: 'fetch', data: { url: VERIFY, method: 'GET', status_code: 200 } });
    expect(crumb.data.url).toBe(`https://cadenzpoint.com/signup/verify?token=${FILTERED}&email=${FILTERED}`);
    expect(crumb.data.status_code).toBe(200);
  });
});

describe('A1-G25: null-prototype objects are scrubbed like plain objects', () => {
  it('nested null-prototype objects (as some parsers produce) lose tokens and sensitive headers', () => {
    const headers = Object.assign(Object.create(null), { referer: RESET, accept: 'text/html' });
    const request = Object.assign(Object.create(null), { url: SET_PASSWORD, headers });
    const out = deepScrub({ request }) as { request: { url: string; headers: Record<string, string> } };
    expect(out.request.url).toBe(`https://acme.cadenzpoint.com/reset-password?token=${FILTERED}&email=${FILTERED}&welcome=1`);
    expect(out.request.headers.referer).toBe(FILTERED);
    expect(out.request.headers.accept).toBe('text/html');
    expect(leaks(JSON.stringify(out))).toEqual([]);
  });

  it('the export token inside a null-prototype object is replaced', () => {
    const tok = 'A'.repeat(43);
    const o = Object.assign(Object.create(null), { path: `/export/${tok}` });
    expect((deepScrub(o) as { path: string }).path).toBe('/export/[token]');
  });
});
