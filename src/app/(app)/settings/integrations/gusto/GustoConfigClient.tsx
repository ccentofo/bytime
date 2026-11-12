'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Anchor, Button, Container, Group } from '@mantine/core';
import { PageHeader } from '@/components/ui/PageHeader';
import { Notice } from '@/components/ui/Notice';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { runAction } from '@/lib/run-action';
import { disconnectIntegration } from '@/server/actions/integrations';

/** I10, §3.2: the Gusto page is honest — nothing is sent to Gusto. */
export const GUSTO_PAGE_NOTE = 'Sending hours straight to Gusto isn’t available yet. Download payroll files for Gusto from Payroll export.';

const TITLE = 'Gusto';

export function GustoConfigClient({ connection }: { connection: { id: string; companyName: string | null } }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    setDisconnecting(true);
    const result = await runAction(disconnectIntegration(connection.id), { silent: true });
    if (!result.ok) {
      setDisconnecting(false);
      setError(result.error);
      return;
    }
    window.location.href = '/settings/integrations';
  }

  return (
    <Container size="lg" py="xl">
      <PageHeader
        title={TITLE}
        breadcrumb={<><Anchor component={Link} href="/settings/integrations" size="sm">Integrations</Anchor> › {TITLE}</>}
        description={connection.companyName ?? undefined}
        actions={(
          <Group gap="xs">
            <Button component={Link} href="/admin/payroll-export" variant="filled">Open Payroll export</Button>
            <WriteButton variant="subtle" color="red" onClick={() => { setError(null); setConfirmOpen(true); }}>Disconnect…</WriteButton>
          </Group>
        )}
      />
      <Notice tone="info">{GUSTO_PAGE_NOTE}</Notice>
      <ConfirmModal
        opened={confirmOpen}
        title="Disconnect Gusto?"
        message="This removes the stored sign-in for Gusto."
        confirmLabel="Disconnect"
        loading={disconnecting}
        error={error}
        onConfirm={disconnect}
        onCancel={() => setConfirmOpen(false)}
      />
    </Container>
  );
}
