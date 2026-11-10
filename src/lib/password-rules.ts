/**
 * Password rules (feature-plan-ux-people-codes.md §5.1): ONE definition shared by the server actions (changePassword,
 * adminResetPassword, createUserWithPassword) and the forms that tick each rule as it's met. Client-safe.
 */

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/** Each rule as the forms show it; `met` is checked as the user types. */
export const PASSWORD_RULES: ReadonlyArray<{ id: string; label: string; met: (password: string) => boolean }> = [
  { id: 'min', label: `At least ${MIN_PASSWORD_LENGTH} characters`, met: (p) => p.length >= MIN_PASSWORD_LENGTH },
  // UX-4C1-AUDIT.md L13: neutral until the minimum is met, so it doesn't tick on the first keystroke ahead of `min`.
  { id: 'max', label: `No more than ${MAX_PASSWORD_LENGTH} characters`, met: (p) => p.length >= MIN_PASSWORD_LENGTH && p.length <= MAX_PASSWORD_LENGTH },
];

/** The first broken rule's message, or null when the password is acceptable. */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must not exceed ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null;
}
