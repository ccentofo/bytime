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
import { getClientIp } from '@/lib/rate-limit';
import { consume, refund } from '@/lib/rate-limit/store';
import { ipIdentifier } from '@/lib/rate-limit/identifier';

/** Thrown from authorize() when the account has MFA enabled and no code was submitted yet.
 *  No session is issued — the client re-submits with mfaCode once the user enters one. */
class MFARequiredSignin extends CredentialsSignin {
  code = 'mfa_required';
}

/** Thrown from authorize() when an MFA code (TOTP or recovery) was submitted but is invalid. */
class MFAInvalidSignin extends CredentialsSignin {
  code = 'mfa_invalid';
}

/** Thrown from authorize() when this IP has used its failed sign-in budget (feature-plan-upstash-rate-limiting.md Q2). */
class SignInRateLimited extends CredentialsSignin {
  code = 'rate_limited';
}

/**
 * Credentials provider authorize logic, extracted to a standalone function so it can be
 * exercised directly in integration tests without driving the full NextAuth request stack.
 *
 * feature-plan-upstash-rate-limiting.md §6.7 (Q2): every attempt from an IP is counted BEFORE any work (atomically, so
 * parallel requests can't slip past) and refunded at exactly one site when it succeeds, stops at the MFA step, or hits
 * an unexpected exception. 20 failures per IP per 15 minutes across workspaces; over it, sign-in is refused even with
 * the right password. `ip` defaults to 'unknown' for direct (test) callers.
 */
export async function authorizeCredentials(credentials: Record<string, unknown> | undefined, ip = 'unknown') {
  // Input checks first: nothing counted, nothing checked. Auth.js accepts a JSON body, so the types aren't guaranteed.
  // An over-long or NUL-carrying email can't match any user and would only make the workspace database throw (which
  // the refund path below would refund), so it's refused here too.
  const rawEmail = credentials?.email;
  const rawPassword = credentials?.password;
  if (typeof rawEmail !== 'string' || typeof rawPassword !== 'string' || !rawEmail || !rawPassword) return null;
  if (rawEmail.includes('\0') || rawPassword.includes('\0')) return null;

  const email = rawEmail.toLowerCase().trim();
  // The length is checked on the NORMALIZED email, the value that is stored: some characters grow when lowercased
  // ('İ' → 'i̇', 1 → 2 code units), so a raw check would let a 256+ character email reach the varchar(255) insert.
  if (email.length > 255) return null;
  const password = rawPassword;
  // No code submitted = missing, blank, not a string, or "undefined"/"null": URLSearchParams serialises an undefined
  // value as the string "undefined" (feature-plan-hotfix-mfa-qr.md §7) — that must ask for a code, not count a failure.
  const rawMfa = credentials?.mfaCode;
  const mfaCode = typeof rawMfa === 'string' && !['', 'undefined', 'null'].includes(rawMfa.trim()) ? rawMfa.trim() : undefined;

  const ipId = ipIdentifier(ip);
  const gate = await consume('signInFailure', ipId);
  if (!gate.allowed) throw new SignInRateLimited(); // never refunded
  let refundDue = false;
  try {
    const user = await authorizeChecked(email, password, mfaCode); // records the success before returning
    if (user) refundDue = true;                                    // success
    return user;                                                   // null = a counted failure
  } catch (e) {
    if (e instanceof MFARequiredSignin || !(e instanceof CredentialsSignin)) refundDue = true; // MFA step, or an infrastructure error
    throw e;                                                       // MFAInvalidSignin and other CredentialsSignin keep the count
  } finally {
    if (refundDue) await refund('signInFailure', ipId, gate);      // the ONLY refund call: at most once per attempt
  }
}

/** The sign-in checks (unchanged from before the per-IP gate): the user, `null` for a failure, or a throw. */
async function authorizeChecked(email: string, password: string, mfaCode: string | undefined) {
  // Use suspended-tolerant DB resolver so suspended admins can still log in
  // and reach the billing wall. getDb() stays strict everywhere else.
  let authDb: Awaited<ReturnType<typeof getDbForAuth>>;
  try {
    authDb = await getDbForAuth();
  } catch {
    // Workspace not found / closed / other error — treat as bad credentials. (There is no workspace database to
    // record an attempt in.)
    return null;
  }

  // Check if the account is locked out
  const lockoutInfo = await getLockoutInfo(authDb, email);
  if (lockoutInfo.isLocked) {
    return null;
  }

  const rows = await authDb.select().from(users).where(eq(users.email, email));
  const user: typeof users.$inferSelect | null = rows[0] ?? null;
  if (!user || !user.passwordHash || !user.isActive) {
    await recordFailedAttempt(authDb, email);
    return null;
  }

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    await recordFailedAttempt(authDb, email);
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
        const claimed = await authDb.update(users)
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
      const userId = user.id;
      mfaValid = await authDb.transaction(async (tx) => {
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
      await recordFailedAttempt(authDb, email); // counts toward lockout, same as a bad password
      throw new MFAInvalidSignin();
    }
  }

  await recordSuccessfulLogin(authDb, email);

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
      authorize: (credentials, request) => authorizeCredentials(credentials, getClientIp(request)),
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
