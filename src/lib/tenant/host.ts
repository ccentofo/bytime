/**
 * Pure tenant-host parsing, shared by the proxy (request entry) and the request-context
 * resolver. No 'server-only' and no next/* imports so it is unit-testable and importable
 * anywhere on the server.
 */
const ROOT_DOMAIN = process.env.APP_ROOT_DOMAIN ?? 'localhost';
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'static', 'assets']);

/** Extract the tenant subdomain label from a Host header, or null for apex/reserved. */
export function tenantFromHost(host: string | null): string | null {
  if (!host) return null;
  const hostname = host.split(':')[0]; // strip port
  if (hostname === ROOT_DOMAIN || hostname === `www.${ROOT_DOMAIN}`) return null;
  if (!hostname.endsWith(`.${ROOT_DOMAIN}`)) return null; // not a tenant host
  const label = hostname.slice(0, -1 * `.${ROOT_DOMAIN}`.length);
  if (!label || RESERVED.has(label) || label.includes('.')) return null;
  return label;
}

/** The inverse of tenantFromHost: a tenant's full base URL, for links in emails and redirects. */
export function tenantBaseUrl(slug: string): string {
  const apexUrl = new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000');
  return `${apexUrl.protocol}//${slug}.${ROOT_DOMAIN}${apexUrl.port ? `:${apexUrl.port}` : ''}`;
}

/** The workspace root domain (server-side value of APP_ROOT_DOMAIN), e.g. for "your-company.<root>" hints. */
export function rootDomain(): string {
  return ROOT_DOMAIN;
}

/** The apex (marketing/signup) base URL, without a trailing slash. */
export function apexBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}
