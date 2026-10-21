'use server';

import { getDb } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireSession } from '@/lib/session';
import bcrypt from 'bcryptjs';
import { encrypt, decrypt } from '@/lib/encryption';
import {
  generateTOTPSecret,
  verifyTOTPCode,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '@/lib/totp';

// ---------------------------------------------------------------------------
// MFA Setup — all self-only. MFA login verification itself lives in auth.ts's
// authorize() (see the blueprint's "MFA inside sign-in" change) — there is no
// separate verifyMFALogin action anymore; no session exists until it passes.
// ---------------------------------------------------------------------------

/**
 * Initialize MFA setup — generates a new TOTP secret and returns the QR code URI.
 * The secret is NOT saved until the user verifies a code.
 * Returns the secret (to be stored temporarily in session/state) and the QR URI.
 */
export async function initMFASetup(): Promise<{
  secret: string;
  uri: string;
}> {
  const actor = await requireSession();
  return generateTOTPSecret(actor.email);
}

/**
 * Complete MFA setup — verifies the code against the pending secret,
 * then saves the encrypted secret + hashed recovery codes to the DB.
 * Returns the plaintext recovery codes (shown once to the user).
 */
export async function completeMFASetup(data: {
  pendingSecret: string;
  code: string;
}): Promise<{ success: boolean; recoveryCodes?: string[]; error?: string }> {
  const actor = await requireSession();
  const db = await getDb();

  // Verify the code against the pending secret
  const isValid = verifyTOTPCode(data.pendingSecret, data.code);
  if (!isValid) {
    return { success: false, error: 'Invalid code. Please try again.' };
  }

  // Generate recovery codes
  const plainCodes = generateRecoveryCodes();
  const hashedCodes = plainCodes.map(hashRecoveryCode);

  // Encrypt and save
  const encryptedSecret = encrypt(data.pendingSecret);
  const encryptedRecoveryCodes = encrypt(JSON.stringify(hashedCodes));

  await db.update(users)
    .set({
      totpSecret: encryptedSecret,
      totpEnabled: true,
      totpRecoveryCodes: encryptedRecoveryCodes,
      updatedAt: new Date(),
    })
    .where(eq(users.id, actor.id));

  return { success: true, recoveryCodes: plainCodes };
}

/**
 * Disable MFA — requires current password confirmation.
 */
export async function disableMFA(currentPassword: string): Promise<{ success: boolean; error?: string }> {
  const actor = await requireSession();
  const db = await getDb();

  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, actor.id));

  if (!user?.passwordHash) {
    return { success: false, error: 'No password set on this account.' };
  }

  const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isValid) {
    return { success: false, error: 'Incorrect password.' };
  }

  await db.update(users)
    .set({
      totpSecret: null,
      totpEnabled: false,
      totpRecoveryCodes: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, actor.id));

  return { success: true };
}

/**
 * Get MFA status for the session user.
 */
export async function getMFAStatus(): Promise<{ enabled: boolean; recoveryCodesRemaining: number }> {
  const actor = await requireSession();
  const db = await getDb();

  const [user] = await db
    .select({ totpEnabled: users.totpEnabled, totpRecoveryCodes: users.totpRecoveryCodes })
    .from(users)
    .where(eq(users.id, actor.id));

  if (!user?.totpEnabled) return { enabled: false, recoveryCodesRemaining: 0 };

  let recoveryCodesRemaining = 0;
  if (user.totpRecoveryCodes) {
    try {
      const codes: string[] = JSON.parse(decrypt(user.totpRecoveryCodes));
      recoveryCodesRemaining = codes.length;
    } catch {
      recoveryCodesRemaining = 0;
    }
  }

  return { enabled: true, recoveryCodesRemaining };
}
