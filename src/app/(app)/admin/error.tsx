'use client';

import { useEffect } from 'react';
import { Container, Stack, Text, Button, Group, Alert, Title } from '@mantine/core';
import { IconAlertTriangle, IconRefresh, IconClock } from '@tabler/icons-react';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Admin error:', error);
  }, [error]);

  const isForbidden = error.message?.includes('Forbidden') || error.message?.includes('Admin or Supervisor');

  return (
    <Container size="sm" py="xl">
      <title>Something went wrong – CadenzPoint</title>
      <Stack align="center" gap="lg">
        <Alert
          icon={<IconAlertTriangle size={24} />}
          // The alert title is this screen's h1 (inherits the alert title's look).
          title={<Title order={1} fz="inherit" fw="inherit" lh="inherit" ff="inherit">{isForbidden ? 'Access Denied' : 'Admin Page Error'}</Title>}
          color={isForbidden ? 'warning' : 'red'}
          variant="light"
          w="100%"
        >
          <Text size="sm">
            {isForbidden
              ? 'You do not have permission to access this page. Only administrators and supervisors can view admin pages.'
              : 'An error occurred while loading this admin page. Please try again.'}
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
