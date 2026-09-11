import 'server-only';
import crypto from 'crypto';
import dayjs from 'dayjs';
import { getDbForUrl } from '@/db';
import { passwordResetTokens } from '@/db/schema';

const INVITE_EXPIRY_HOURS = 72; // onboarding window, longer than the 1h reset default

/** Mint a single-use set-password token in a specific tenant DB. Returns the raw token. */
export async function issueSetPasswordToken(dbUrl: string, email: string): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const db = getDbForUrl(dbUrl);
  await db.insert(passwordResetTokens).values({
    email: email.toLowerCase().trim(),
    tokenHash,
    expiresAt: dayjs().add(INVITE_EXPIRY_HOURS, 'hour').toDate(),
  });
  return rawToken;
}
