'use client';

import { Stack, NavLink, Divider, Text } from '@mantine/core';
import { IconClock, IconFileText, IconUsers, IconChecklist, IconUserCog, IconCategory, IconHistory, IconChartBar, IconReportAnalytics, IconReceipt, IconApi, IconUpload, IconRocket, IconPlug } from '@tabler/icons-react';
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
            label="Setup Wizard"
            href="/admin/setup"
            leftSection={<IconRocket size={18} />}
            active={pathname === '/admin/setup'}
          />
          <NavLink
            label="Contract Dashboard"
            href="/admin/dashboard"
            leftSection={<IconChartBar size={18} />}
            active={pathname === '/admin/dashboard'}
          />
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
          <NavLink
            label="Timesheet Approvals"
            href="/admin/approvals"
            leftSection={<IconChecklist size={18} />}
            active={pathname === '/admin/approvals'}
          />
          <NavLink
            label="Labor Categories"
            href="/admin/labor-categories"
            leftSection={<IconCategory size={18} />}
            active={pathname === '/admin/labor-categories'}
          />
          <NavLink
            label="Audit Trail"
            href="/admin/audit-trail"
            leftSection={<IconHistory size={18} />}
            active={pathname === '/admin/audit-trail'}
          />
          <NavLink
            label="User Management"
            href="/admin/users"
            leftSection={<IconUserCog size={18} />}
            active={pathname === '/admin/users'}
          />
          <NavLink
            label="Indirect Codes"
            href="/admin/indirect-codes"
            leftSection={<IconReceipt size={18} />}
            active={pathname === '/admin/indirect-codes'}
          />
          <NavLink
            label="Data Import"
            href="/admin/import"
            leftSection={<IconUpload size={18} />}
            active={pathname === '/admin/import'}
          />
          <NavLink
            label="API Keys"
            href="/admin/api-keys"
            leftSection={<IconApi size={18} />}
            active={pathname === '/admin/api-keys'}
          />
          <NavLink
            label="Integrations"
            href="/admin/integrations"
            leftSection={<IconPlug size={18} />}
            active={pathname === '/admin/integrations'}
          />
          <NavLink
            label="Reports & Export"
            href="/admin/reports"
            leftSection={<IconReportAnalytics size={18} />}
            active={pathname === '/admin/reports'}
          />
        </>
      )}
    </Stack>
  );
}
