import type { ReactElement } from 'react';
import { getTenantState } from '@/lib/tenant/context';
import { rootDomain } from '@/lib/tenant/host';
import { TenantUnavailable } from '@/app/(app)/TenantUnavailable';
import { WorkspaceFinder } from './WorkspaceFinder';

/**
 * Server-side routing for the public auth pages (/login, /forgot-password) — feature-plan-launch-blockers.md P2:
 * - apex (no workspace in context) → "Find your workspace";
 * - unknown / closed / provisioning workspace (or a host/header mismatch) → TenantUnavailable;
 * - any workspace a user can sign in to (full, read_only, billing_only, policy_hold) → the page's own form.
 */
export async function workspaceAuthGate(target: '/login' | '/forgot-password', form: () => ReactElement): Promise<ReactElement> {
  const state = await getTenantState();
  switch (state.kind) {
    case 'none':
      return <WorkspaceFinder target={target} rootDomain={rootDomain()} />;
    case 'unknown':
    case 'closed':
    case 'provisioning':
    case 'mismatch':
      return <TenantUnavailable reason={state.kind} />;
    default:
      return form();
  }
}
