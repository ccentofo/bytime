import 'server-only';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Look up a user by email with an explicit, safe column set — never passwordHash, totpSecret,
 * or totpRecoveryCodes.
 *
 * INTERNAL — not a server action. auth.ts's authorize() does its own raw lookup (it needs the
 * secrets this function deliberately omits); this is for server-side code (Server Components,
 * other internal helpers) that needs a user's profile by email without exposing it over HTTP.
 */
export async function getUserByEmail(email: string) {
  const db = await getDb();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      isActive: users.isActive,
      flsaExempt: users.flsaExempt,
    })
    .from(users)
    .where(eq(users.email, email));
  return rows[0] ?? null;
}
