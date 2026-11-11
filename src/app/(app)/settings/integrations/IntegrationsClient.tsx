'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Anchor, Button, Container, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Icons } from '@/components/ui/icons';
import { WriteButton, useCanWrite } from '@/components/shell/WorkspaceMode';
import { formatInstant } from '@/lib/calendar-date';
import type { HubConnection } from '@/server/actions/integrations';
import { syncResultText } from '@/lib/integrations/sync-display';

export interface CallbackParams {
  connected: string | null;
  provider: string | null;
  error: string | null;
}

export type Banner = { kind: 'success' | 'error'; text: string; action?: { label: string; href: string } };

const QBO_PAGE = '/settings/integrations/quickbooks';
const PAYROLL_EXPORT = '/admin/payroll-export';

/** I10: the Gusto connector sends nothing to Gusto. */
export const GUSTO_HUB_NOTE = 'Sending hours straight to Gusto isn’t available yet. Download a Gusto payroll file from Payroll export.';

/** §3.1: the OAuth callback's result in words (null when the URL carries none). */
export function callbackBanner({ connected, provider, error }: CallbackParams): Banner | null {
  if (error) {
    const text = {
      connection_cancelled: 'Connecting was cancelled. Nothing changed.',
      connection_failed: 'Couldn’t finish connecting. Try again; if it keeps happening, contact support.',
      qbo_config_missing: 'QuickBooks isn’t set up for this server yet. Contact support.',
    }[error] ?? 'Couldn’t finish connecting.';
    return { kind: 'error', text };
  }
  if (connected === 'true') {
    return provider === 'qbo'
      ? { kind: 'success', text: 'QuickBooks Online is connected. Next, match your people, contracts and CLINs.', action: { label: 'Match now', href: QBO_PAGE } }
      : { kind: 'success', text: 'Connected.' };
  }
  return null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "Last sent {date} · {pushed} sent, {failed} failed · {n} people not matched", or "Nothing sent yet". A failed or
 * still-running last send reads in the §6 wording instead ("Failed: …", "Sending…", "Didn’t finish";
 * UX-4C2B-AUDIT.md F7).
 */
export function qboCardLine(conn: HubConnection, timeZone: string, now = Date.now()): string {
  const last = conn.lastSend;
  const result = last && (last.status === 'failed' || last.status === 'running')
    ? (() => {
      const t = syncResultText({ status: last.status, recordsPushed: last.pushed, recordsSkipped: last.skipped, errorSummary: last.errorSummary, startedAt: new Date(last.at), createdAt: new Date(last.at) }, now);
      return t.head + t.rest;
    })()
    : last ? `${last.pushed} sent, ${last.failed} failed` : null;
  const parts = [last ? `Last sent ${formatInstant(new Date(last.at), timeZone, 'MMM D, YYYY')} · ${result}` : 'Nothing sent yet'];
  if (conn.unmatchedPeople > 0) parts.push(`${plural(conn.unmatchedPeople, 'person', 'people')} not matched`);
  return parts.join(' · ');
}

/** A link to a connect route (an API route, so a plain anchor). Connecting stores a connection: read-only → WriteButton. */
function ConnectLink({ href, children, variant = 'filled' }: { href: string; children: string; variant?: 'filled' | 'default' }) {
  const canWrite = useCanWrite();
  if (!canWrite) return <WriteButton size="sm" variant={variant}>{children}</WriteButton>;
  return <Button component="a" href={href} size="sm" variant={variant}>{children}</Button>;
}

function Card({ title, sub, badge, description, line, children }: {
  title: string;
  sub: string;
  badge?: React.ReactNode;
  description: string;
  line?: string;
  children: React.ReactNode;
}) {
  return (
    <Paper withBorder p="md" radius="md" component="section" aria-label={title}>
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <div>
            <Title order={2} size="h4">{title}</Title>
            <Text size="sm" c="dimmed">{sub}</Text>
          </div>
          {badge}
        </Group>
        <Text size="sm" c="dimmed">{description}</Text>
        {line && <Text size="sm">{line}</Text>}
        <Group gap="xs" mt={4}>{children}</Group>
      </Stack>
    </Paper>
  );
}

export function IntegrationsClient({ hub, callback, workspaceTimezone }: {
  hub: { qbo: HubConnection | null; gusto: HubConnection | null; activeApiKeys: number };
  callback: CallbackParams;
  workspaceTimezone: string;
}) {
  // I1: the banner lives in state initialised from the server's props; the effect only drops the params from the URL.
  const [banner] = useState(() => callbackBanner(callback));
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!['connected', 'provider', 'error'].some((k) => url.searchParams.has(k))) return;
    for (const k of ['connected', 'provider', 'error']) url.searchParams.delete(k);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const { qbo, gusto } = hub;
  const BannerIcon = banner?.kind === 'error' ? Icons.statusError : Icons.statusSuccess;

  return (
    <Container size="lg" py="xl">
      <PageHeader
        title="Integrations"
        description="Send approved hours to your accounting and payroll systems."
        notices={banner && (
          <Alert
            role={banner.kind === 'error' ? 'alert' : 'status'}
            color={banner.kind === 'error' ? 'red' : 'success'}
            variant="light"
            icon={<BannerIcon size={16} aria-hidden="true" />}
          >
            <Group justify="space-between" gap="sm">
              <Text size="sm">{banner.text}</Text>
              {banner.action && <Anchor component={Link} href={banner.action.href} size="sm" fw={600}>{banner.action.label}</Anchor>}
            </Group>
          </Alert>
        )}
      />

      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        <Card
          title="QuickBooks Online"
          sub={qbo?.companyName ?? 'Accounting'}
          badge={qbo
            ? (qbo.expired ? <StatusBadge word="Needs reconnecting" tone="warn" /> : <StatusBadge word="Connected" tone="ok" />)
            : <StatusBadge word="Not connected" tone="dim" />}
          description="Sends approved hours as time activities, by employee, customer and service item."
          line={qbo ? qboCardLine(qbo, workspaceTimezone) : undefined}
        >
          {!qbo && <ConnectLink href="/api/integrations/qbo-connect">Connect QuickBooks</ConnectLink>}
          {qbo?.expired && <ConnectLink href="/api/integrations/qbo-connect">Reconnect</ConnectLink>}
          {qbo && (
            <Button component={Link} href={QBO_PAGE} size="sm" variant={qbo.expired ? 'default' : 'filled'}>Open</Button>
          )}
        </Card>

        <Card
          title="Gusto"
          sub={gusto?.companyName ?? 'Payroll'}
          badge={gusto ? <StatusBadge word="Connected" tone="ok" /> : undefined}
          description={GUSTO_HUB_NOTE}
        >
          <Button component={Link} href={PAYROLL_EXPORT} size="sm" variant="default">Open Payroll export</Button>
          {gusto && <Button component={Link} href="/settings/integrations/gusto" size="sm" variant="subtle">Manage connection</Button>}
        </Card>

        <Card
          title="Payroll file"
          sub="ADP, Paychex, Gusto or generic"
          description="Download approved hours with weekly overtime worked out, for any payroll system."
        >
          <Button component={Link} href={PAYROLL_EXPORT} size="sm" variant="default">Open Payroll export</Button>
        </Card>

        <Card
          title="API keys"
          sub={plural(hub.activeApiKeys, 'active key', 'active keys')}
          description="Read hours and costs from your own tools."
        >
          <Button component={Link} href="/settings/api-keys" size="sm" variant="default">Open API keys</Button>
        </Card>
      </SimpleGrid>
    </Container>
  );
}
