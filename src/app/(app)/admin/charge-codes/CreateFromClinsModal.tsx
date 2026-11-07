'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Group, Modal, Stack, Table, Text, VisuallyHidden } from '@mantine/core';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { useBusy } from '@/components/ui/useBusy';
import { runAction } from '@/lib/run-action';
import { toastError, toastSuccess } from '@/lib/toast';
import { autobridgeChargeCodesFromClins, previewAutobridgeChargeCodes, type AutobridgeCandidate } from '@/server/actions/charge-codes';
import classes from './ChargeCodes.module.css';

export const TICK_AT_LEAST_ONE = 'Tick at least one CLIN.';

/**
 * "Create codes from CLINs" (feature-plan-ux-people-codes.md §3.3): shows what it would create first. Available CLINs
 * start ticked; one whose code is taken or too long shows why, with an unticked aria-disabled box (never `disabled`).
 */
export function CreateFromClinsModal({ opened, onClose, onCreated }: {
  opened: boolean;
  onClose: () => void;
  /** After a successful create (the caller refetches). */
  onCreated: () => void | Promise<void>;
}) {
  const busy = useBusy();
  const [candidates, setCandidates] = useState<AutobridgeCandidate[] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    let live = true;
    previewAutobridgeChargeCodes()
      .then((rows) => {
        if (!live) return;
        setCandidates(rows);
        setTicked(new Set(rows.filter((r) => r.available).map((r) => r.clinId)));
      })
      .catch(() => { if (live) setError("The CLINs couldn't be loaded. Close this and try again."); });
    return () => { live = false; };
  }, [opened]);

  /** Closing clears the list, so the next open starts from a fresh preview. */
  const close = () => {
    if (busy.any()) return;
    setCandidates(null);
    setError(null);
    onClose();
  };

  const toggle = (c: AutobridgeCandidate) => {
    if (!c.available) return;
    setError(null);
    setTicked((prev) => { const next = new Set(prev); if (next.has(c.clinId)) next.delete(c.clinId); else next.add(c.clinId); return next; });
  };

  async function create() {
    if (ticked.size === 0) { setError(TICK_AT_LEAST_ONE); return; }
    await busy.run('create', async () => {
      const result = await runAction(autobridgeChargeCodesFromClins([...ticked]), { silent: true });
      if (!result.ok) { setError(result.error); return; }
      const { created, skipped } = result.data;
      toastSuccess({ title: 'Charge codes created', message: `Created ${created} charge ${created === 1 ? 'code' : 'codes'}${skipped > 0 ? ` · ${skipped} skipped` : ''}` });
      setCandidates(null);
      onClose();
      try { await onCreated(); } catch { toastError({ title: 'List not refreshed', message: 'Reload the page to see the new codes.' }); }
    });
  }

  const empty = candidates !== null && candidates.length === 0;
  return (
    <Modal opened={opened} onClose={close} title="Create codes from CLINs" size="lg">
      <Stack gap="md">
        {error && <Alert color="red" role="alert" data-testid="autobridge-error">{error}</Alert>}
        {candidates === null && !error && <Text size="sm" c="dimmed" role="status">Loading…</Text>}
        {empty && (
          <>
            <Text size="sm" data-testid="autobridge-empty">Every active CLIN already has a charge code.</Text>
            <Group justify="flex-end"><Button variant="default" onClick={close}>Close</Button></Group>
          </>
        )}
        {candidates !== null && !empty && (
          <>
            <Text size="sm">These active CLINs have no charge code yet. Each ticked one gets a code named after the CLIN. You can rename them afterwards.</Text>
            <Table data-testid="autobridge-table" verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr><Table.Th w={36}><VisuallyHidden>Create</VisuallyHidden></Table.Th><Table.Th>New code</Table.Th><Table.Th>Name</Table.Th><Table.Th>CLIN</Table.Th></Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {candidates.map((c) => (
                  <Table.Tr key={c.clinId}>
                    <Table.Td>
                      <Checkbox
                        aria-label={`Create ${c.code}`}
                        checked={c.available && ticked.has(c.clinId)}
                        aria-disabled={!c.available || undefined}
                        onChange={() => toggle(c)}
                      />
                    </Table.Td>
                    <Table.Td><span className={classes.mono}>{c.code}</span></Table.Td>
                    <Table.Td>
                      {c.name}
                      {c.reason && <span className={classes.sub} data-testid="autobridge-reason">{c.reason}</span>}
                    </Table.Td>
                    <Table.Td>{c.contractName} · {c.clinNumber}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Text size="xs" c="dimmed">They start billable, with no labor category, and nobody has access yet — give access on Assignments.</Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={close}>Cancel</Button>
              <WriteButton {...busy.props('create')} onClick={() => { void create(); }}>
                Create {ticked.size} {ticked.size === 1 ? 'code' : 'codes'}
              </WriteButton>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
