import 'server-only';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * R2-3: the one safe column set for `users` — exactly what the client-side user list/forms
 * render. Never passwordHash, totpSecret, totpRecoveryCodes, or sessionVersion. Use this (or
 * `.returning(SAFE_USER_COLUMNS)`) for every `users` query result that can reach a client
 * component or a server action's return value.
 */
export const SAFE_USER_COLUMNS = {
  id: users.id,
  email: users.email,
  fullName: users.fullName,
  role: users.role,
  isActive: users.isActive,
  flsaExempt: users.flsaExempt,
  approverId: users.approverId, // certified-outputs C2: designated approver (supervisor/admin users)
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
} as const;

/**
 * Look up a user by email with the safe column set — never passwordHash, totpSecret,
 * or totpRecoveryCodes.
 *
 * INTERNAL — not a server action. auth.ts's authorize() does its own raw lookup (it needs the
 * secrets this function deliberately omits); this is for server-side code (Server Components,
 * other internal helpers) that needs a user's profile by email without exposing it over HTTP.
 */
export async function getUserByEmail(email: string) {
  const db = await getDb();
  const rows = await db
    .select(SAFE_USER_COLUMNS)
    .from(users)
    .where(eq(users.email, email));
  return rows[0] ?? null;
}
