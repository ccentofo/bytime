import * as OTPAuth from 'otpauth';
import crypto from 'crypto';

const APP_NAME = 'ByTime';

/**
 * Generate a new TOTP secret and return the secret + otpauth:// URI for QR code.
 */
export function generateTOTPSecret(email: string): {
  secret: string;
  uri: string;
} {
  const totp = new OTPAuth.TOTP({
    issuer: APP_NAME,
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });

  return {
    secret: totp.secret.base32,
    uri: totp.toString(),
  };
}

/**
 * Verify a 6-digit TOTP code against a base32 secret.
 * Allows 1 step tolerance (±30 seconds) for clock drift.
 */
export function verifyTOTPCode(secret: string, code: string): boolean {
  try {
    const totp = new OTPAuth.TOTP({
      issuer: APP_NAME,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });

    const delta = totp.validate({ token: code.replace(/\s/g, ''), window: 1 });
    return delta !== null;
  } catch {
    return false;
  }
}

/**
 * Generate 10 one-time recovery codes (8 alphanumeric characters each).
 */
export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    // 6 bytes = 8 base32 chars (uppercase alphanumeric)
    const bytes = crypto.randomBytes(6);
    const code = bytes.toString('hex').toUpperCase().slice(0, 8);
    codes.push(code);
  }
  return codes;
}

/**
 * Hash a recovery code for storage (SHA-256).
 */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(code.toUpperCase().trim()).digest('hex');
}

/**
 * Verify a recovery code against a list of hashed codes.
 * Returns the index of the matched code, or -1 if not found.
 */
export function verifyRecoveryCode(code: string, hashedCodes: string[]): number {
  const hash = hashRecoveryCode(code);
  return hashedCodes.findIndex((h) => h === hash);
}
