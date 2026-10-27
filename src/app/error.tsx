'use client';

import { useEffect } from 'react';
import { Center, Stack, Title, Text, Button, Group, Paper } from '@mantine/core';
import { IconAlertTriangle, IconRefresh, IconHome } from '@tabler/icons-react';
import * as Sentry from '@sentry/nextjs';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <Center component="main" mih="100vh" p="xl">
      {/* React 19 hoists this into <head> (error boundaries are client components — no metadata export). */}
      <title>Something went wrong – CadenzPoint</title>
      <Paper shadow="md" p="xl" radius="md" w={480} withBorder>
        <Stack align="center" gap="md">
          <IconAlertTriangle size={48} color="var(--mantine-color-red-6)" />
          <Title order={1} size="h2" ta="center">Something Went Wrong</Title>
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
