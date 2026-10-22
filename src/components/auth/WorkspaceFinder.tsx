'use client';

import { useState } from 'react';
import { Center, Stack, Paper, Title, Text, TextInput, Button, Alert, Anchor } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { Logo } from '@/components/brand/Logo';
import { goToWorkspace } from '@/server/actions/workspace-finder';

/**
 * Apex "Find your workspace" form (feature-plan-launch-blockers.md P2). Shown instead of the sign-in /
 * forgot-password form on the apex, where no workspace is in context. The redirect itself is server-side.
 */
export function WorkspaceFinder({ target, rootDomain }: { target: '/login' | '/forgot-password'; rootDomain: string }) {
  const [slug, setSlug] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await goToWorkspace(slug, target);
      if (result?.error) setError(result.error);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Center mih="100vh" bg="var(--mantine-color-body)">
      <Paper shadow="md" p="xl" radius="md" w={420} withBorder>
        <Stack align="center" mb="lg">
          <Logo size="lg" />
          <Title order={3}>Find your workspace</Title>
          <Text c="dimmed" size="sm" ta="center">
            {target === '/login'
              ? 'Enter your workspace name to go to your sign-in page.'
              : 'Enter your workspace name to reset your password there.'}
          </Text>
        </Stack>

        {error && (
          <Alert icon={<IconAlertCircle size={16} />} color="red" mb="md" variant="light">
            {error}
          </Alert>
        )}

        <form onSubmit={handleSubmit}>
          <Stack>
            <TextInput
              label="Workspace name"
              placeholder="acme"
              required
              value={slug}
              onChange={(e) => setSlug(e.currentTarget.value)}
              autoComplete="organization"
              description={`Your workspace address looks like ${slug.trim().toLowerCase() || 'your-company'}.${rootDomain}`}
            />
            <Button type="submit" fullWidth loading={loading}>
              Continue
            </Button>
          </Stack>
        </form>

        <Text size="sm" c="dimmed" ta="center" mt="lg">
          New to CadenzPoint? <Anchor href="/signup" size="sm">Start a free trial</Anchor>
        </Text>
      </Paper>
    </Center>
  );
}
