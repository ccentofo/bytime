'use client';

import { useMemo, useState } from 'react';
import { Alert, Button, Group, Modal, MultiSelect, SegmentedControl, Select, Stack, Table, Text } from '@mantine/core';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { RowActions } from '@/components/ui/RowActions';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Notice } from '@/components/ui/Notice';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { useBusy } from '@/components/ui/useBusy';
import { useLastTarget } from '@/components/ui/useRowState';
import { useAppTable, numericColumn, type AppTableExpandable } from '@/components/table/mrtDefaults';
import { runAction } from '@/lib/run-action';
import { toastSuccess } from '@/lib/toast';
import { formatCount } from '@/lib/format';
import { calendarDayOf, formatCalendarDate } from '@/lib/calendar-date';
import { grantApprovalScope, revokeApprovalScope, reviewMigratedScopes, type ApprovalScopeRow } from '@/server/actions/assignments';
import type { AccessPerson } from './GiveAccessModal';
import { reviewChunks } from './review-chunks';
import classes from './Assignments.module.css';

export type ActiveClin = { clinId: string; clinNumber: string; clinDescription: string | null; contractId: string; contractName: string; contractNumber: string };
export type Membership = { userId: string; clinId: string };

type Row =
  | { level: 'supervisor'; id: string; person: AccessPerson; approver: string | null; children: Row[] }
  | { level: 'clin'; id: string; scope: ApprovalScopeRow; people: number };

const clinLabel = (a: { contractName: string; clinNumber: string }) => `${a.contractName} CLIN ${a.clinNumber}`;

/** Active employees holding an active CLIN membership row, per CLIN (People). */
function employeesOn(people: AccessPerson[], membership: Membership[]): Map<string, number> {
  const byId = new Map(people.map((p) => [p.id, p]));
  const out = new Map<string, number>();
  for (const m of membership) {
    const p = byId.get(m.userId);
    if (p?.isActive && p.role === 'employee') out.set(m.clinId, (out.get(m.clinId) ?? 0) + 1);
  }
  return out;
}

/**
 * Approval scope (feature-plan-approval-scope.md §5): every ACTIVE supervisor (even with none, so "Add CLINs" is
 * reachable) with their active approval_scopes rows — the ONLY source of CLIN-based approval — and People = active
 * employees with an active membership row on that CLIN. Exported for tests.
 */
export function scopeRows(people: AccessPerson[], scopes: ApprovalScopeRow[], membership: Membership[], approverNames: Record<string, string | null>): Row[] {
  const peopleOn = employeesOn(people, membership);
  return people
    .filter((p) => p.isActive && p.role === 'supervisor')
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((p): Row => ({
      level: 'supervisor', id: p.id, person: p, approver: approverNames[p.id] ?? null,
      children: scopes
        .filter((s) => s.supervisorId === p.id)
        .sort((a, b) => a.contractName.localeCompare(b.contractName) || a.clinNumber.localeCompare(b.clinNumber, undefined, { numeric: true }))
        .map((s): Row => ({ level: 'clin', id: s.id, scope: s, people: peopleOn.get(s.clinId) ?? 0 })),
    }));
}

/** §5: active CLINs with at least one active employee member and no active scope held by an active supervisor. */
export function uncoveredClins(people: AccessPerson[], scopes: ApprovalScopeRow[], membership: Membership[], activeClins: ActiveClin[]): ActiveClin[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const employees = employeesOn(people, membership);
  const covered = new Set(scopes.filter((s) => byId.get(s.supervisorId)?.isActive && byId.get(s.supervisorId)?.role === 'supervisor').map((s) => s.clinId));
  return activeClins.filter((c) => (employees.get(c.clinId) ?? 0) > 0 && !covered.has(c.clinId));
}

/** The review list's supervisor tag: "(inactive)" or "(no longer a supervisor)". Exported for tests. */
export function holderTag(s: Pick<ApprovalScopeRow, 'holderActive' | 'holderRole'>): string {
  if (!s.holderActive) return ' (inactive)';
  return s.holderRole === 'supervisor' ? '' : ' (no longer a supervisor)';
}

export function ApprovalScopePanel({ people, scopes, membership, activeClins, approverNames, workspaceTimezone, onChanged }: {
  people: AccessPerson[];
  /** Every ACTIVE scope row, any holder; `needsReview` marks the converted ones nobody has reviewed (S6). */
  scopes: ApprovalScopeRow[];
  membership: Membership[];
  activeClins: ActiveClin[];
  approverNames: Record<string, string | null>;
  workspaceTimezone: string;
  onChanged: () => Promise<void>;
}) {
  const busy = useBusy();
  const [addFor, setAddFor] = useState<{ supervisorId: string | null } | null>(null);
  const [form, setForm] = useState<{ supervisorId: string | null; clinIds: string[] }>({ supervisorId: null, clinIds: [] });
  const [formErrors, setFormErrors] = useState<{ supervisor?: string; clins?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ApprovalScopeRow | null>(null);
  const shownRemove = useLastTarget(removeTarget);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const reviewRows = useMemo(() => scopes.filter((s) => s.needsReview), [scopes]);
  // §5: each review row defaults to Keep; only a row switched to Remove is recorded here.
  const [toRemove, setToRemove] = useState<Set<string>>(new Set());
  const [reviewError, setReviewError] = useState<string | null>(null);

  const rows = useMemo(() => scopeRows(people, scopes, membership, approverNames), [people, scopes, membership, approverNames]);
  const uncovered = useMemo(() => uncoveredClins(people, scopes, membership, activeClins), [people, scopes, membership, activeClins]);
  const supervisors = people.filter((p) => p.isActive && p.role === 'supervisor');
  const held = new Set(scopes.filter((s) => s.supervisorId === form.supervisorId).map((s) => s.clinId));
  const clinGroups = [...new Map(activeClins.map((c) => [c.contractId, c.contractName])).entries()].map(([contractId, contractName]) => ({
    group: contractName,
    items: activeClins.filter((c) => c.contractId === contractId && !held.has(c.clinId))
      .map((c) => ({ value: c.clinId, label: `${clinLabel(c)}${c.clinDescription ? ` — ${c.clinDescription}` : ''}` })),
  })).filter((g) => g.items.length > 0);

  function openAdd(supervisorId: string | null) {
    setForm({ supervisorId, clinIds: [] });
    setFormErrors({});
    setServerError(null);
    setAddFor({ supervisorId });
  }

  async function add() {
    const next: typeof formErrors = {};
    if (!form.supervisorId) next.supervisor = 'Choose an active supervisor.';
    if (form.clinIds.length === 0) next.clins = 'Choose at least one CLIN.';
    setFormErrors(next);
    setServerError(null);
    if (next.supervisor || next.clins || !form.supervisorId) return;
    const { supervisorId, clinIds } = form;
    await busy.run('add', async () => {
      const result = await runAction(grantApprovalScope({ supervisorId, clinIds }), { silent: true });
      if (!result.ok) { setServerError(result.error); return; }
      const sup = people.find((p) => p.id === supervisorId);
      const labels = clinIds.map((id) => activeClins.find((c) => c.clinId === id)).filter((c): c is ActiveClin => !!c).map(clinLabel);
      toastSuccess({ title: 'Approval scope updated', message: `${sup?.fullName ?? 'The supervisor'} now approves employees on ${labels.join(', ') || 'those CLINs'}.` });
      setAddFor(null);
      await onChanged();
    });
  }

  async function remove(target: ApprovalScopeRow) {
    setRemoveError(null);
    await busy.run('remove', async () => {
      const result = await runAction(revokeApprovalScope({ supervisorId: target.supervisorId, clinId: target.clinId }), { silent: true });
      if (!result.ok) { setRemoveError(result.error); return; }
      toastSuccess({ title: 'Approval scope updated', message: `${target.supervisorName} no longer approves employees on ${clinLabel(target)}.` });
      setRemoveTarget(null);
      await onChanged();
    });
  }

  async function saveReview() {
    setReviewError(null);
    await busy.run('review', async () => {
      // L10: the server takes ≤ 500 rows per call. A failed chunk stops the save; the chunks before it are saved, so the
      // list is refetched either way.
      let kept = 0, removed = 0;
      for (const chunk of reviewChunks(reviewRows.map((r) => r.id), toRemove)) {
        const result = await runAction(reviewMigratedScopes(chunk), { silent: true });
        if (!result.ok) { setReviewError(result.error); await onChanged(); return; }
        kept += result.data.kept;
        removed += result.data.removed;
      }
      toastSuccess({ title: 'Approval scopes reviewed', message: `${formatCount(kept)} kept, ${formatCount(removed)} removed.` });
      setToRemove(new Set());
      await onChanged();
    });
  }

  const columns = useMemo<MRT_ColumnDef<Row>[]>(() => [
    {
      id: 'who', header: 'Supervisor / CLIN', enableSorting: false,
      Cell: ({ row: { original: r } }) => (r.level === 'supervisor'
        ? (
          <span className={classes.oneLine}>
            <Text fw={600} span>{r.person.fullName}</Text>
            <span className={classes.sub} data-testid="scope-summary">{formatCount(r.children.length)} {r.children.length === 1 ? 'CLIN' : 'CLINs'} · approver: {r.approver ?? 'admins'}</span>
          </span>
        )
        : <span>{r.scope.contractName} · CLIN {r.scope.clinNumber}{r.scope.clinDescription ? ` ${r.scope.clinDescription}` : ''}{r.scope.clinActive ? '' : ' (inactive)'}</span>),
    },
    numericColumn<Row>({ id: 'people', header: 'People', enableSorting: false, Cell: ({ row: { original: r } }) => (r.level === 'clin' ? <span data-testid="scope-people">{formatCount(r.people)}</span> : null) }),
    {
      id: 'since', header: 'Since', enableSorting: false,
      Cell: ({ row: { original: r } }) => (r.level === 'clin'
        ? (
          <span data-testid="scope-since">
            {formatCalendarDate(calendarDayOf(new Date(r.scope.grantedAt), workspaceTimezone), 'MMM D, YYYY')}
            <span className={classes.sub}>
              {' '}{r.scope.source === 'migration' ? 'converted from earlier data' : r.scope.grantedByName ? `by ${r.scope.grantedByName}` : ''}
            </span>
          </span>
        )
        : null),
    },
  ], [workspaceTimezone]);

  const expandable = useMemo<AppTableExpandable<Row>>(() => ({
    getSubRows: (r) => (r.level === 'supervisor' ? r.children : undefined),
    label: (r) => (r.level === 'supervisor' ? `CLINs for ${r.person.fullName}` : clinLabel(r.scope)),
    searchText: (r) => (r.level === 'supervisor' ? r.person.fullName : `${r.scope.contractName} ${r.scope.clinNumber} ${r.scope.clinDescription ?? ''}`),
    rowId: (r) => `${r.level}:${r.id}`,
    defaultExpanded: true,
  }), []);

  const table = useAppTable<Row>({
    columns,
    data: rows,
    expandable,
    hairline: true,
    compact: true,
    enableRowActions: true,
    renderRowActions: ({ row: { original: r } }) => (r.level === 'supervisor'
      ? <RowActions rowLabel={r.person.fullName} primary={{ key: 'add', label: 'Add CLINs', icon: 'create', onSelect: () => openAdd(r.person.id) }} items={[]} />
      : <RowActions rowLabel={`${r.scope.supervisorName} — CLIN ${r.scope.clinNumber}`} primary={{ key: 'remove', label: 'Remove…', icon: 'deactivate', onSelect: () => { setRemoveError(null); setRemoveTarget(r.scope); } }} items={[]} />),
    emptyState: { title: 'No active supervisors.', body: 'Make someone a supervisor on Users to give them approval scope.' },
  });

  return (
    <Stack gap="sm">
      {reviewRows.length > 0 && (
        <Stack gap="xs" data-testid="scope-review">
          <Notice>
            These approval scopes were converted from earlier assignments. Keep the ones that are right and remove any that
            weren&apos;t intended.
          </Notice>
          {reviewError && <Alert color="red" role="alert">{reviewError}</Alert>}
          <Table verticalSpacing="xs" aria-label="Approval scopes to review">
            <Table.Thead>
              <Table.Tr><Table.Th>Supervisor</Table.Th><Table.Th>CLIN</Table.Th><Table.Th>Keep or remove</Table.Th></Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {reviewRows.map((r) => (
                <Table.Tr key={r.id} data-testid="scope-review-row">
                  <Table.Td>{r.supervisorName}{holderTag(r)}</Table.Td>
                  <Table.Td>{clinLabel(r)}{r.clinActive ? '' : ' (inactive)'}</Table.Td>
                  <Table.Td>
                    <SegmentedControl
                      size="xs"
                      aria-label={`Keep or remove ${clinLabel(r)} for ${r.supervisorName}`}
                      data={[{ value: 'keep', label: 'Keep' }, { value: 'remove', label: 'Remove' }]}
                      value={toRemove.has(r.id) ? 'remove' : 'keep'}
                      onChange={(v) => setToRemove((prev) => { const next = new Set(prev); if (v === 'remove') next.add(r.id); else next.delete(r.id); return next; })}
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Group justify="flex-end">
            <WriteButton {...busy.props('review')} onClick={() => { void saveReview(); }}>Save review</WriteButton>
          </Group>
        </Stack>
      )}
      <Notice tone="info">
        Admins can approve anyone. A supervisor approves employees who work on the CLINs below, and supervisors or admins
        who name them as their approver. Charge code access never adds approval scope. Supervisors&apos; and admins&apos; own
        timesheets go to their approver (set on Users), or to admins if none.
      </Notice>
      <Group justify="flex-end">
        <WriteButton onClick={() => openAdd(null)}>Add CLINs to a supervisor</WriteButton>
      </Group>
      <MantineReactTable table={table} />
      {uncovered.length > 0 && (
        <Text size="sm" data-testid="uncovered-clins">
          <Text span fw={600} c="var(--mantine-color-warning-text)">Not covered by a supervisor:</Text>{' '}
          {uncovered.map(clinLabel).join(', ')} — admins approve these.
        </Text>
      )}

      <Modal opened={!!addFor} onClose={() => { if (!busy.any()) setAddFor(null); }} title="Add CLINs to a supervisor" size="md">
        <Stack>
          {serverError && <Alert color="red" role="alert">{serverError}</Alert>}
          <Select label="Supervisor" required searchable data={supervisors.map((p) => ({ value: p.id, label: p.fullName }))}
            value={form.supervisorId} error={formErrors.supervisor} onChange={(v) => setForm((f) => ({ ...f, supervisorId: v, clinIds: [] }))} />
          <MultiSelect label="CLINs they approve" required searchable data={clinGroups}
            nothingFoundMessage="They already approve every active CLIN."
            placeholder={form.clinIds.length === 0 ? 'Choose CLINs' : undefined}
            value={form.clinIds} error={formErrors.clins} onChange={(v) => setForm((f) => ({ ...f, clinIds: v }))} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => { if (!busy.any()) setAddFor(null); }}>Cancel</Button>
            <WriteButton {...busy.props('add')} onClick={() => { void add(); }}>Add CLINs</WriteButton>
          </Group>
        </Stack>
      </Modal>

      <ConfirmModal
        opened={!!removeTarget}
        title={shownRemove ? `Remove ${clinLabel(shownRemove)} from ${shownRemove.supervisorName}'s approval scope?` : ''}
        message="They'll stop approving employees on this CLIN."
        confirmLabel="Remove"
        loading={busy.is('remove')}
        error={removeError}
        onConfirm={() => { if (removeTarget) void remove(removeTarget); }}
        onCancel={() => setRemoveTarget(null)}
      />
    </Stack>
  );
}
