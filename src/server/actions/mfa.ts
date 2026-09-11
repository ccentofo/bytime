'use server';

import { getDb } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import bcrypt from 'bcryptjs';
import { encrypt, decrypt } from '@/lib/encryption';
import {
  generateTOTPSecret,
  verifyTOTPCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from '@/lib/totp';

// ---------------------------------------------------------------------------
// MFA Setup
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
  const session = await auth();
  if (!session?.user?.email) redirect('/login');

  return generateTOTPSecret(session.user.email);
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
  const db = await getDb();
  const session = await auth();
  if (!session?.user?.id) redirect('/login');

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
    .where(eq(users.id, session.user.id));

  return { success: true, recoveryCodes: plainCodes };
}

/**
 * Disable MFA — requires current password confirmation.
 */
export async function disableMFA(currentPassword: string): Promise<{ success: boolean; error?: string }> {
  const db = await getDb();
  const session = await auth();
  if (!session?.user?.id) redirect('/login');

  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, session.user.id));

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
    .where(eq(users.id, session.user.id));

  return { success: true };
}

// ---------------------------------------------------------------------------
// MFA Login Verification
// ---------------------------------------------------------------------------

/**
 * Verify a TOTP code or recovery code during the login flow.
 * Called from the /login/mfa page after successful password auth.
 */
export async function verifyMFALogin(data: {
  userId: string;
  code: string;
  isRecoveryCode?: boolean;
}): Promise<{ success: boolean; error?: string }> {
  const db = await getDb();
  const [user] = await db
    .select({
      totpSecret: users.totpSecret,
      totpEnabled: users.totpEnabled,
      totpRecoveryCodes: users.totpRecoveryCodes,
    })
    .from(users)
    .where(eq(users.id, data.userId));

  if (!user?.totpEnabled || !user.totpSecret) {
    return { success: false, error: '2FA is not enabled for this account.' };
  }

  const secret = decrypt(user.totpSecret);

  if (data.isRecoveryCode) {
    // Verify recovery code
    if (!user.totpRecoveryCodes) {
      return { success: false, error: 'No recovery codes available.' };
    }

    const hashedCodes: string[] = JSON.parse(decrypt(user.totpRecoveryCodes));
    const matchIndex = verifyRecoveryCode(data.code, hashedCodes);

    if (matchIndex === -1) {
      return { success: false, error: 'Invalid recovery code.' };
    }

    // Consume the used recovery code
    hashedCodes.splice(matchIndex, 1);
    const updatedEncrypted = encrypt(JSON.stringify(hashedCodes));

    await db.update(users)
      .set({ totpRecoveryCodes: updatedEncrypted, updatedAt: new Date() })
      .where(eq(users.id, data.userId));

    return { success: true };
  }

  // Verify TOTP code
  const isValid = verifyTOTPCode(secret, data.code);
  if (!isValid) {
    return { success: false, error: 'Invalid code. Please try again.' };
  }

  return { success: true };
}

/**
 * Get MFA status for the current user.
 */
export async function getMFAStatus(): Promise<{ enabled: boolean; recoveryCodesRemaining: number }> {
  const db = await getDb();
  const session = await auth();
  if (!session?.user?.id) return { enabled: false, recoveryCodesRemaining: 0 };

  const [user] = await db
    .select({ totpEnabled: users.totpEnabled, totpRecoveryCodes: users.totpRecoveryCodes })
    .from(users)
    .where(eq(users.id, session.user.id));

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
