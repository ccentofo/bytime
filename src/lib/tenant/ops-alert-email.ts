import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { withLockedPool } from '@/db/control-plane/locked';
import { resend, EMAIL_FROM } from '@/lib/email/client';
import { raiseAlert, type AlertInput } from './lifecycle-store';

/**
 * Alerts that can't wait for the next daily digest (feature-plan-launch-blockers.md P6 §4 `cron-incomplete`, P5
 * Turnstile outage / config): raise the deduplicated ops alert and, ONLY when this opens a new incident, email
 * OPS_ALERT_EMAIL immediately and notify Sentry. Bumps of an already-open alert send nothing (the digest still lists
 * it), so a recurring condition is one email per incident — after it resolves, the next occurrence emails again.
 * Never throws: an alert path that fails must not break the job that raised it.
 */
export async function raiseAlertWithEmail(alert: AlertInput & { summary: string }, now: Date = new Date()): Promise<{ opened: boolean; emailed: boolean }> {
  const { summary, ...input } = alert;
  let opened = false;
  try {
    ({ opened } = await withLockedPool((db) => raiseAlert(db, input, now)));
  } catch (err) {
    console.error(`[ops alert] could not record ${input.kind}:`, err);
    Sentry.captureException(err);
    return { opened: false, emailed: false };
  }
  if (!opened) return { opened, emailed: false };

  const label = `${input.kind}${input.dedupKey ? `:${input.dedupKey}` : ''}`;
  Sentry.captureMessage(`ops alert ${label}: ${summary}`, { level: 'warning', extra: input.detail });

  const to = process.env.OPS_ALERT_EMAIL;
  if (!to || !resend) {
    console.error(`[ops alert] ${label} raised, but OPS_ALERT_EMAIL or RESEND_API_KEY is not set — no email sent.`);
    return { opened, emailed: false };
  }
  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `CadenzPoint alert: ${label}`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:14px"><p>${esc(summary)}</p>`
        + (input.detail ? `<pre>${esc(JSON.stringify(input.detail, null, 2))}</pre>` : '')
        + `<p>Raised ${esc(now.toISOString())}. It stays open (and listed in the daily digest) until its condition clears.</p></div>`,
    });
    if (!data?.id) throw new Error(error?.message ?? 'no message id');
    return { opened, emailed: true };
  } catch (err) {
    console.error(`[ops alert] email for ${label} failed:`, err);
    Sentry.captureException(err);
    return { opened, emailed: false };
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
