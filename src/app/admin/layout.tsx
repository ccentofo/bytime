'use client';

import { AppShell, NavLink, Title } from '@mantine/core';
import { IconFileText, IconUsers } from '@tabler/icons-react';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      navbar={{ width: 250, breakpoint: 'sm' }}
      padding="md"
    >
      <AppShell.Navbar p="md">
        <Title order={4} mb="md">Admin Panel</Title>
        <NavLink
          label="Contracts & CLINs"
          href="/admin/contracts"
          leftSection={<IconFileText size={18} />}
        />
        <NavLink
          label="User Assignments"
          href="/admin/assignments"
          leftSection={<IconUsers size={18} />}
        />
      </AppShell.Navbar>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}
