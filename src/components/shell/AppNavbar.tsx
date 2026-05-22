'use client';

import { Stack, NavLink, Divider, Text } from '@mantine/core';
import { IconClock, IconFileText, IconUsers } from '@tabler/icons-react';
import { usePathname } from 'next/navigation';

type AppNavbarProps = {
  userRole?: string | null;
};

export function AppNavbar({ userRole }: AppNavbarProps) {
  const pathname = usePathname();
  const isAdmin = userRole === 'admin' || userRole === 'supervisor';

  return (
    <Stack gap={0} pt="sm">
      {/* Employee Section */}
      <Text size="xs" fw={700} c="dimmed" px="md" mb={4}>
        TIMEKEEPING
      </Text>
      <NavLink
        label="My Timesheet"
        href="/timesheet"
        leftSection={<IconClock size={18} />}
        active={pathname === '/timesheet'}
      />

      {isAdmin && (
        <>
          <Divider my="sm" />

          {/* Admin Section */}
          <Text size="xs" fw={700} c="dimmed" px="md" mb={4}>
            ADMINISTRATION
          </Text>
          <NavLink
            label="Contracts & CLINs"
            href="/admin/contracts"
            leftSection={<IconFileText size={18} />}
            active={pathname === '/admin/contracts'}
          />
          <NavLink
            label="User Assignments"
            href="/admin/assignments"
            leftSection={<IconUsers size={18} />}
            active={pathname === '/admin/assignments'}
          />
        </>
      )}
    </Stack>
  );
}
