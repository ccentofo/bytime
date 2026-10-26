'use client';

import { Button } from '@mantine/core';
import { IconLogout } from '@tabler/icons-react';
import { signOutToLogin } from '@/components/auth/sign-out';

/**
 * Sign-out for the full-screen hold screens (BillingWall / OnHoldScreen / PolicyHoldScreen), which render without the
 * app shell and its user menu — without this, a user there had no way to sign out (feature-plan-launch-blockers.md P4 §8).
 */
export function SignOutButton() {
  return (
    <Button variant="subtle" color="gray" leftSection={<IconLogout size={16} />} onClick={() => { void signOutToLogin(); }}>
      Sign out
    </Button>
  );
}
