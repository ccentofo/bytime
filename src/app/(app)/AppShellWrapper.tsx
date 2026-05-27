'use client';

import { useState, useEffect } from 'react';
import { AppShell, Alert, Anchor, Group, CloseButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { SessionProvider } from 'next-auth/react';
import { IconRocket } from '@tabler/icons-react';
import { AppHeader } from '@/components/shell/AppHeader';
import { AppNavbar } from '@/components/shell/AppNavbar';

type Props = {
  user: {
    fullName: string;
    email: string;
    role: string;
  };
  setupComplete?: boolean;
  children: React.ReactNode;
};

const BANNER_DISMISS_KEY = 'bytime-setup-banner-dismissed';

export function AppShellWrapper({ user, setupComplete = true, children }: Props) {
  const [opened, { toggle }] = useDisclosure();
  const [bannerDismissed, setBannerDismissed] = useState(true); // Start hidden to avoid flash

  const showBanner = user.role === 'admin' && !setupComplete && !bannerDismissed;

  useEffect(() => {
    // Check sessionStorage on mount — if not dismissed, show the banner
    const dismissed = sessionStorage.getItem(BANNER_DISMISS_KEY) === 'true';
    setBannerDismissed(dismissed);
  }, []);

  function handleDismissBanner() {
    sessionStorage.setItem(BANNER_DISMISS_KEY, 'true');
    setBannerDismissed(true);
  }

  return (
    <SessionProvider>
      <AppShell
        header={{ height: 60 }}
        navbar={{ width: 250, breakpoint: 'sm', collapsed: { mobile: !opened } }}
        padding="md"
      >
        <AppShell.Header>
          <AppHeader user={user} />
        </AppShell.Header>
        <AppShell.Navbar p="xs">
          <AppNavbar userRole={user.role} />
        </AppShell.Navbar>
        <AppShell.Main>
          {showBanner && (
            <Alert
              icon={<IconRocket size={18} />}
              color="blue"
              variant="light"
              mb="md"
              radius="md"
              styles={{ root: { position: 'relative' } }}
            >
              <Group justify="space-between" align="center" wrap="nowrap">
                <span>
                  Your ByTime instance needs initial setup.{' '}
                  <Anchor href="/admin/setup" fw={600}>
                    Complete the Setup Wizard →
                  </Anchor>
                </span>
                <CloseButton size="sm" onClick={handleDismissBanner} aria-label="Dismiss setup banner" />
              </Group>
            </Alert>
          )}
          {children}
        </AppShell.Main>
      </AppShell>
    </SessionProvider>
  );
}
