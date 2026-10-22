import * as Sentry from '@sentry/nextjs';
import { getDbForUrl } from '@/db';
import { apiKeys, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit';
import { getTenantState } from '@/lib/tenant/context';
import type { TenantRecord } from '@/lib/tenant/registry';

const API_RATE_LIMIT = 100;          // requests per minute per key
const API_RATE_WINDOW = 60 * 1000;   // 1 minute

export interface ApiKeyInfo {
  id: string;
  name: string;
  permissions: string;
  createdByUserId: string;
}

/**
 * The ONE response for every authentication failure (feature-plan-launch-blockers.md P4 §6): missing header, bad
 * format, bad prefix, unknown or closed workspace, unknown key. Identical body and header, so an unauthenticated caller
 * can never learn whether a workspace exists or is suspended. (Usage help lives in the API docs.)
 */
export function invalidApiKeyResponse(): Response {
  return new Response(JSON.stringify({ error: 'Invalid API key.' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
  });
}

/**
 * Validate the request's API key against the given tenant's database. Never calls getDb() — the caller resolved the
 * tenant first. Returns the key info, or a Response to send.
 */
export async function validateApiKey(request: Request, tenant: Pick<TenantRecord, 'dbUrl'>): Promise<ApiKeyInfo | Response> {
  const authHeader = request.headers.get('Authorization');
  const parts = authHeader?.split(' ') ?? [];
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1].startsWith('byt_')) {
    return invalidApiKeyResponse();
  }

  const keyHash = crypto.createHash('sha256').update(parts[1]).digest('hex');
  const db = getDbForUrl(tenant.dbUrl);

  // R2-12: join the creator's CURRENT role/active status — a key created by an admin who has
  // since been demoted or deactivated must stop working immediately, not keep the access level
  // they had at creation time.
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      permissions: apiKeys.permissions,
      createdByUserId: apiKeys.createdByUserId,
      isActive: apiKeys.isActive,
      expiresAt: apiKeys.expiresAt,
      creatorRole: users.role,
      creatorIsActive: users.isActive,
    })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.createdByUserId, users.id))
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);

  if (rows.length === 0) return invalidApiKeyResponse();

  const key = rows[0];

  // These need the real (former) key, so they reveal nothing to an unauthenticated caller.
  if (!key.isActive) {
    return new Response(
      JSON.stringify({ error: 'API key has been revoked.' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
    return new Response(
      JSON.stringify({ error: 'API key has expired.' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!key.creatorIsActive || key.creatorRole !== 'admin') {
    return new Response(
      JSON.stringify({ error: 'This API key\'s creator is no longer an active admin.' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Update lastUsedAt (fire-and-forget). Credential bookkeeping, not business data.
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id))
    .then(() => {}, () => {});

  // Also rate limit per API key (not just IP)
  const keyRateResult = checkRateLimit(`apikey:${key.id}`, API_RATE_LIMIT, API_RATE_WINDOW);
  if (!keyRateResult.allowed) {
    return rateLimitResponse(keyRateResult.retryAfterMs);
  }

  return {
    id: key.id,
    name: key.name,
    permissions: key.permissions,
    createdByUserId: key.createdByUserId,
  };
}

/**
 * Authenticate a v1 API request, in the order that keeps workspace state private:
 * rate limit → workspace exists and is open (else the identical 401) → valid key (else the identical 401) →
 * ONLY THEN billing_only / policy_hold → 403 workspace_unavailable (data reads are allowed only in full/read_only).
 */
async function authenticateApiRequest(request: Request): Promise<{ key: ApiKeyInfo; tenant: TenantRecord } | Response> {
  const ip = getClientIp(request);
  const rateResult = checkRateLimit(`api:${ip}`, API_RATE_LIMIT, API_RATE_WINDOW);
  if (!rateResult.allowed) return rateLimitResponse(rateResult.retryAfterMs);

  const state = await getTenantState();
  if (state.kind !== 'full' && state.kind !== 'read_only' && state.kind !== 'billing_only' && state.kind !== 'policy_hold') {
    return invalidApiKeyResponse(); // none / unknown / closed / provisioning / mismatch
  }

  const key = await validateApiKey(request, state.tenant);
  if (key instanceof Response) return key;

  if (state.kind === 'billing_only' || state.kind === 'policy_hold') {
    return new Response(JSON.stringify({ error: 'workspace_unavailable' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return { key, tenant: state.tenant };
}

/**
 * Run a v1 API route: authentication and the handler inside ONE try, so nothing (including a database failure while
 * authenticating) can escape as an unhandled 500 that differs by workspace. Unexpected errors → generic 500, logged
 * and reported.
 */
export async function handleApiRequest(
  request: Request,
  handler: (ctx: { key: ApiKeyInfo; tenant: TenantRecord }) => Promise<Response>,
): Promise<Response> {
  try {
    const auth = await authenticateApiRequest(request);
    if (auth instanceof Response) return auth;
    return await handler(auth);
  } catch (err) {
    console.error('v1 API request failed:', err);
    Sentry.captureException(err);
    return apiError('Internal server error', 500);
  }
}

/**
 * Create a JSON API response with the standard envelope format.
 */
export function apiResponse(data: unknown, meta?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      data,
      meta: {
        timestamp: new Date().toISOString(),
        ...meta,
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

/**
 * Create a JSON API error response.
 */
export function apiError(message: string, status: number = 400): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}
