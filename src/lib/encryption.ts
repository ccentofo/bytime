import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;   // 128 bits
const TAG_LENGTH = 16;  // 128 bits
const KEY_LENGTH = 32;  // 256 bits

/**
 * Get the encryption key from the environment.
 * Falls back to a development key if not set (NOT safe for production).
 */
function getKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY;
  if (!envKey) {
    console.warn('ENCRYPTION_KEY not set — using insecure development key. DO NOT use in production.');
    // Development fallback — deterministic key for local testing
    return crypto.scryptSync('bytime-dev-key-not-for-production', 'salt', KEY_LENGTH);
  }
  // If the key is a hex string (64 chars = 32 bytes), decode it
  if (/^[0-9a-f]{64}$/i.test(envKey)) {
    return Buffer.from(envKey, 'hex');
  }
  // Otherwise, derive a key from the provided string
  return crypto.scryptSync(envKey, 'bytime-encryption', KEY_LENGTH);
}

/**
 * Encrypt a plaintext string.
 * Returns a combined string: base64(iv + ciphertext + authTag)
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Combine: iv (16) + encrypted (variable) + authTag (16)
  const combined = Buffer.concat([iv, encrypted, authTag]);
  return combined.toString('base64');
}

/**
 * Decrypt an encrypted string produced by encrypt().
 */
export function decrypt(encryptedBase64: string): string {
  const key = getKey();
  const combined = Buffer.from(encryptedBase64, 'base64');

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH, combined.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
