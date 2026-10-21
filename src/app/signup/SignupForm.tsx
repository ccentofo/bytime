'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Center, Stack, Paper, Title, TextInput, Button, Alert, Text, Anchor, Badge, Checkbox,
} from '@mantine/core';
import { IconAlertCircle, IconCheck } from '@tabler/icons-react';
import { Logo } from '@/components/brand/Logo';
import { startSignup } from '@/server/actions/signup';
import { slugify } from '@/lib/tenant/slugify';

export function SignupForm({ errorParam }: { errorParam?: string }) {
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugStatus, setSlugStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState(errorParam ?? '');
  const checkTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-derive slug from company name unless user has edited it manually
  useEffect(() => {
    if (!slugEdited && companyName) {
      setSlug(slugify(companyName));
    }
  }, [companyName, slugEdited]);

  // Live slug availability check with debounce
  useEffect(() => {
    if (!slug) { setSlugStatus('idle'); return; }
    setSlugStatus('checking');
    if (checkTimeout.current) clearTimeout(checkTimeout.current);
    checkTimeout.current = setTimeout(async () => {
      try {
        const res = await fetch(`/signup/check?slug=${encodeURIComponent(slug)}`);
        const data = await res.json();
        if (data.available) setSlugStatus('available');
        else if (data.reason === 'invalid') setSlugStatus('invalid');
        else setSlugStatus('taken');
      } catch {
        setSlugStatus('idle');
      }
    }, 400);
    return () => { if (checkTimeout.current) clearTimeout(checkTimeout.current); };
  }, [slug]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    // D8: capture the signer's browser timezone so the new tenant's workspace starts configured
    // for the right zone instead of the generic default. Best-effort — undefined if unsupported.
    const timezone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
    const result = await startSignup({ companyName, email, slug: slug || undefined, timezone, termsAccepted });
    setLoading(false);
    if (result.success) {
      setSuccess(true);
    } else {
      setError(result.error ?? 'Something went wrong. Please try again.');
    }
  }

  if (success) {
    return (
      <Center mih="100vh">
        <Paper withBorder shadow="sm" p={40} radius="md" w="100%" maw={440}>
          <Stack align="center" gap="md">
            <IconCheck size={48} color="var(--mantine-color-success-6)" />
            <Title order={2} ta="center">Check your email</Title>
            <Text c="dimmed" ta="center" size="sm">
              We sent a confirmation link to <strong>{email}</strong>. Click it to finish creating your workspace.
              The link expires in 24 hours.
            </Text>
            <Text size="xs" c="dimmed" ta="center">
              Didn't receive it? Check your spam folder or{' '}
              <Anchor onClick={() => { setSuccess(false); }} size="xs">try again</Anchor>.
            </Text>
          </Stack>
        </Paper>
      </Center>
    );
  }

  const slugColor = slugStatus === 'available' ? 'success' : slugStatus === 'taken' || slugStatus === 'invalid' ? 'red' : 'gray';
  const slugMessage = slugStatus === 'available' ? '✓ Available'
    : slugStatus === 'taken' ? 'Already taken'
    : slugStatus === 'invalid' ? 'Invalid — use letters, numbers, hyphens'
    : slugStatus === 'checking' ? 'Checking…' : '';

  return (
    <Center mih="100vh">
      <Paper withBorder shadow="sm" p={40} radius="md" w="100%" maw={440}>
        <Stack gap="lg">
          <Stack align="center" gap={4}>
            <Logo size="lg" />
            <Title order={2}>Create your workspace</Title>
            <Text size="sm" c="dimmed" ta="center">Start your free CadenzPoint trial — no credit card required</Text>
          </Stack>

          {error && (
            <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
              {error}
            </Alert>
          )}

          <form onSubmit={handleSubmit}>
            <Stack gap="md">
              <TextInput
                label="Company name"
                placeholder="Acme Corp"
                value={companyName}
                onChange={(e) => setCompanyName(e.currentTarget.value)}
                required
                disabled={loading}
              />

              <Stack gap={4}>
                <TextInput
                  label="Workspace name"
                  placeholder="acme"
                  value={slug}
                  onChange={(e) => { setSlug(e.currentTarget.value.toLowerCase()); setSlugEdited(true); }}
                  disabled={loading}
                  rightSection={slugMessage ? <Badge color={slugColor} size="xs" variant="light">{slugMessage}</Badge> : null}
                  rightSectionWidth={120}
                />
                <Text size="xs" c="dimmed">
                  Your team will log in at <strong>{slug || 'yourcompany'}.{process.env.NEXT_PUBLIC_APP_ROOT_DOMAIN ?? 'cadenzpoint.app'}</strong>
                </Text>
              </Stack>

              <TextInput
                label="Work email"
                type="email"
                placeholder="admin@yourcompany.com"
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
                required
                disabled={loading}
              />

              <Checkbox
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.currentTarget.checked)}
                disabled={loading}
                label={
                  <Text size="sm">
                    By creating a workspace you agree to the{' '}
                    <Anchor href="/terms" target="_blank" size="sm">Terms of Service</Anchor>
                    {' '}and{' '}
                    <Anchor href="/privacy" target="_blank" size="sm">Privacy Policy</Anchor>.
                  </Text>
                }
              />

              <Button
                type="submit"
                fullWidth
                size="md"
                loading={loading}
                disabled={slugStatus === 'taken' || slugStatus === 'invalid' || !termsAccepted}
              >
                Create workspace
              </Button>
            </Stack>
          </form>

          <Text size="xs" c="dimmed" ta="center">
            Already have an account?{' '}
            <Anchor href="/login" size="xs">Sign in</Anchor>
          </Text>
        </Stack>
      </Paper>
    </Center>
  );
}
