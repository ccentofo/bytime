import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { CredentialsSignin } from '@auth/core/errors';
import type { JWT } from '@auth/core/jwt';
import bcrypt from 'bcryptjs';
import { getLockoutInfo, recordFailedAttempt, recordSuccessfulLogin } from '@/server/internal/login-attempts';
import { getDbForUrl, getDbForAuth } from '@/db';
import { getTenantBySlug } from '@/lib/tenant/registry';
import { getTenantAccess } from '@/lib/tenant/lifecycle';
import { users } from '@/db/schema';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { decrypt, encrypt } from '@/lib/encryption';
import { getTOTPStep, verifyRecoveryCode } from '@/lib/totp';

/** Thrown from authorize() when the account has MFA enabled and no code was submitted yet.
 *  No session is issued — the client re-submits with mfaCode once the user enters one. */
class MFARequiredSignin extends CredentialsSignin {
  code = 'mfa_required';
}

/** Thrown from authorize() when an MFA code (TOTP or recovery) was submitted but is invalid. */
class MFAInvalidSignin extends CredentialsSignin {
  code = 'mfa_invalid';
}

/**
 * Credentials provider authorize logic, extracted to a standalone function so it can be
 * exercised directly in integration tests without driving the full NextAuth request stack.
 * Behavior is unchanged from when this lived inline in the Credentials provider config.
 */
export async function authorizeCredentials(credentials: Record<string, unknown> | undefined) {
  if (!credentials?.email || !credentials?.password) return null;

  const email = (credentials.email as string).toLowerCase().trim();
  const password = credentials.password as string;
  const mfaCode = (credentials.mfaCode as string | undefined)?.trim();

  // Check if the account is locked out
  const lockoutInfo = await getLockoutInfo(email);
  if (lockoutInfo?.isLocked) {
    return null;
  }

  // Use suspended-tolerant DB resolver so suspended admins can still log in
  // and reach the billing wall. getDb() stays strict everywhere else.
  let user: typeof users.$inferSelect | null = null;
  try {
    const db = await getDbForAuth();
    const rows = await db.select().from(users).where(eq(users.email, email));
    user = rows[0] ?? null;
  } catch {
    // Workspace not found / deleting / other error — treat as bad credentials
    await recordFailedAttempt(email);
    return null;
  }
  if (!user || !user.passwordHash || !user.isActive) {
    await recordFailedAttempt(email);
    return null;
  }

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    await recordFailedAttempt(email);
    return null;
  }

  // MFA gate — no session is issued until both factors pass.
  if (user.totpEnabled) {
    if (!mfaCode) {
      throw new MFARequiredSignin();
    }

    let mfaValid = false;
    if (user.totpSecret) {
      // R2-12: reject a code whose time-step has already been accepted — otherwise the same
      // code is valid for its whole window and could be replayed (e.g. captured in a log).
      // The compare-and-set is one conditional UPDATE, so two concurrent sign-ins with the same
      // code can't both succeed: only the first one matches the WHERE clause.
      const step = getTOTPStep(decrypt(user.totpSecret), mfaCode);
      if (step !== null) {
        const db = await getDbForAuth();
        const claimed = await db.update(users)
          .set({ totpLastUsedStep: step, updatedAt: new Date() })
          .where(and(eq(users.id, user.id), or(isNull(users.totpLastUsedStep), lt(users.totpLastUsedStep, step))))
          .returning({ id: users.id });
        mfaValid = claimed.length > 0;
      }
    }

    if (!mfaValid && user.totpRecoveryCodes) {
      // Single use under concurrency (feature-plan-launch-blockers.md P3): lock the user row, re-read the codes,
      // verify and remove the used one in ONE transaction. A concurrent sign-in with the same code waits on the
      // row lock, then re-reads the remaining codes and no longer finds it.
      const db = await getDbForAuth();
      const userId = user.id;
      mfaValid = await db.transaction(async (tx) => {
        const [row] = await tx.select({ codes: users.totpRecoveryCodes }).from(users)
          .where(eq(users.id, userId)).for('update');
        if (!row?.codes) return false;
        const hashedCodes: string[] = JSON.parse(decrypt(row.codes));
        const matchIndex = verifyRecoveryCode(mfaCode, hashedCodes);
        if (matchIndex === -1) return false;
        hashedCodes.splice(matchIndex, 1);
        await tx.update(users)
          .set({ totpRecoveryCodes: encrypt(JSON.stringify(hashedCodes)), updatedAt: new Date() })
          .where(eq(users.id, userId));
        return true;
      });
    }

    if (!mfaValid) {
      await recordFailedAttempt(email); // counts toward lockout, same as a bad password
      throw new MFAInvalidSignin();
    }
  }

  await recordSuccessfulLogin(email);

  return {
    id: user.id,
    email: user.email,
    name: user.fullName,
    role: user.role,
  };
}

/**
 * JWT callback, extracted to a standalone function so it's unit-testable without driving the
 * full NextAuth request stack (mirrors authorizeCredentials above).
 *
 * R2-1: one Auth.js instance and one AUTH_SECRET serve every tenant, so a JWT signed for tenant
 * A verifies perfectly well on a request to tenant B's host. Every non-sign-in invocation must
 * re-bind the token to the REQUEST's tenant before trusting anything else in it — including the
 * 60-second "recently checked" fast path, which previously skipped this entirely.
 */
export async function jwtCallback({
  token,
  user,
}: {
  token: JWT;
  // Loosely typed to match @auth/core's User | AdapterUser (only populated on sign-in) —
  // the fields actually read below (id, role, name) aren't on the base User type.
  user?: any;
}): Promise<JWT | null> {
  // On initial sign-in, copy user fields to the JWT
  if (user) {
    token.id = user.id;
    token.role = (user as any).role;
    token.fullName = (user as any).name;

    // Bind this session to the tenant it logged into.
    try {
      const { getTenantSlug } = await import('@/lib/tenant/context');
      token.tenantSlug = await getTenantSlug();
    } catch {
      token.tenantSlug = '';
    }

    // Fetch and store the current sessionVersion using the tenant DB.
    try {
      const slug = (token.tenantSlug as string) ?? '';
      const tenant = slug ? await getTenantBySlug(slug) : null;
      if (tenant) {
        const db = getDbForUrl(tenant.dbUrl);
        const [dbUser] = await db
          .select({ sessionVersion: users.sessionVersion })
          .from(users)
          .where(eq(users.id, user.id as string));
        token.sessionVersion = dbUser?.sessionVersion ?? 1;
      } else {
        token.sessionVersion = 1;
      }
    } catch {
      token.sessionVersion = 1;
    }
  }

  // On every subsequent request, re-validate the token.
  // This query runs on EVERY request via middleware. It MUST be resilient:
  // - 3-second timeout prevents hangs from stalling all page loads
  // - Fail-open on ANY error (DB down, connection pool exhausted, cold start) for the
  //   sessionVersion check below — but the tenant-binding check right after this comment
  //   is fail-CLOSED: it needs no DB query, so there's no "unavailable" case to tolerate.
  // - No console.error logging to avoid log spam during transient DB issues
  // DO NOT add console.error here — it fires on every request when DB is unavailable
  if (token.id && !user) {
    // R2-1: tenant-bound session check. Runs on EVERY call, including the 60-second fast
    // path below — a stale-but-same-tenant token is fine to fast-path; a token replayed
    // against a DIFFERENT tenant's host must never be, no matter how "recently checked".
    try {
      const { getTenantSlug } = await import('@/lib/tenant/context');
      const requestSlug = await getTenantSlug();
      const tokenSlug = (token.tenantSlug as string) ?? '';
      if (!tokenSlug || tokenSlug !== requestSlug) {
        return null;
      }
    } catch {
      // getTenantSlug() throws on a host / x-tenant-slug mismatch (tampering) — fail closed.
      return null;
    }

    // §5.6: the workspace's access mode, from the cached registry record (no extra query in the common case).
    // A workspace being deleted (or deleted) ends every session; any other closed mode just skips the tenant-DB
    // check below (its database may be unreachable by design). Control-plane errors fail open, like the DB case.
    let tenant: Awaited<ReturnType<typeof getTenantBySlug>> = null;
    try {
      tenant = await getTenantBySlug((token.tenantSlug as string) ?? '');
    } catch {
      return token;
    }
    if (!tenant) return token; // can't validate without a tenant — fail-open like the DB-down case
    if (tenant.status === 'deleting' || tenant.status === 'deleted') return null;
    if (getTenantAccess(tenant, new Date()) === 'closed') return token;

    // PERFORMANCE: Only check DB every 60 seconds, not on every request.
    // The JWT stores a lastSessionCheck timestamp — if less than 60s old, skip the DB query.
    const now = Date.now();
    const lastChecked = (token.lastSessionCheck as number) ?? 0;
    const SESSION_CHECK_INTERVAL_MS = 60_000; // 60 seconds

    if (now - lastChecked <= SESSION_CHECK_INTERVAL_MS) {
      return token; // Skip DB check — recently validated
    }

    try {
      const db = getDbForUrl(tenant.dbUrl);

      const dbPromise = db
        .select({
          sessionVersion: users.sessionVersion,
          isActive: users.isActive,
          role: users.role,
          fullName: users.fullName,
        })
        .from(users)
        .where(eq(users.id, token.id as string))
        .then((rows: any[]) => rows[0] ?? null);

      const timeoutPromise = new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('Session validation timeout')), 3000)
      );

      const dbUser = await Promise.race([dbPromise, timeoutPromise]);

      if (!dbUser) {
        // User deleted — invalidate
        return { ...token, invalidated: true };
      }

      if (!dbUser.isActive) {
        // User deactivated — invalidate
        return { ...token, invalidated: true };
      }

      if (dbUser.sessionVersion !== (token.sessionVersion ?? 1)) {
        // Session version mismatch — invalidate
        return { ...token, invalidated: true };
      }

      // Keep role and name in sync with database
      token.role = dbUser.role;
      token.fullName = dbUser.fullName;
      token.lastSessionCheck = now;
    } catch {
      // DB unavailable, timeout, or connection error — fail-open.
      // Return token as-is without modification. The user continues
      // with their existing JWT data until DB recovers.
      return token;
    }
  }

  return token;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      name: 'Email & Password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        mfaCode: { label: 'Authentication code', type: 'text' },
      },
      authorize: authorizeCredentials,
    }),
  ],
  session: {
    strategy: 'jwt',
    maxAge: 24 * 60 * 60, // 24 hours
  },
  pages: {
    signIn: '/login',
  },
  callbacks: {
    jwt: jwtCallback,
    async session({ session, token }) {
      // If the session was invalidated, return a null-like session
      if ((token as any).invalidated) {
        session.user = undefined as any;
        return session;
      }

      if (session.user) {
        session.user.id = token.id as string;
        (session.user as any).role = token.role as string;
        (session.user as any).fullName = token.fullName as string;
        (session.user as any).tenantSlug = token.tenantSlug as string;
      }
      return session;
    },
  },
});
