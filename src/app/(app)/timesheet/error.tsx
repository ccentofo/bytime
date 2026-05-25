'use client';

import { useEffect } from 'react';
import { Container, Stack, Title, Text, Button, Group, Alert, Paper } from '@mantine/core';
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
      <Paper shadow="sm" p="xl" radius="md" withBorder>
        <Stack align="center" gap="md">
          <IconAlertTriangle size={48} color="var(--mantine-color-orange-6)" />
          <Title order={3} ta="center">Timesheet Error</Title>
          <Text c="dimmed" ta="center" size="sm">
            {isNetworkError
              ? 'Unable to connect to the server. Check your internet connection and try again. Your offline data is preserved.'
              : isAuthError
              ? 'Your session may have expired. Please try again or sign in.'
              : 'An error occurred while loading your timesheet. Your data is safe — please try refreshing.'}
          </Text>
          <Alert color="blue" variant="light" w="100%">
            <Text size="xs">
              💡 If you were working offline, your unsaved entries are stored locally
              and will sync when the connection is restored.
            </Text>
          </Alert>
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
