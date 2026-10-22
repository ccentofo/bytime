import { redirect } from 'next/navigation';
import { SignupForm } from './SignupForm';
import { getTenantSlug } from '@/lib/tenant/context';
import { apexBaseUrl } from '@/lib/tenant/host';

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
  return <SignupForm errorParam={error} />;
}
