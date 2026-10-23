import { redirect } from 'next/navigation';
import { SignupForm } from './SignupForm';
import { getTenantSlug } from '@/lib/tenant/context';
import { apexBaseUrl } from '@/lib/tenant/host';
import { after } from 'next/server';
import { missingSignupConfig, signupControlsEnabled } from '@/lib/signup/controls';
import { raiseSignupConfigMissing } from '@/lib/signup/signals';

export const dynamic = 'force-dynamic';

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Signup belongs to the apex (feature-plan-launch-blockers.md P2): a workspace host — or a host/header
  // mismatch — sends the visitor to the apex signup page.
  let onWorkspaceHost: boolean;
  try {
    onWorkspaceHost = (await getTenantSlug()) !== '';
  } catch {
    onWorkspaceHost = true;
  }
  if (onWorkspaceHost) redirect(`${apexBaseUrl()}/signup`);

  const { error } = await searchParams;
  // P5: the flag is read here, on the server; the client only gets the public site key when controls are on.
  const controls = signupControlsEnabled() ? { turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '' } : null;
  // Audit S2: a misconfiguration that refuses every signup alerts the founder from the page itself (deduplicated —
  // one email per incident), not only when someone manages to submit.
  const missing = controls ? missingSignupConfig() : [];
  if (missing.length > 0) after(() => raiseSignupConfigMissing(missing));
  return <SignupForm errorParam={error} controls={controls} />;
}
