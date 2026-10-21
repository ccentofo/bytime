import { getDb } from '@/db';
import { apiKeys, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit';

const API_RATE_LIMIT = 100;          // requests per minute per key
const API_RATE_WINDOW = 60 * 1000;   // 1 minute

export interface ApiKeyInfo {
  id: string;
  name: string;
  permissions: string;
  createdByUserId: string;
}

/**
 * Validate an API key from the request Authorization header.
 * Returns the key info if valid, or a Response object if invalid.
 */
export async function validateApiKey(request: Request): Promise<ApiKeyInfo | Response> {
  const db = await getDb();
  // Check rate limit first (by IP)
  const ip = getClientIp(request);
  const rateResult = checkRateLimit(`api:${ip}`, API_RATE_LIMIT, API_RATE_WINDOW);
  if (!rateResult.allowed) {
    return rateLimitResponse(rateResult.retryAfterMs);
  }

  // Extract API key from Authorization header
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    return new Response(
      JSON.stringify({ error: 'Missing Authorization header. Use: Authorization: Bearer byt_...' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return new Response(
      JSON.stringify({ error: 'Invalid Authorization format. Use: Authorization: Bearer byt_...' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const apiKey = parts[1];
  if (!apiKey.startsWith('byt_')) {
    return new Response(
      JSON.stringify({ error: 'Invalid API key format.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Hash the provided key and look it up
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

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

  if (rows.length === 0) {
    return new Response(
      JSON.stringify({ error: 'Invalid API key.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const key = rows[0];

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

  // Update lastUsedAt (fire-and-forget)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id))
    .then(() => {})
    .catch(() => {});

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
