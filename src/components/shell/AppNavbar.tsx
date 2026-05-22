'use client';

import { Stack, NavLink, Divider, Text } from '@mantine/core';
import { IconClock, IconFileText, IconUsers } from '@tabler/icons-react';
import { usePathname } from 'next/navigation';

export function AppNavbar() {
  const pathname = usePathname();

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
    </Stack>
  );
}
