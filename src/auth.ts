import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { getUserByEmail } from '@/server/actions/users';
import { checkLockout, recordFailedAttempt, recordSuccessfulLogin } from '@/server/actions/login-attempts';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      name: 'Email & Password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = (credentials.email as string).toLowerCase().trim();
        const password = credentials.password as string;

        // Check if the account is locked out
        const lockoutInfo = await checkLockout(email);
        if (lockoutInfo?.isLocked) {
          return null;
        }

        const user = await getUserByEmail(email);
        if (!user || !user.passwordHash || !user.isActive) {
          await recordFailedAttempt(email);
          return null;
        }

        const isValid = await bcrypt.compare(password, user.passwordHash);
        if (!isValid) {
          await recordFailedAttempt(email);
          return null;
        }

        await recordSuccessfulLogin(email);

        return {
          id: user.id,
          email: user.email,
          name: user.fullName,
          role: user.role,
        };
      },
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
    async jwt({ token, user }) {
      // On initial sign-in, copy user fields to the JWT
      if (user) {
        token.id = user.id;
        token.role = (user as any).role;
        token.fullName = (user as any).name;

        // Fetch and store the current sessionVersion
        try {
          const [dbUser] = await db
            .select({ sessionVersion: users.sessionVersion })
            .from(users)
            .where(eq(users.id, user.id as string));
          token.sessionVersion = dbUser?.sessionVersion ?? 1;
        } catch {
          token.sessionVersion = 1;
        }
      }

      // On every subsequent request, validate the sessionVersion.
      // This query runs on EVERY request via middleware. It MUST be resilient:
      // - 3-second timeout prevents hangs from stalling all page loads
      // - Fail-open on ANY error (DB down, connection pool exhausted, cold start)
      // - No console.error logging to avoid log spam during transient DB issues
      // DO NOT add console.error here — it fires on every request when DB is unavailable
      // PERFORMANCE: Only check DB every 60 seconds, not on every request.
      // The JWT stores a lastSessionCheck timestamp — if less than 60s old, skip the DB query.
      if (token.id && !user) {
        const now = Date.now();
        const lastChecked = (token.lastSessionCheck as number) ?? 0;
        const SESSION_CHECK_INTERVAL_MS = 60_000; // 60 seconds

        if (now - lastChecked <= SESSION_CHECK_INTERVAL_MS) {
          return token; // Skip DB check — recently validated
        }

        try {
          const dbPromise = db
            .select({
              sessionVersion: users.sessionVersion,
              isActive: users.isActive,
              role: users.role,
              fullName: users.fullName,
            })
            .from(users)
            .where(eq(users.id, token.id as string))
            .then((rows) => rows[0] ?? null);

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
    },
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
      }
      return session;
    },
  },
});
