'use client';

import { useState, useEffect } from 'react';
import { AppShell, Alert, Anchor, Group, CloseButton, ActionIcon, Tooltip, ScrollArea } from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { SessionProvider } from 'next-auth/react';
import { IconRocket, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from '@tabler/icons-react';
import { AppHeader } from '@/components/shell/AppHeader';
import { AppNavbar } from '@/components/shell/AppNavbar';

type Props = {
  user: {
    fullName: string;
    email: string;
    role: string;
  };
  setupComplete?: boolean;
  /** Collapse preference, read from a cookie server-side so the first paint is already correct. */
  initialCollapsed?: boolean;
  children: React.ReactNode;
};

const BANNER_DISMISS_KEY = 'bytime-setup-banner-dismissed';
const NAV_COLLAPSED_KEY = 'cadenzpoint-navbar-collapsed';

export function AppShellWrapper({ user, setupComplete = true, initialCollapsed = false, children }: Props) {
  const [opened, { toggle }] = useDisclosure();
  const [bannerDismissed, setBannerDismissed] = useState(true); // Start hidden to avoid flash
  // Seed from the server-read cookie so the rail renders at the right width on the FIRST paint
  // (no flash-open-then-collapse on navigation).
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  // Collapse to an icon rail only on desktop; mobile keeps the burger overlay at full width.
  // getInitialValueInEffect:false → matchMedia is read synchronously on the first client render
  // (not deferred to an effect), so `isDesktop` is correct before paint and doesn't cause a flash.
  // Default `true` keeps SSR/first paint consistent with the cookie-driven width on desktop.
  const isDesktop = useMediaQuery('(min-width: 48em)', true, { getInitialValueInEffect: false });
  const railCollapsed = collapsed && !!isDesktop;

  const showBanner = user.role === 'admin' && !setupComplete && !bannerDismissed;

  useEffect(() => {
    // Banner state lives in sessionStorage (no SSR equivalent needed — it's allowed to settle post-mount).
    setBannerDismissed(sessionStorage.getItem(BANNER_DISMISS_KEY) === 'true');
  }, []);

  function handleDismissBanner() {
    sessionStorage.setItem(BANNER_DISMISS_KEY, 'true');
    setBannerDismissed(true);
  }

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      // Persist in a cookie (not localStorage) so the server can read it and render the correct
      // width on the next navigation's first paint.
      try {
        document.cookie = `${NAV_COLLAPSED_KEY}=${next}; path=/; max-age=31536000; samesite=lax`;
      } catch { /* ignore */ }
      return next;
    });
  }

  return (
    <SessionProvider>
      <AppShell
        header={{ height: 60 }}
        navbar={{ width: railCollapsed ? 72 : 250, breakpoint: 'sm', collapsed: { mobile: !opened } }}
        padding="md"
      >
        <AppShell.Header>
          <AppHeader user={user} mobileNavOpened={opened} onMobileNavToggle={toggle} />
        </AppShell.Header>
        <AppShell.Navbar p="xs">
          {/* Scrollable nav list grows to fill; the collapse toggle pins to the bottom (desktop only). */}
          <AppShell.Section grow component={ScrollArea}>
            <AppNavbar userRole={user.role} collapsed={railCollapsed} />
          </AppShell.Section>
          <AppShell.Section visibleFrom="sm" pt="xs">
            <Group justify={railCollapsed ? 'center' : 'flex-end'} px={railCollapsed ? 0 : 'xs'}>
              <Tooltip
                label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
                position="right"
                withArrow
              >
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="lg"
                  onClick={toggleCollapsed}
                  aria-label={collapsed ? 'Expand navigation sidebar' : 'Collapse navigation sidebar'}
                >
                  {collapsed
                    ? <IconLayoutSidebarLeftExpand size={20} />
                    : <IconLayoutSidebarLeftCollapse size={20} />}
                </ActionIcon>
              </Tooltip>
            </Group>
          </AppShell.Section>
        </AppShell.Navbar>
        {/* minWidth:0 lets this CSS-grid item shrink below its content's intrinsic width so
            wide children (e.g. the timesheet table) scroll within their own container instead
            of stretching the page and clipping the right edge. */}
        <AppShell.Main style={{ minWidth: 0 }}>
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
                  Your CadenzPoint workspace needs initial setup.{' '}
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
