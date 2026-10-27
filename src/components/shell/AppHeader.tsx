'use client';

import { Group, Avatar, ActionIcon, Text, Menu, UnstyledButton, useMantineColorScheme, Box, Burger, Badge, Tooltip } from '@mantine/core';
import Link from 'next/link';
import { Logo } from '@/components/brand/Logo';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { DANGER_MENU_ITEM_CLASS } from '@/components/ui/RowActions';
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

/** The role as a word (UX-2 §4.2), never the raw value. */
const ROLE_WORD: Record<string, string> = { admin: 'Admin', supervisor: 'Supervisor', employee: 'Employee' };

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
          // Mantine's Burger sets no aria-expanded (UX-2 §4.2).
          aria-expanded={mobileNavOpened ?? false}
          aria-label={mobileNavOpened ? 'Close navigation' : 'Open navigation'}
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
          <Box lightHidden><Icons.themeLight size={20} /></Box>
          <Box darkHidden><Icons.themeDark size={20} /></Box>
        </ActionIcon>
        {user && (
          <Menu shadow="md" width={220} position="bottom-end" withInitialFocusPlaceholder={false}>
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
              <Menu.Label>{user.fullName}</Menu.Label>
              <Menu.Label>{user.email}</Menu.Label>
              <Menu.Label>{ROLE_WORD[user.role] ?? 'Employee'}</Menu.Label>
              <Menu.Divider />
              <Menu.Item
                leftSection={<Icons.profile size={ICON_SIZE.menu} />}
                component={Link}
                href="/profile"
              >
                Profile and security
              </Menu.Item>
              <Menu.Item
                leftSection={<Icons.notifications size={ICON_SIZE.menu} />}
                component={Link}
                href="/profile/notifications"
              >
                Notifications
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                className={DANGER_MENU_ITEM_CLASS}
                leftSection={<Icons.signOut size={ICON_SIZE.menu} />}
                onClick={() => { void signOutToLogin(); }}
              >
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
    </Group>
  );
}
