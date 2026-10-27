'use client';

import { useEffect, useId, useState } from 'react';
import { ActionIcon, Badge, Collapse, Divider, Indicator, Menu, NavLink, Stack, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import {
  activeHref, isGroup, isSettingsPath, mainNav, navLeaves, SETTINGS_BACK, SETTINGS_NAV, toNavRole,
  type NavGroup, type NavLeaf,
} from './nav-config';

type AppNavbarProps = {
  userRole?: string | null;
  /** When true, render an icon-only rail (tooltips; groups open a flyout menu). */
  collapsed?: boolean;
  /** Timesheets waiting for this approver (null = unknown / not an approver). Shown on Approvals when > 0. */
  waitingCount?: number | null;
};

/** Open/closed choice per group, remembered across visits. Read only after mount (no hydration mismatch). */
export const NAV_GROUPS_KEY = 'cadenzpoint-nav-groups';
const APPROVALS_HREF = '/admin/approvals';

const railStyles = {
  root: { justifyContent: 'center', paddingInline: 0 },
  section: { marginInlineEnd: 0 },
  body: { display: 'none' },
} as const;

/**
 * The sidebar (feature-plan-ux-navigation-home.md §4.2): a short main menu by role with collapsible groups, or — on a
 * /settings page — the Settings menu with a way back. Prefix-based active state, so sub-pages highlight their section.
 */
export function AppNavbar({ userRole, collapsed = false, waitingCount = null }: AppNavbarProps) {
  const pathname = usePathname() ?? '';
  const role = toNavRole(userRole);
  const settingsMode = isSettingsPath(pathname) && role === 'admin';
  const [stored, setStored] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(NAV_GROUPS_KEY);
      if (raw) setStored(JSON.parse(raw));
    } catch { /* storage unavailable or malformed: groups stay closed unless active */ }
  }, []);

  function toggleGroup(key: string) {
    setStored((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { window.localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  const waiting = waitingCount && waitingCount > 0 ? waitingCount : null;

  if (settingsMode) {
    const back = SETTINGS_BACK(role);
    const active = activeHref(pathname, SETTINGS_NAV);
    return (
      <Stack gap={0} pt="sm">
        <Leaf leaf={back} active={false} collapsed={collapsed} />
        <Divider my="sm" />
        {!collapsed && <Text size="xs" fw={700} c="dimmed" px="md" mb={4}>Settings</Text>}
        {SETTINGS_NAV.map((leaf) => <Leaf key={leaf.href} leaf={leaf} active={leaf.href === active} collapsed={collapsed} />)}
      </Stack>
    );
  }

  const entries = mainNav(role);
  const active = activeHref(pathname, navLeaves(entries));
  const settings = entries.find((e) => !isGroup(e) && e.href === '/settings/workspace') as NavLeaf | undefined;
  const top = entries.filter((e) => e !== settings);

  return (
    <Stack gap={0} pt="sm">
      {top.map((entry) => (isGroup(entry)
        ? <Group key={entry.key} group={entry} activeHref={active} collapsed={collapsed} opened={stored[entry.key] ?? false} onToggle={() => toggleGroup(entry.key)} />
        : <Leaf key={entry.href} leaf={entry} active={entry.href === active} collapsed={collapsed} waiting={entry.href === APPROVALS_HREF ? waiting : null} />))}
      {settings && (
        <>
          <Divider my="sm" />
          <Leaf leaf={settings} active={settings.href === active} collapsed={collapsed} />
        </>
      )}
    </Stack>
  );
}

function Leaf({ leaf, active, collapsed, waiting = null }: { leaf: NavLeaf; active: boolean; collapsed: boolean; waiting?: number | null }) {
  const Icon = Icons[leaf.icon];
  if (collapsed) {
    const name = waiting ? `${leaf.label}, ${waiting} waiting` : leaf.label;
    const icon = <Icon size={ICON_SIZE.nav} />;
    return (
      <Tooltip label={name} position="right" withArrow openDelay={200} events={{ hover: true, focus: true, touch: false }}>
        <NavLink
          component={Link}
          href={leaf.href}
          active={active}
          aria-current={active ? 'page' : undefined}
          aria-label={name}
          leftSection={waiting ? <Indicator label={waiting} size={16} offset={2}>{icon}</Indicator> : icon}
          styles={railStyles}
        />
      </Tooltip>
    );
  }
  return (
    <NavLink
      component={Link}
      href={leaf.href}
      active={active}
      aria-current={active ? 'page' : undefined}
      leftSection={<Icon size={ICON_SIZE.nav} />}
      label={waiting ? <>{leaf.label}<VisuallyHidden>{`, ${waiting} waiting`}</VisuallyHidden></> : leaf.label}
      rightSection={waiting ? <Badge size="sm" circle aria-hidden>{waiting}</Badge> : undefined}
    />
  );
}

function Group({ group, activeHref: active, collapsed, opened, onToggle }: {
  group: NavGroup; activeHref: string | null; collapsed: boolean; opened: boolean; onToggle: () => void;
}) {
  const childrenId = useId();
  const Icon = Icons[group.icon];
  const containsActive = group.children.some((c) => c.href === active);

  if (collapsed) {
    return (
      <Menu position="right-start" withinPortal withInitialFocusPlaceholder={false}>
        <Menu.Target>
          <ActionIcon
            variant={containsActive ? 'light' : 'subtle'}
            size="xl"
            mx="auto"
            my={2}
            aria-label={group.label}
            data-active={containsActive || undefined}
          >
            <Icon size={ICON_SIZE.nav} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{group.label}</Menu.Label>
          {group.children.map((child) => (
            <Menu.Item key={child.href} component={Link} href={child.href} aria-current={child.href === active ? 'page' : undefined}>
              {child.label}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    );
  }

  // The group holding the current page is forced open: its toggle does nothing and shows no chevron.
  const isOpen = containsActive || opened;
  const Chevron = isOpen ? Icons.collapse : Icons.expand;
  return (
    <>
      <NavLink
        component="button"
        type="button"
        label={group.label}
        leftSection={<Icon size={ICON_SIZE.nav} />}
        rightSection={containsActive ? undefined : <Chevron size={14} />}
        aria-expanded={isOpen}
        aria-controls={childrenId}
        onClick={containsActive ? undefined : onToggle}
      />
      <Collapse id={childrenId} expanded={isOpen}>
        {group.children.map((child) => (
          <NavLink
            key={child.href}
            component={Link}
            href={child.href}
            label={child.label}
            active={child.href === active}
            aria-current={child.href === active ? 'page' : undefined}
            pl={44}
          />
        ))}
      </Collapse>
    </>
  );
}
