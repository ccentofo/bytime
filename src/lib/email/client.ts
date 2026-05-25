import { Resend } from 'resend';

if (!process.env.RESEND_API_KEY) {
  console.warn('RESEND_API_KEY not set — email notifications will be disabled');
}

export const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

export const EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@bytime.dev';

/**
 * Check if email sending is configured and available.
 */
export function isEmailEnabled(): boolean {
  return resend !== null;
}
