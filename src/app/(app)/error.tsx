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
        <Title order={1} size="h3" ta="center">Something went wrong</Title>
        <Alert
          icon={<IconAlertTriangle size={24} />}
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
