import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import dayjs from 'dayjs';
import { and, eq, isNull } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { signups } from '@/db/control-plane/schema';
import { ProvisionConflictError, provisionTenant } from '@/lib/tenant/provision';
import { issueSetPasswordToken } from '@/lib/tenant/invite';
import { getTenantBySlug } from '@/lib/tenant/registry';
import { apexBaseUrl, tenantBaseUrl } from '@/lib/tenant/host';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function failRedirect(msg: string) {
  return NextResponse.redirect(`${apexBaseUrl()}/signup?error=${encodeURIComponent(msg)}`);
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
  if (dayjs().isAfter(dayjs(row.expiresAt))) return failRedirect('This link has expired. Please sign up again.');

  const base = tenantBaseUrl(row.slug);

  // If already provisioned and active, route to login
  const already = await getTenantBySlug(row.slug);
  if (already && already.status === 'active') {
    await controlDb.update(signups).set({ consumedAt: new Date() }).where(eq(signups.id, row.id));
    return NextResponse.redirect(`${base}/login`);
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

  // Mark signup consumed — happens AFTER provisioning so a crash before here allows retry
  await controlDb.update(signups).set({ consumedAt: new Date() }).where(eq(signups.id, row.id));

  // Mint a set-password token in the new tenant DB and redirect
  const tenant = await getTenantBySlug(row.slug);
  if (!tenant) return failRedirect('Provisioning failed. Please contact support.');
  const setToken = await issueSetPasswordToken(tenant.dbUrl, email);
  const url = `${base}/reset-password?token=${setToken}&email=${encodeURIComponent(email)}&welcome=1`;
  return NextResponse.redirect(url);
}
