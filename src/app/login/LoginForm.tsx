'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Center,
  Stack,
  Paper,
  Title,
  TextInput,
  PasswordInput,
  Button,
  Alert,
  Avatar,
  Group,
  Text,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { signIn } from 'next-auth/react';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError('Invalid email or password');
      return;
    }

    router.push('/timesheet');
    router.refresh();
  }

  return (
    <Center mih="100vh" bg="var(--mantine-color-body)">
      <Paper shadow="md" p="xl" radius="md" w={420} withBorder>
        <Stack align="center" mb="lg">
          <Avatar src="/logo.png" size="lg" radius="sm" />
          <Title order={2}>ByTime</Title>
          <Text c="dimmed" size="sm">
            DCAA-Compliant Timekeeping
          </Text>
        </Stack>

        {error && (
          <Alert
            icon={<IconAlertCircle size={16} />}
            color="red"
            mb="md"
            variant="light"
          >
            {error}
          </Alert>
        )}

        <form onSubmit={handleSubmit}>
          <Stack>
            <TextInput
              label="Email"
              placeholder="you@company.com"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
            <PasswordInput
              label="Password"
              placeholder="Enter your password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <Button type="submit" fullWidth loading={loading}>
              Sign In
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
