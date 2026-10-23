import 'server-only';
import dayjs from 'dayjs';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { signups } from '@/db/control-plane/schema';
import { ProvisionConflictError, provisionTenant } from './provision';
import { issueSetPasswordToken } from './invite';
import { getTenantBySlug } from './registry';
import { apexBaseUrl, tenantBaseUrl } from './host';
import { isLoopbackHost, isLoopbackUrl } from './loopback';
import { sendWorkspaceReadyEmail } from '@/lib/email/send-signup';
import { tenantsCreatedSince } from '@/server/internal/signup';

/**
 * Founder provisioning of waitlisted signups (feature-plan-launch-blockers.md P5, LB-D2): `tenant:admin waitlist list`
 * and `tenant:admin waitlist provision <signupId> --yes`. A waitlisted signup is a verified, unconsumed signups row.
 * Provisioning bypasses the daily cap (founder decision) and awaits the set-password email; if that email fails the
 * command prints the link and exits non-zero so the founder can relay it.
 */

export class WaitlistError extends Error {}

/**
 * Links in the welcome email come from APP_ROOT_DOMAIN / NEXT_PUBLIC_APP_URL. A founder shell with localhost values
 * pointed at a real (non-loopback) control plane would mail a customer a dead link — refuse that combination.
 */
export function waitlistEnvRefusal(env: Record<string, string | undefined> = process.env): string | null {
  if (isLoopbackUrl(env.CONTROL_PLANE_DATABASE_URL)) return null;
  const root = env.APP_ROOT_DOMAIN;
  const appUrl = env.NEXT_PUBLIC_APP_URL;
  if (!root || !appUrl || isLoopbackHost(root) || isLoopbackUrl(appUrl)) {
    return 'APP_ROOT_DOMAIN and NEXT_PUBLIC_APP_URL must be set to the real (non-localhost) domain when the control plane is '
      + 'remote — otherwise the welcome email would link to localhost. Load that environment\'s values first.';
  }
  return null;
}

export async function listWaitlist() {
  const rows = await controlDb.select({
    id: signups.id, slug: signups.slug, email: signups.email, companyName: signups.companyName,
    verifiedAt: signups.verifiedAt, waitlistedAt: signups.waitlistedAt,
  }).from(signups)
    .where(and(isNotNull(signups.waitlistedAt), isNull(signups.consumedAt)))
    .orderBy(asc(signups.waitlistedAt));
  return { rows, createdLast24h: await tenantsCreatedSince(dayjs().subtract(1, 'day').toDate()) };
}

export interface WaitlistProvisionDeps {
  provision: typeof provisionTenant;
  issueToken: typeof issueSetPasswordToken;
  sendEmail: typeof sendWorkspaceReadyEmail;
}

const defaultDeps: WaitlistProvisionDeps = { provision: provisionTenant, issueToken: issueSetPasswordToken, sendEmail: sendWorkspaceReadyEmail };

export async function provisionWaitlistedSignup(signupId: string, deps: WaitlistProvisionDeps = defaultDeps) {
  const refusal = waitlistEnvRefusal();
  if (refusal) throw new WaitlistError(refusal);

  const [row] = await controlDb.select().from(signups).where(eq(signups.id, signupId)).limit(1);
  if (!row) throw new WaitlistError(`No signup ${signupId}.`);
  if (row.consumedAt || row.provisionedAt) throw new WaitlistError('That signup was already provisioned.');
  if (!row.verifiedAt) throw new WaitlistError('That signup never verified its email — it cannot be provisioned.');
  if (!row.waitlistedAt) throw new WaitlistError('That signup is not on the waitlist.');

  try {
    await deps.provision({
      slug: row.slug,
      name: row.companyName,
      adminEmail: row.email,
      adminName: row.email.split('@')[0],
      timezone: row.timezone ?? undefined,
      termsVersion: row.termsVersion ?? undefined,
      termsAcceptedAt: row.termsAcceptedAt ?? undefined,
    });
  } catch (err) {
    if (err instanceof ProvisionConflictError) {
      throw new WaitlistError(`The workspace name "${row.slug}" was taken by someone else meanwhile — contact ${row.email} to pick another.`);
    }
    throw err;
  }

  const base = tenantBaseUrl(row.slug);
  const tenant = await getTenantBySlug(row.slug);
  if (!tenant) throw new WaitlistError(`Provisioned "${row.slug}" but it is not in the registry — check tenant:admin show.`);

  // Audit S9: issue the set-password token BEFORE marking the row provisioned. If issuing fails, the row stays
  // waitlisted (re-running resumes — provisioning is signer-bound and idempotent) and the founder gets the fallback.
  let token: string;
  try {
    token = await deps.issueToken(tenant.dbUrl, row.email);
  } catch (err) {
    throw new WaitlistError(
      `Workspace "${row.slug}" was created, but the set-password link could not be issued (${err instanceof Error ? err.message : String(err)}). `
      + `Re-run \`waitlist provision ${row.id} --yes\` (it resumes), or ask ${row.email} to use "Forgot password" at ${base}/forgot-password.`,
    );
  }

  const now = new Date();
  await controlDb.update(signups).set({ consumedAt: now, provisionedAt: now }).where(eq(signups.id, row.id));

  const setPasswordUrl = `${base}/reset-password?token=${token}&email=${encodeURIComponent(row.email)}&welcome=1`;
  const outcome = await deps.sendEmail({
    email: row.email,
    companyName: row.companyName,
    workspaceHost: new URL(base).host,
    setPasswordUrl,
    appUrl: apexBaseUrl(),
  });
  return { slug: row.slug, email: row.email, setPasswordUrl, emailed: outcome.ok };
}
