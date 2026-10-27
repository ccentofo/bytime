'use client';

import { useEffect } from 'react';
import { Container, Stack, Text, Button, Group, Alert, Title } from '@mantine/core';
import { IconAlertTriangle, IconRefresh, IconClock } from '@tabler/icons-react';
import * as Sentry from '@sentry/nextjs';

export default function AppError({
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
    <Container size="sm" py="xl">
      <title>Something went wrong – CadenzPoint</title>
      <Stack align="center" gap="lg">
        <Alert
          icon={<IconAlertTriangle size={24} />}
          // The alert title is this screen's h1 (inherits the alert title's look).
          title={<Title order={1} fz="inherit" fw="inherit" lh="inherit" ff="inherit">Something went wrong</Title>}
          color="red"
          variant="light"
          w="100%"
        >
          <Text size="sm">
            An error occurred while loading this page. This may be a temporary issue.
            Try refreshing the page, or navigate back to your timesheet.
          </Text>
        </Alert>
        <Group>
          <Button
            leftSection={<IconRefresh size={16} />}
            onClick={reset}
          >
            Try Again
          </Button>
          <Button
            leftSection={<IconClock size={16} />}
            component="a"
            href="/timesheet"
            variant="default"
          >
            Go to Timesheet
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}
