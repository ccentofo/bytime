import { Resend } from 'resend';

if (!process.env.RESEND_API_KEY) {
  console.warn('RESEND_API_KEY not set — email notifications will be disabled');
}

export const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// Must be an address on a domain verified in Resend (we own cadenzpoint.com — not .dev),
// or every send is rejected. Set EMAIL_FROM per environment; this is only the fallback.
export const EMAIL_FROM = process.env.EMAIL_FROM ?? 'CadenzPoint <noreply@cadenzpoint.com>';

/**
 * Check if email sending is configured and available.
 */
export function isEmailEnabled(): boolean {
  return resend !== null;
}
