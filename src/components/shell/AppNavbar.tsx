'use client';

import type { ReactNode } from 'react';
import { Stack, NavLink, Divider, Text, Tooltip } from '@mantine/core';
import { IconClock, IconFileText, IconUsers, IconChecklist, IconUserCog, IconCategory, IconHistory, IconChartBar, IconReportAnalytics, IconReceipt, IconApi, IconUpload, IconRocket, IconPlug, IconSettings, IconDatabaseImport, IconTag } from '@tabler/icons-react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

type AppNavbarProps = {
  userRole?: string | null;
  /** When true, render an icon-only rail with hover tooltips (still navigable). */
  collapsed?: boolean;
};

type NavItem = { label: string; href: string; icon: ReactNode };

const TIMEKEEPING_ITEMS: NavItem[] = [
  { label: 'My Timesheet', href: '/timesheet', icon: <IconClock size={18} /> },
];

// Visible to both admins and supervisors (approvers).
const APPROVER_ITEMS: NavItem[] = [
  { label: 'Timesheet Approvals', href: '/admin/approvals', icon: <IconChecklist size={18} /> },
  { label: 'Audit Trail', href: '/admin/audit-trail', icon: <IconHistory size={18} /> },
  { label: 'Reports & Export', href: '/admin/reports', icon: <IconReportAnalytics size={18} /> },
];

// Admin-only.
const ADMIN_ITEMS: NavItem[] = [
  { label: 'Setup Wizard', href: '/admin/setup', icon: <IconRocket size={18} /> },
  { label: 'Contract Dashboard', href: '/admin/dashboard', icon: <IconChartBar size={18} /> },
  { label: 'Contracts & CLINs', href: '/admin/contracts', icon: <IconFileText size={18} /> },
  { label: 'Charge Codes', href: '/admin/charge-codes', icon: <IconTag size={18} /> },
  { label: 'User Assignments', href: '/admin/assignments', icon: <IconUsers size={18} /> },
  { label: 'Labor Categories', href: '/admin/labor-categories', icon: <IconCategory size={18} /> },
  { label: 'User Management', href: '/admin/users', icon: <IconUserCog size={18} /> },
  { label: 'Indirect Codes', href: '/admin/indirect-codes', icon: <IconReceipt size={18} /> },
  { label: 'Data Import', href: '/admin/import', icon: <IconUpload size={18} /> },
  { label: 'API Keys', href: '/admin/api-keys', icon: <IconApi size={18} /> },
  { label: 'Integrations', href: '/admin/integrations', icon: <IconPlug size={18} /> },
  { label: 'Data Migration', href: '/admin/migration', icon: <IconDatabaseImport size={18} /> },
  { label: 'Settings', href: '/admin/settings', icon: <IconSettings size={18} /> },
];

export function AppNavbar({ userRole, collapsed = false }: AppNavbarProps) {
  const pathname = usePathname();
  const isAdmin = userRole === 'admin';
  const isApprover = userRole === 'admin' || userRole === 'supervisor';

  function renderItem(item: NavItem) {
    const link = (
      <NavLink
        component={Link}
        label={collapsed ? undefined : item.label}
        href={item.href}
        leftSection={item.icon}
        active={pathname === item.href}
        aria-label={item.label}
        styles={
          collapsed
            ? {
                // Hide the (empty) label body so its flex:1 doesn't shove the icon left;
                // then the icon centers in the rail.
                root: { justifyContent: 'center', paddingInline: 0 },
                section: { marginInlineEnd: 0 },
                body: { display: 'none' },
              }
            : undefined
        }
      />
    );

    // Collapsed rail: reveal the label on hover so the icons remain navigable + discoverable.
    return collapsed ? (
      <Tooltip key={item.href} label={item.label} position="right" withArrow openDelay={200}>
        {link}
      </Tooltip>
    ) : (
      <span key={item.href}>{link}</span>
    );
  }

  return (
    <Stack gap={0} pt="sm">
      {/* Employee Section */}
      {collapsed ? (
        <Divider mb={4} />
      ) : (
        <Text size="xs" fw={700} c="dimmed" px="md" mb={4}>
          TIMEKEEPING
        </Text>
      )}
      {TIMEKEEPING_ITEMS.map(renderItem)}

      {isApprover && (
        <>
          <Divider my="sm" />
          {/* Approver Section */}
          {!collapsed && (
            <Text size="xs" fw={700} c="dimmed" px="md" mb={4}>
              APPROVALS
            </Text>
          )}
          {APPROVER_ITEMS.map(renderItem)}
        </>
      )}

      {isAdmin && (
        <>
          <Divider my="sm" />
          {/* Admin Section */}
          {!collapsed && (
            <Text size="xs" fw={700} c="dimmed" px="md" mb={4}>
              ADMINISTRATION
            </Text>
          )}
          {ADMIN_ITEMS.map(renderItem)}
        </>
      )}
    </Stack>
  );
}
