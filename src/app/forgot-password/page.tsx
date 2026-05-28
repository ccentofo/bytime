'use client';

import { useState } from 'react';
import {
  Center,
  Stack,
  Paper,
  Title,
  TextInput,
  Button,
  Alert,
  Text,
  Anchor,
  Avatar,
} from '@mantine/core';
import { IconMail, IconCheck, IconArrowLeft } from '@tabler/icons-react';
import { requestPasswordReset } from '@/server/actions/password-reset';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await requestPasswordReset(email);

    setLoading(false);

    if (result.error) {
      setError(result.error);
    } else {
      setSent(true);
    }
  }

  return (
    <Center mih="100vh" bg="var(--mantine-color-body)">
      <Paper shadow="md" p="xl" radius="md" w={420} withBorder>
        <Stack align="center" mb="lg">
          <Avatar src="/logo.png" size="lg" radius="sm" />
          <Title order={2}>Reset Password</Title>
          <Text c="dimmed" size="sm" ta="center">
            Enter your email and we'll send you a link to reset your password.
          </Text>
        </Stack>

        {sent ? (
          <Stack align="center" gap="md">
            <Alert icon={<IconCheck size={16} />} color="green" variant="light">
              If an account exists with that email, we've sent a password reset link.
              Please check your inbox (and spam folder).
            </Alert>
            <Text size="sm" c="dimmed" ta="center">
              The link will expire in 1 hour.
            </Text>
            <Anchor href="/login" size="sm">
              <IconArrowLeft size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
              Back to Sign In
            </Anchor>
          </Stack>
        ) : (
          <form onSubmit={handleSubmit}>
            <Stack>
              {error && (
                <Alert color="red" variant="light">
                  {error}
                </Alert>
              )}
              <TextInput
                label="Email"
                placeholder="you@company.com"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus
              />
              <Button
                type="submit"
                fullWidth
                loading={loading}
                leftSection={<IconMail size={16} />}
              >
                Send Reset Link
              </Button>
              <Anchor href="/login" size="sm" ta="center">
                <IconArrowLeft size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                Back to Sign In
              </Anchor>
            </Stack>
          </form>
        )}
      </Paper>
    </Center>
  );
}
