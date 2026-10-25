import 'server-only';
import crypto from 'crypto';

/**
 * Passwords generated for bulk-imported employees (shown once and downloadable as CSV). Fix round 2, R1: the FIRST
 * character is a letter or digit, so a password never starts with a spreadsheet formula trigger (= + - @ tab CR) —
 * the CSV writer would otherwise prefix it with `'` and the downloaded/copied password would be wrong.
 */
const FIRST = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const REST = `${FIRST}!@#$`;

export function generateImportPassword(length = 12): string {
  let password = FIRST.charAt(crypto.randomInt(FIRST.length)); // CSPRNG, not Math.random
  for (let i = 1; i < length; i++) password += REST.charAt(crypto.randomInt(REST.length));
  return password;
}
