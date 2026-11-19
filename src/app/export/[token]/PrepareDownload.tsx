'use client';

import { useActionState, useSyncExternalStore } from 'react';
import { Alert, Anchor, Button, Stack, Text } from '@mantine/core';
import { EXPIRED_TEXT } from '@/lib/export/format';
import { prepareExportDownload, type PrepareState } from '@/server/actions/export-download';

/**
 * feature-plan-cloud-export.md §6.6: the "Prepare download" form (a server action through useActionState; P2, product
 * owner 2026-11-18: it needs JavaScript). Without JavaScript the button stays disabled and says so. After a successful
 * POST, a plain Download link to the 5-minute URL (a navigation, so the CSP's form-action doesn't apply).
 */
const noSubscribe = () => () => {};

export function PrepareDownload({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<PrepareState, FormData>(prepareExportDownload, { status: 'idle' });
  // false on the server render (and so without JavaScript), true once hydrated.
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);

  if (state.status === 'unavailable') return <Text data-testid="export-expired">{EXPIRED_TEXT}</Text>;
  return (
    <Stack gap="sm">
      {state.status === 'ready' ? (
        <Stack gap={4} data-testid="export-ready">
          <Anchor href={state.url} rel="noreferrer" fw={600} data-testid="export-download-link">Download</Anchor>
          <Text size="sm" c="dimmed">The download link is valid for 5 minutes. If it doesn&apos;t work, prepare it again.</Text>
        </Stack>
      ) : null}
      {state.status === 'rate-limited' ? (
        <Alert color="warning" data-testid="export-rate-limited">Too many download attempts. Try again later.</Alert>
      ) : null}
      {state.status === 'misconfigured' ? (
        <Alert color="red" data-testid="export-misconfigured">Downloads aren&apos;t available right now. Contact support@cadenzpoint.com.</Alert>
      ) : null}
      <form action={formAction}>
        <input type="hidden" name="token" value={token} />
        <Button type="submit" disabled={!hydrated || pending} loading={pending} data-testid="export-prepare">
          {hydrated ? (state.status === 'ready' ? 'Prepare again' : 'Prepare download') : 'Turn on JavaScript to download'}
        </Button>
      </form>
    </Stack>
  );
}
