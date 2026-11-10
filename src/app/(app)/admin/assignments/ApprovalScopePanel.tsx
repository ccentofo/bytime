'use client';

import { useMemo, useState } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
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
import { grantApprovalScope, revokeApprovalScope } from '@/server/actions/assignments';
import type { AccessPerson } from './GiveAccessModal';
import classes from './Assignments.module.css';

export type ScopeAssignment = {
  id: string; userId: string; clinId: string; isActive: boolean; assignedAt: Date; userName: string;
  clinNumber: string; clinDescription: string | null; contractName: string; contractNumber: string;
};
export type ActiveClin = { clinId: string; clinNumber: string; clinDescription: string | null; contractId: string; contractName: string; contractNumber: string };

type Row =
  | { level: 'supervisor'; id: string; person: AccessPerson; approver: string | null; children: Row[] }
  | { level: 'clin'; id: string; assignment: ScopeAssignment; people: number };

const clinLabel = (a: { contractName: string; clinNumber: string }) => `${a.contractName} CLIN ${a.clinNumber}`;

/**
 * Approval scope (feature-plan-ux-people-codes.md §4.4): every ACTIVE supervisor (even with no CLINs, so "Add CLIN" is
 * reachable), their active CLIN rows — whatever created them (R8) — with People = active employees holding an active
 * row on that CLIN. The uncovered CLINs: active, with an active employee row, and no active supervisor's row.
 * Exported for tests.
 */
export function scopeRows(people: AccessPerson[], assignments: ScopeAssignment[], approverNames: Record<string, string | null>): Row[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const isEmployeeRow = (a: ScopeAssignment) => a.isActive && byId.get(a.userId)?.isActive && byId.get(a.userId)?.role === 'employee';
  const peopleOn = new Map<string, number>();
  for (const a of assignments) if (isEmployeeRow(a)) peopleOn.set(a.clinId, (peopleOn.get(a.clinId) ?? 0) + 1);
  return people
    .filter((p) => p.isActive && p.role === 'supervisor')
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((p): Row => ({
      level: 'supervisor', id: p.id, person: p, approver: approverNames[p.id] ?? null,
      children: assignments
        .filter((a) => a.userId === p.id && a.isActive)
        .sort((a, b) => a.contractName.localeCompare(b.contractName) || a.clinNumber.localeCompare(b.clinNumber, undefined, { numeric: true }))
        .map((a): Row => ({ level: 'clin', id: a.id, assignment: a, people: peopleOn.get(a.clinId) ?? 0 })),
    }));
}

export function uncoveredClins(people: AccessPerson[], assignments: ScopeAssignment[], activeClins: ActiveClin[]): ActiveClin[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const withRole = (role: string) => new Set(assignments.filter((a) => a.isActive && byId.get(a.userId)?.isActive && byId.get(a.userId)?.role === role).map((a) => a.clinId));
  const employees = withRole('employee');
  const covered = withRole('supervisor');
  return activeClins.filter((c) => employees.has(c.clinId) && !covered.has(c.clinId));
}

export function ApprovalScopePanel({ people, assignments, activeClins, approverNames, workspaceTimezone, onChanged }: {
  people: AccessPerson[];
  assignments: ScopeAssignment[];
  activeClins: ActiveClin[];
  approverNames: Record<string, string | null>;
  workspaceTimezone: string;
  onChanged: () => Promise<void>;
}) {
  const busy = useBusy();
  const [addFor, setAddFor] = useState<{ supervisorId: string | null } | null>(null);
  const [form, setForm] = useState<{ supervisorId: string | null; contractId: string | null; clinId: string | null }>({ supervisorId: null, contractId: null, clinId: null });
  const [formErrors, setFormErrors] = useState<{ supervisor?: string; clin?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ScopeAssignment | null>(null);
  const shownRemove = useLastTarget(removeTarget);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const rows = useMemo(() => scopeRows(people, assignments, approverNames), [people, assignments, approverNames]);
  const uncovered = useMemo(() => uncoveredClins(people, assignments, activeClins), [people, assignments, activeClins]);
  const supervisors = people.filter((p) => p.isActive && p.role === 'supervisor');
  const contractOptions = [...new Map(activeClins.map((c) => [c.contractId, { value: c.contractId, label: `${c.contractName} (${c.contractNumber})` }])).values()];
  const clinOptions = activeClins.filter((c) => c.contractId === form.contractId).map((c) => ({ value: c.clinId, label: `${c.clinNumber}${c.clinDescription ? ` — ${c.clinDescription}` : ''}` }));

  function openAdd(supervisorId: string | null) {
    setForm({ supervisorId, contractId: null, clinId: null });
    setFormErrors({});
    setServerError(null);
    setAddFor({ supervisorId });
  }

  async function add() {
    const next: typeof formErrors = {};
    if (!form.supervisorId) next.supervisor = 'Choose an active supervisor.';
    if (!form.clinId) next.clin = 'Choose a CLIN.';
    setFormErrors(next);
    setServerError(null);
    if (next.supervisor || next.clin || !form.supervisorId || !form.clinId) return;
    const { supervisorId, clinId } = form;
    await busy.run('add', async () => {
      const result = await runAction(grantApprovalScope({ supervisorId, clinIds: [clinId] }), { silent: true });
      if (!result.ok) { setServerError(result.error); return; }
      const sup = people.find((p) => p.id === supervisorId);
      const clin = activeClins.find((c) => c.clinId === clinId);
      toastSuccess({ title: 'Approval scope updated', message: `${sup?.fullName ?? 'The supervisor'} now approves employees on ${clin ? clinLabel(clin) : 'that CLIN'}.` });
      setAddFor(null);
      await onChanged();
    });
  }

  async function remove(target: ScopeAssignment) {
    setRemoveError(null);
    await busy.run('remove', async () => {
      const result = await runAction(revokeApprovalScope({ supervisorId: target.userId, clinId: target.clinId }), { silent: true });
      if (!result.ok) { setRemoveError(result.error); return; }
      toastSuccess({ title: 'Approval scope updated', message: `${target.userName} no longer approves employees on ${clinLabel(target)}.` });
      setRemoveTarget(null);
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
        : <span>{r.assignment.contractName} · CLIN {r.assignment.clinNumber}{r.assignment.clinDescription ? ` ${r.assignment.clinDescription}` : ''}</span>),
    },
    numericColumn<Row>({ id: 'people', header: 'People', enableSorting: false, Cell: ({ row: { original: r } }) => (r.level === 'clin' ? <span data-testid="scope-people">{formatCount(r.people)}</span> : null) }),
    {
      id: 'since', header: 'Since', enableSorting: false,
      Cell: ({ row: { original: r } }) => (r.level === 'clin' ? formatCalendarDate(calendarDayOf(new Date(r.assignment.assignedAt), workspaceTimezone), 'MMM D, YYYY') : null),
    },
  ], [workspaceTimezone]);

  const expandable = useMemo<AppTableExpandable<Row>>(() => ({
    getSubRows: (r) => (r.level === 'supervisor' ? r.children : undefined),
    label: (r) => (r.level === 'supervisor' ? `CLINs for ${r.person.fullName}` : clinLabel(r.assignment)),
    searchText: (r) => (r.level === 'supervisor' ? r.person.fullName : `${r.assignment.contractName} ${r.assignment.clinNumber} ${r.assignment.clinDescription ?? ''}`),
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
      ? <RowActions rowLabel={r.person.fullName} primary={{ key: 'add', label: 'Add CLIN', icon: 'create', onSelect: () => openAdd(r.person.id) }} items={[]} />
      : <RowActions rowLabel={`${r.assignment.userName} — CLIN ${r.assignment.clinNumber}`} primary={{ key: 'remove', label: 'Remove…', icon: 'deactivate', onSelect: () => { setRemoveError(null); setRemoveTarget(r.assignment); } }} items={[]} />),
    emptyState: { title: 'No active supervisors.', body: 'Make someone a supervisor on Users to give them approval scope.' },
  });

  return (
    <Stack gap="sm">
      <Notice tone="info">
        Admins can approve anyone. A supervisor approves employees assigned to the CLINs below, and supervisors or admins
        who name them as their approver. Supervisors&apos; and admins&apos; own timesheets go to their approver (set on Users),
        or to admins if none.
      </Notice>
      <Group justify="flex-end">
        <WriteButton onClick={() => openAdd(null)}>Add CLIN to a supervisor</WriteButton>
      </Group>
      <MantineReactTable table={table} />
      {uncovered.length > 0 && (
        <Text size="sm" data-testid="uncovered-clins">
          <Text span fw={600} c="var(--mantine-color-warning-text)">Not covered by a supervisor:</Text>{' '}
          {uncovered.map(clinLabel).join(', ')} — admins approve these.
        </Text>
      )}

      <Modal opened={!!addFor} onClose={() => { if (!busy.any()) setAddFor(null); }} title="Add CLIN to a supervisor" size="md">
        <Stack>
          {serverError && <Alert color="red" role="alert">{serverError}</Alert>}
          <Select label="Supervisor" required searchable data={supervisors.map((p) => ({ value: p.id, label: p.fullName }))}
            value={form.supervisorId} error={formErrors.supervisor} onChange={(v) => setForm((f) => ({ ...f, supervisorId: v }))} />
          <Select label="Contract" required searchable data={contractOptions}
            value={form.contractId} onChange={(v) => setForm((f) => ({ ...f, contractId: v, clinId: null }))} />
          <Select label="CLIN" required searchable placeholder={form.contractId ? 'Select CLIN' : 'Choose a contract first'} data={clinOptions}
            value={form.clinId} error={formErrors.clin} onChange={(v) => setForm((f) => ({ ...f, clinId: v }))} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => { if (!busy.any()) setAddFor(null); }}>Cancel</Button>
            <WriteButton {...busy.props('add')} onClick={() => { void add(); }}>Add CLIN</WriteButton>
          </Group>
        </Stack>
      </Modal>

      <ConfirmModal
        opened={!!removeTarget}
        title={shownRemove ? `Remove ${clinLabel(shownRemove)} from ${shownRemove.userName}'s approval scope?` : ''}
        message={shownRemove ? `They'll stop approving employees on this CLIN. Giving ${shownRemove.userName} a charge code on this CLIN later adds it back.` : ''}
        confirmLabel="Remove"
        loading={busy.is('remove')}
        error={removeError}
        onConfirm={() => { if (removeTarget) void remove(removeTarget); }}
        onCancel={() => setRemoveTarget(null)}
      />
    </Stack>
  );
}
