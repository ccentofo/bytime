'use client';

import { Group, Avatar, ActionIcon, Text, Menu, UnstyledButton, useMantineColorScheme, Box, Burger, Badge, Tooltip } from '@mantine/core';
import Link from 'next/link';
import { Logo } from '@/components/brand/Logo';
import { IconSun, IconMoon, IconLogout, IconUser, IconKey, IconBell } from '@tabler/icons-react';
import { signOutToLogin } from '@/components/auth/sign-out';
import { SyncStatusIndicator } from '@/components/shell/SyncStatusIndicator';

type AppHeaderProps = {
  user?: {
    fullName: string;
    email: string;
    role: string;
  } | null;
  /** Mobile nav toggle — wired to AppShellWrapper's useDisclosure toggle */
  mobileNavOpened?: boolean;
  onMobileNavToggle?: () => void;
  /** F1: lifecycle-exempt demo/internal workspace — always visibly marked, never hidden. */
  isDemo?: boolean;
};

export function AppHeader({ user, mobileNavOpened, onMobileNavToggle, isDemo = false }: AppHeaderProps) {
  const { toggleColorScheme } = useMantineColorScheme();

  return (
    <Group h="100%" px="md" justify="space-between">
      <Group gap="sm">
        {/* Burger shown only on mobile (hiddenFrom="sm") to open the overlay nav */}
        <Burger
          opened={mobileNavOpened ?? false}
          onClick={onMobileNavToggle}
          hiddenFrom="sm"
          size="sm"
          aria-label="Toggle navigation"
        />
        <Logo size="sm" />
        {isDemo && (
          <Tooltip label="Demo workspace: exempt from trial expiry and billing">
            <Badge color="ink" variant="filled" size="sm">Demo</Badge>
          </Tooltip>
        )}
      </Group>
      <Group gap="sm">
        <SyncStatusIndicator />
        <ActionIcon
          variant="subtle"
          size="lg"
          onClick={toggleColorScheme}
          aria-label="Toggle color scheme"
        >
          <Box lightHidden><IconSun size={20} /></Box>
          <Box darkHidden><IconMoon size={20} /></Box>
        </ActionIcon>
        {user && (
          <Menu shadow="md" width={200} position="bottom-end">
            <Menu.Target>
              <UnstyledButton>
                <Group gap="xs">
                  <Avatar radius="xl" size="sm" color="signal">
                    {user.fullName.charAt(0)}
                  </Avatar>
                  <Text size="sm" fw={500}>
                    {user.fullName}
                  </Text>
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{user.email}</Menu.Label>
              <Menu.Label>Role: {user.role}</Menu.Label>
              <Menu.Divider />
              <Menu.Item
                leftSection={<IconKey size={14} />}
                component={Link}
                href="/profile"
              >
                Change Password
              </Menu.Item>
              <Menu.Item
                leftSection={<IconBell size={14} />}
                component={Link}
                href="/admin/notifications"
              >
                Notification Settings
              </Menu.Item>
              <Menu.Item
                color="red"
                leftSection={<IconLogout size={14} />}
                onClick={() => { void signOutToLogin(); }}
              >
                Sign Out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
    </Group>
  );
}
