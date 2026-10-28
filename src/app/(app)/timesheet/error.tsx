'use client';

import { useEffect } from 'react';
import { Container, Stack, Title, Text, Button, Group, Paper } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';

export default function TimesheetError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Timesheet error:', error);
  }, [error]);

  // Check for common timesheet-specific errors
  const isNetworkError = error.message?.includes('fetch') || error.message?.includes('network');
  const isAuthError = error.message?.includes('Unauthorized') || error.message?.includes('session');

  return (
    <Container size="sm" py="xl">
      <title>Something went wrong – CadenzPoint</title>
      <Paper shadow="sm" p="xl" radius="md" withBorder>
        <Stack align="center" gap="md">
          <IconAlertTriangle size={48} color="var(--mantine-color-warning-6)" />
          <Title order={1} size="h3" ta="center">Timesheet Error</Title>
          <Text c="dimmed" ta="center" size="sm">
            {isNetworkError
              ? 'Unable to connect to the server. Check your internet connection and try again. Changes you hadn\'t saved yet weren\'t sent.'
              : isAuthError
              ? 'Your session may have expired. Please try again or sign in.'
              : 'An error occurred while loading your timesheet. Your data is safe — please try refreshing.'}
          </Text>
          <Group mt="sm">
            <Button
              leftSection={<IconRefresh size={16} />}
              onClick={reset}
            >
              Reload Timesheet
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Container>
  );
}
