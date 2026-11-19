import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { Center, Paper, Stack, Text, Title } from '@mantine/core';
import { Logo } from '@/components/brand/Logo';
import { getTenantSlug } from '@/lib/tenant/context';
import { apexBaseUrl } from '@/lib/tenant/host';
import { readDeliveryByToken, TOKEN_RE } from '@/lib/export/delivery-access';
import { EXPIRED_TEXT, fmtDateTime, formatBytes } from '@/lib/export/format';
import { PrepareDownload } from './PrepareDownload';

/**
 * The workspace export download page (feature-plan-cloud-export.md §6.6), on the apex only. A GET only renders: it never
 * mints a URL, so an email scanner that fetches the link gets the page and nothing else. Expired, revoked, erased,
 * unavailable under a policy hold, unknown and malformed tokens all show the same text (no oracle; a malformed token is
 * answered without a database read). Headers (next.config.ts): no-store, no-referrer, noindex.
 */
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Workspace export', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function ExportDownloadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let onWorkspaceHost: boolean;
  try {
    onWorkspaceHost = (await getTenantSlug()) !== '';
  } catch {
    onWorkspaceHost = true;
  }
  if (onWorkspaceHost) redirect(`${apexBaseUrl()}/export/${TOKEN_RE.test(token) ? token : ''}`);

  const state = await readDeliveryByToken(token);
  return (
    <Center mih="100vh" p="md">
      <Paper withBorder radius="md" p="xl" maw={480} w="100%">
        <Stack gap="md">
          <Logo />
          <Title order={1} size="h3">Workspace export</Title>
          {state.state === 'valid' ? (
            <>
              <Text data-testid="export-details">
                Workspace export for <strong>{state.delivery.tenantName}</strong> · {formatBytes(state.delivery.bytes)} · works until{' '}
                {fmtDateTime(state.delivery.expiresAt, state.delivery.timeZone)}
              </Text>
              <PrepareDownload token={token} />
            </>
          ) : (
            <Text data-testid="export-expired">{EXPIRED_TEXT}</Text>
          )}
        </Stack>
      </Paper>
    </Center>
  );
}
