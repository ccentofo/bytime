import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import dayjs from 'dayjs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { signups, tenants } from '@/db/control-plane/schema';
import { ProvisionConflictError, provisionTenant } from '@/lib/tenant/provision';
import { issueSetPasswordToken } from '@/lib/tenant/invite';
import { getTenantBySlug } from '@/lib/tenant/registry';
import { apexBaseUrl, tenantBaseUrl } from '@/lib/tenant/host';
import { signupControlsEnabled } from '@/lib/signup/controls';
import { raiseAlertWithEmail } from '@/lib/tenant/ops-alert-email';
import { SIGNUP_DAILY_WORKSPACE_CAP, SIGNUP_PER_IP_WORKSPACES_PER_DAY } from '@/lib/tenant/lifecycle-config';
import { tenantsCreatedSince, verifiedSignupsFromIp } from '@/server/internal/signup';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function failRedirect(msg: string) {
  return NextResponse.redirect(`${apexBaseUrl()}/signup?error=${encodeURIComponent(msg)}`);
}

/**
 * LB-D2 waitlist message (feature-plan-launch-blockers.md P5). Shown for a waitlisted signup on every visit — GET or
 * POST, expired or not, under the cap or not; only the founder provisions waitlisted rows (`tenant:admin waitlist`).
 */
function waitlistPage(email: string) {
  return htmlPage('We’re setting up your workspace', `
    <h1>We’re setting up a lot of new workspaces today</h1>
    <p>We're setting up a lot of new workspaces today. Leave your email and we'll have yours ready within one business day.</p>
    <p>Your email <strong>${escapeHtml(email)}</strong> is already on the list — there is nothing more you need to do.
    We'll email you as soon as your workspace is ready.</p>`);
}

function htmlPage(title: string, body: string, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f9fafb; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; margin: 0; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 40px; max-width: 480px; width: 100%; text-align: center; }
    h1 { font-size: 22px; font-weight: 700; margin: 0 0 12px; color: #111; }
    p { font-size: 14px; color: #6b7280; line-height: 1.6; margin: 0 0 16px; }
  </style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
  return new NextResponse(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ---------------------------------------------------------------------------
// GET — validate token, render a confirm page (NO provisioning).
//
// Email security scanners (SafeLinks, Proofpoint, Mimecast) auto-GET links.
// Provisioning must NOT happen on GET — only on the explicit POST below.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const email = (req.nextUrl.searchParams.get('email') ?? '').toLowerCase().trim();

  if (!token || !email) return failRedirect('Invalid link.');

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const [row] = await controlDb.select().from(signups).where(
    and(eq(signups.email, email), eq(signups.verifyTokenHash, tokenHash), isNull(signups.consumedAt)),
  ).limit(1);

  if (!row) return failRedirect('This link is invalid or already used.');
  // GET never writes (email scanners open links). A waitlisted signup sees the waitlist message, whatever its expiry.
  if (row.waitlistedAt) return waitlistPage(email);
  if (dayjs().isAfter(dayjs(row.expiresAt))) return failRedirect('This link has expired. Please sign up again.');

  // Render a scanner-safe confirmation page with a POST button.
  // Token and email are embedded as hidden fields; provisioning only happens on POST.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Create your CadenzPoint workspace</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f9fafb; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 40px; max-width: 440px; width: 100%; text-align: center; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; color: #111; }
    p { font-size: 14px; color: #6b7280; line-height: 1.6; margin-bottom: 24px; }
    .workspace { font-weight: 600; color: #228be6; }
    button { background: #228be6; color: #fff; border: none; border-radius: 8px; padding: 14px 28px; font-size: 15px; font-weight: 600; cursor: pointer; width: 100%; transition: background 0.15s; }
    button:hover { background: #1c7ed6; }
    .note { font-size: 12px; color: #9ca3af; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🏢</div>
    <h1>Create your workspace</h1>
    <p>
      Your email <strong>${escapeHtml(email)}</strong> is verified.<br/>
      Click below to create your <span class="workspace">${escapeHtml(row.slug)}.${escapeHtml(process.env.APP_ROOT_DOMAIN ?? 'localhost')}</span> workspace.
    </p>
    <form method="POST" action="/signup/verify">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <input type="hidden" name="email" value="${escapeHtml(email)}" />
      <button type="submit">Confirm and create workspace</button>
    </form>
    <p class="note">You'll set your password on the next step.</p>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// Simple HTML escaping — avoids XSS in the confirmation page
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// POST — provisioning happens ONLY here (submitted by the user, not a scanner).
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const body = await req.formData();
  const token = (body.get('token') as string | null) ?? '';
  const email = ((body.get('email') as string | null) ?? '').toLowerCase().trim();

  if (!token || !email) return failRedirect('Invalid submission.');

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const [row] = await controlDb.select().from(signups).where(
    and(eq(signups.email, email), eq(signups.verifyTokenHash, tokenHash), isNull(signups.consumedAt)),
  ).limit(1);

  if (!row) return failRedirect('This link is invalid or already used.');
  // P5: FIRST — a waitlisted signup never provisions from this path (the founder provisions it), even after expiry.
  if (row.waitlistedAt) return waitlistPage(email);
  if (dayjs().isAfter(dayjs(row.expiresAt))) return failRedirect('This link has expired. Please sign up again.');

  const base = tenantBaseUrl(row.slug);

  // If already provisioned and active, route to login
  const already = await getTenantBySlug(row.slug);
  if (already && already.status === 'active') {
    await controlDb.update(signups).set({ consumedAt: new Date() }).where(eq(signups.id, row.id));
    return NextResponse.redirect(`${base}/login`);
  }

  if (signupControlsEnabled()) {
    const refused = await signupControlsGate(row, email);
    if (refused) return refused;
  }

  // Provision the tenant (resumable only by the signer who started it — see provisionTenant)
  try {
    await provisionTenant({
      slug: row.slug,
      name: row.companyName,
      adminEmail: email,
      adminName: email.split('@')[0],
      timezone: row.timezone ?? undefined,
      termsVersion: row.termsVersion ?? undefined,
      termsAcceptedAt: row.termsAcceptedAt ?? undefined,
    });
  } catch (err) {
    if (err instanceof ProvisionConflictError) {
      await controlDb.update(signups).set({ consumedAt: new Date() }).where(eq(signups.id, row.id));
      return failRedirect('That workspace name was just taken. Please sign up again with a different name.');
    }
    console.error('[signup] provisioning failed:', err);
    return failRedirect('We could not finish creating your workspace. Please open your verification link again, or contact support.');
  }

  // Mark signup consumed — happens AFTER provisioning so a crash before here allows retry. provisioned_at too (audit
  // S1): the row's workspace now exists, whichever path created it.
  const provisionedAt = new Date();
  await controlDb.update(signups).set({ consumedAt: provisionedAt, provisionedAt }).where(eq(signups.id, row.id));

  // Mint a set-password token in the new tenant DB and redirect
  const tenant = await getTenantBySlug(row.slug);
  if (!tenant) return failRedirect('Provisioning failed. Please contact support.');
  const setToken = await issueSetPasswordToken(tenant.dbUrl, email);
  const url = `${base}/reset-password?token=${setToken}&email=${encodeURIComponent(email)}&welcome=1`;
  return NextResponse.redirect(url);
}

// ---------------------------------------------------------------------------
// Signup controls at verify (feature-plan-launch-blockers.md P5, SIGNUP_CONTROLS_ENABLED only). Returns the response
// that stops provisioning, or null to provision.
// ---------------------------------------------------------------------------

type SignupRow = typeof signups.$inferSelect;
const NETWORK_LIMIT_MESSAGE = 'Too many workspaces have been created from your network today. Please try again tomorrow.';

async function signupControlsGate(row: SignupRow, email: string): Promise<NextResponse | null> {
  const now = new Date();
  // verified_at is set ONCE — reopening the link never slides the per-IP window.
  // Audit R11: a Date interpolated into a raw `sql` fragment skips the column encoder and crashes drizzle's postgres-js
  // driver — pass the ISO string with a cast (as notices.ts does).
  await controlDb.update(signups).set({ verifiedAt: sql`coalesce(${signups.verifiedAt}, ${now.toISOString()}::timestamptz)` }).where(eq(signups.id, row.id));

  // Resume: this signer's own half-provisioned tenant → continue (never capped or IP-limited).
  const [own] = await controlDb.select({ id: tenants.id }).from(tenants)
    .where(and(eq(tenants.slug, row.slug), eq(tenants.signupEmail, email))).limit(1);
  if (own) return null;

  // The IP hash lives 24 h; a non-resume verify without it can't be limited → the link counts as expired.
  if (!row.ipHash) return failRedirect('This link has expired — please sign up again.');
  const since = dayjs(now).subtract(1, 'day').toDate();
  if (await verifiedSignupsFromIp(row.ipHash, since, row.id) >= SIGNUP_PER_IP_WORKSPACES_PER_DAY) {
    return failRedirect(NETWORK_LIMIT_MESSAGE); // row stays unconsumed
  }

  // Slug taken by another tenant — checked BEFORE the cap so the waitlist never holds an unprovisionable slug.
  if (await getTenantBySlug(row.slug)) {
    await controlDb.update(signups).set({ consumedAt: now }).where(eq(signups.id, row.id));
    return failRedirect('That workspace name was just taken. Please sign up again with a different name.');
  }

  // LB-D2 daily cap: tenants created in the last 24 h (any status).
  const created = await tenantsCreatedSince(since);
  if (created >= SIGNUP_DAILY_WORKSPACE_CAP) {
    await controlDb.update(signups).set({ waitlistedAt: now }).where(eq(signups.id, row.id)); // stays unconsumed
    await raiseAlertWithEmail({
      tenantId: null,
      kind: 'signup-cap-reached',
      dedupKey: now.toISOString().slice(0, 10), // once per UTC day
      detail: { createdLast24h: created, cap: SIGNUP_DAILY_WORKSPACE_CAP },
      summary: `The daily workspace cap (${SIGNUP_DAILY_WORKSPACE_CAP}) was reached; new verified signups are waitlisted. Provision them with: npm run tenant:admin -- waitlist list`,
    }, now);
    return waitlistPage(email);
  }
  return null;
}
