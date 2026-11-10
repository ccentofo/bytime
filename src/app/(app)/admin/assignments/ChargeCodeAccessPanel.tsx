'use client';

import { useMemo, useState } from 'react';
import { Group, Stack, Text } from '@mantine/core';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { RowActions } from '@/components/ui/RowActions';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { useBusy } from '@/components/ui/useBusy';
import { useLastTarget } from '@/components/ui/useRowState';
import { useAppTable, type AppTableExpandable } from '@/components/table/mrtDefaults';
import { runAction } from '@/lib/run-action';
import { toastSuccess } from '@/lib/toast';
import { formatCount } from '@/lib/format';
import { unassignChargeCodeFromUser } from '@/server/actions/charge-codes';
import { GiveAccessModal, type AccessCode, type AccessPerson } from './GiveAccessModal';
import classes from './Assignments.module.css';

export type CodeAccessRow = {
  userId: string; userName: string; chargeCodeId: string; code: string; name: string; clinNumber: string;
  contractName: string; contractNumber: string; workLocation: 'onsite' | 'telework' | 'other' | null; isActive: boolean; assignedAt: Date;
};

const LOCATION_WORD: Record<string, string> = { onsite: 'Onsite', telework: 'Telework', other: 'Other' };

type Row =
  | { level: 'person'; id: string; person: AccessPerson; count: number; contracts: string[]; children: Row[] }
  | { level: 'code'; id: string; access: CodeAccessRow; chargeable: boolean };

/**
 * The person tree (feature-plan-ux-people-codes.md §4.2): every active user (by name; those with nothing chargeable
 * last), with their ACTIVE access rows. A code that can't be charged right now is dimmed and not counted. Exported for tests.
 */
export function accessRows(people: AccessPerson[], access: CodeAccessRow[], chargeableById: Map<string, boolean>): Row[] {
  const byPerson = new Map<string, CodeAccessRow[]>();
  for (const a of access) if (a.isActive) byPerson.set(a.userId, [...(byPerson.get(a.userId) ?? []), a]);
  return people
    .filter((p) => p.isActive)
    .map((p): Row => {
      const rows = (byPerson.get(p.id) ?? []).sort((a, b) => a.code.localeCompare(b.code));
      const charge = rows.filter((r) => chargeableById.get(r.chargeCodeId) ?? false);
      return {
        level: 'person', id: p.id, person: p, count: charge.length,
        contracts: [...new Set(charge.map((r) => r.contractName))].sort(),
        children: rows.map((r): Row => ({ level: 'code', id: `${p.id}:${r.chargeCodeId}`, access: r, chargeable: chargeableById.get(r.chargeCodeId) ?? false })),
      };
    })
    .sort((a, b) => {
      const [x, y] = [a as Extract<Row, { level: 'person' }>, b as Extract<Row, { level: 'person' }>];
      return Number(x.count === 0) - Number(y.count === 0) || x.person.fullName.localeCompare(y.person.fullName);
    });
}

export function ChargeCodeAccessPanel({ people, access, codes, onChanged }: {
  people: AccessPerson[];
  access: CodeAccessRow[];
  codes: AccessCode[];
  /** Refetch after a write (§4.1). */
  onChanged: () => Promise<void>;
}) {
  const busy = useBusy();
  const [giveFor, setGiveFor] = useState<{ personId: string | null } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<CodeAccessRow | null>(null);
  const shownRemove = useLastTarget(removeTarget);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const chargeableById = useMemo(() => new Map(codes.map((c) => [c.id, c.chargeable ?? false])), [codes]);
  const rows = useMemo(() => accessRows(people, access, chargeableById), [people, access, chargeableById]);
  const heldBy = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const a of access) if (a.isActive) m.set(a.userId, new Set([...(m.get(a.userId) ?? []), a.chargeCodeId]));
    return m;
  }, [access]);

  async function remove(target: CodeAccessRow) {
    setRemoveError(null);
    await busy.run('remove', async () => {
      const result = await runAction(unassignChargeCodeFromUser(target.userId, target.chargeCodeId), { silent: true });
      if (!result.ok) { setRemoveError(result.error); return; }
      toastSuccess({ title: 'Access removed', message: `${target.userName} can no longer charge ${target.code}.` });
      setRemoveTarget(null);
      await onChanged();
    });
  }

  const columns = useMemo<MRT_ColumnDef<Row>[]>(() => [
    {
      id: 'who', header: 'Person / charge code', enableSorting: false,
      Cell: ({ row: { original: r } }) => {
        if (r.level === 'person') {
          return (
            <span className={classes.oneLine}>
              <Text fw={600} span>{r.person.fullName}</Text>
              {r.count === 0
                ? <span className={classes.warn} data-testid="no-codes">No charge codes · only indirect time on their timesheet</span>
                : <span className={classes.sub} data-testid="code-count">{formatCount(r.count)} {r.count === 1 ? 'code' : 'codes'} · {r.contracts.join(', ')}</span>}
            </span>
          );
        }
        return <span className={`${classes.mono}${r.chargeable ? '' : ` ${classes.dim}`}`}>{r.access.code}</span>;
      },
    },
    {
      id: 'name', header: 'Name', enableSorting: false,
      Cell: ({ row: { original: r } }) => (r.level !== 'code' ? null : r.chargeable ? r.access.name
        : <span className={classes.dim} data-testid="not-chargeable">{r.access.name} · Can&apos;t be charged right now</span>),
    },
    { id: 'where', header: 'Contract · CLIN', enableSorting: false, Cell: ({ row: { original: r } }) => (r.level === 'code' ? <span className={r.chargeable ? undefined : classes.dim}>{r.access.contractName} · {r.access.clinNumber}</span> : null) },
    { id: 'location', header: 'Location', enableSorting: false, Cell: ({ row: { original: r } }) => (r.level === 'code' ? <span className={r.chargeable ? undefined : classes.dim}>{LOCATION_WORD[r.access.workLocation ?? ''] ?? '—'}</span> : null) },
  ], []);

  const expandable = useMemo<AppTableExpandable<Row>>(() => ({
    getSubRows: (r) => (r.level === 'person' ? r.children : undefined),
    label: (r) => (r.level === 'person' ? `codes for ${r.person.fullName}` : r.access.code),
    searchText: (r) => (r.level === 'person' ? r.person.fullName : `${r.access.code} ${r.access.name} ${r.access.contractName}`),
    rowId: (r) => `${r.level}:${r.id}`,
    defaultExpanded: true,
  }), []);

  const table = useAppTable<Row>({
    columns,
    data: rows,
    expandable,
    hairline: true,
    compact: rows.length <= 25,
    enableRowActions: true,
    renderRowActions: ({ row: { original: r } }) => (r.level === 'person'
      ? <RowActions rowLabel={r.person.fullName} primary={{ key: 'add', label: 'Add codes', icon: 'create', onSelect: () => setGiveFor({ personId: r.person.id }) }} items={[]} />
      : <RowActions rowLabel={`${r.access.userName} — ${r.access.code}`} primary={{ key: 'remove', label: 'Remove…', icon: 'deactivate', onSelect: () => { setRemoveError(null); setRemoveTarget(r.access); } }} items={[]} />),
    emptyState: { title: 'No active people yet.' },
  });

  return (
    <Stack gap="sm">
      <Group justify="flex-end">
        <WriteButton onClick={() => setGiveFor({ personId: null })}>Give access</WriteButton>
      </Group>
      <MantineReactTable table={table} />

      {giveFor && (
        <GiveAccessModal
          opened
          onClose={() => setGiveFor(null)}
          onGiven={onChanged}
          people={people}
          codes={codes}
          heldBy={heldBy}
          initialPersonId={giveFor.personId}
        />
      )}

      <ConfirmModal
        opened={!!removeTarget}
        title={shownRemove ? `Remove ${shownRemove.userName}'s access to ${shownRemove.code}?` : ''}
        message="They can't charge new time to it. Hours already recorded stay on record."
        confirmLabel="Remove"
        loading={busy.is('remove')}
        error={removeError}
        onConfirm={() => { if (removeTarget) void remove(removeTarget); }}
        onCancel={() => setRemoveTarget(null)}
      />
    </Stack>
  );
}
