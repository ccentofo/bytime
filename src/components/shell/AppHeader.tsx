'use client';

import { Group, Title, Avatar, ActionIcon, Text, Menu, UnstyledButton, useMantineColorScheme, Box } from '@mantine/core';
import { IconSun, IconMoon, IconLogout, IconUser, IconKey, IconBell } from '@tabler/icons-react';
import { signOut } from 'next-auth/react';
import { SyncStatusIndicator } from '@/components/shell/SyncStatusIndicator';

type AppHeaderProps = {
  user?: {
    fullName: string;
    email: string;
    role: string;
  } | null;
};

export function AppHeader({ user }: AppHeaderProps) {
  const { toggleColorScheme } = useMantineColorScheme();

  return (
    <Group h="100%" px="md" justify="space-between">
      <Group gap="sm">
        <Avatar src="/logo.png" size="md" radius="sm" />
        <Title order={3}>ByTime</Title>
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
                  <Avatar radius="xl" size="sm" color="blue">
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
                component="a"
                href="/profile"
              >
                Change Password
              </Menu.Item>
              <Menu.Item
                leftSection={<IconBell size={14} />}
                component="a"
                href="/admin/notifications"
              >
                Notification Settings
              </Menu.Item>
              <Menu.Item
                color="red"
                leftSection={<IconLogout size={14} />}
                onClick={() => signOut({ callbackUrl: '/login' })}
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
