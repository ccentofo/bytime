'use client';

import { useEffect } from 'react';
import { Center, Stack, Title, Text, Button, Group, Paper } from '@mantine/core';
import { IconAlertTriangle, IconRefresh, IconHome } from '@tabler/icons-react';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Root error:', error);
  }, [error]);

  return (
    <Center mih="100vh" p="xl">
      <Paper shadow="md" p="xl" radius="md" w={480} withBorder>
        <Stack align="center" gap="md">
          <IconAlertTriangle size={48} color="var(--mantine-color-red-6)" />
          <Title order={2} ta="center">Something Went Wrong</Title>
          <Text c="dimmed" ta="center" size="sm">
            An unexpected error occurred. This has been logged for review.
            Please try again or return to the home page.
          </Text>
          <Group mt="md">
            <Button
              leftSection={<IconRefresh size={16} />}
              onClick={reset}
              variant="filled"
            >
              Try Again
            </Button>
            <Button
              leftSection={<IconHome size={16} />}
              component="a"
              href="/"
              variant="default"
            >
              Go Home
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Center>
  );
}
