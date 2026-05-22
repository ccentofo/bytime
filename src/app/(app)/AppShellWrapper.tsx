'use client';

import { AppShell } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { SessionProvider } from 'next-auth/react';
import { AppHeader } from '@/components/shell/AppHeader';
import { AppNavbar } from '@/components/shell/AppNavbar';

type Props = {
  user: {
    fullName: string;
    email: string;
    role: string;
  };
  children: React.ReactNode;
};

export function AppShellWrapper({ user, children }: Props) {
  const [opened, { toggle }] = useDisclosure();

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
        <AppShell.Main>{children}</AppShell.Main>
      </AppShell>
    </SessionProvider>
  );
}
