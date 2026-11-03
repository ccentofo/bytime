'use client';

import { useMemo, useState } from 'react';
import { Button, CloseButton, Group, Modal, Paper, Select, Stack, Text, Title, VisuallyHidden } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { RowActions } from '@/components/ui/RowActions';
import { useBusy } from '@/components/ui/useBusy';
import { useLastTarget } from '@/components/ui/useRowState';
import { useAppTable } from '@/components/table/mrtDefaults';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { runAction } from '@/lib/run-action';
import { toastError } from '@/lib/toast';
import { formatCurrency, formatDate } from '@/lib/format';
import { compare, isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import {
  assignUserToLaborCategory, endUserLaborCategoryAssignment, getUserLaborCategoryAssignments,
} from '@/server/actions/labor-categories';
import classes from './LaborCategoryAssignments.module.css';

/**
 * People → Assignments → "Labor categories" (feature-plan-ux-kit-contracts.md §4.3, L1): the assign form, the
 * assignments table and the End assignment dialog, moved here from the Labor categories page. Rates come from the
 * page's `rateByCategory` (the current rate of EVERY category, so an assignment to a deactivated one still shows its
 * rate). The URL's filters arrive parsed: `laborCategoryId` narrows the table to that category's assignments active
 * today, `userId` to that employee (and pre-selects them), `assignments` highlights the overlapping rows. Each filter
 * shows a chip; removing it calls `onRemoveFilter`.
 */

export type LcatAssignment = {
  id: string;
  userId: string;
  laborCategoryId: string;
  effectiveDate: CalendarDate;
  endDate: CalendarDate | null;
  userName: string;
  lcatCode: string;
  lcatTitle: string;
  clinNumber: string;
  contractName: string;
  contractNumber: string;
};

export type AssignableLcat = {
  id: string;
  lcatCode: string;
  title: string;
  clinNumber: string;
  contractName: string;
};

export type LcatFilterKey = 'laborCategoryId' | 'userId' | 'assignments';

type Props = {
  initialAssignments: LcatAssignment[];
  users: Array<{ id: string; fullName: string }>;
  assignableLcats: AssignableLcat[];
  /** laborCategoryId → its current hourly rate (null = none), for every category. */
  rateByCategory: Record<string, string | null>;
  /** laborCategoryId → code and CLIN, for every category (the chip names a category even with no assignments). */
  categoryNames: Record<string, { lcatCode: string; clinNumber: string }>;
  today: CalendarDate;
  filters: { laborCategoryId: string | null; userId: string | null; assignments: string[] };
  onRemoveFilter: (key: LcatFilterKey) => void;
};

const perHour = (r: string | null | undefined) => `${formatCurrency(r ?? null)}/hr`;
const activeOn = (a: LcatAssignment, day: CalendarDate) =>
  compare(a.effectiveDate, day) <= 0 && (a.endDate === null || compare(a.endDate, day) >= 0);

export function LaborCategoryAssignmentsPanel({
  initialAssignments, users, assignableLcats, rateByCategory, categoryNames, today, filters, onRemoveFilter,
}: Props) {
  const busy = useBusy();
  const [assignments, setAssignments] = useState<LcatAssignment[]>(initialAssignments);

  // Assign form. A `userId` in the URL pre-selects that employee (again whenever the parameter changes).
  const [assignUserId, setAssignUserId] = useState<string | null>(filters.userId);
  const [seenUserParam, setSeenUserParam] = useState(filters.userId);
  if (filters.userId !== seenUserParam) {
    setSeenUserParam(filters.userId);
    if (filters.userId) setAssignUserId(filters.userId);
  }
  const [assignLcatId, setAssignLcatId] = useState<string | null>(null);
  const [assignEffectiveDate, setAssignEffectiveDate] = useState<string | null>(null);
  const [assignEndDate, setAssignEndDate] = useState<string | null>(null);

  const [confirmEnd, setConfirmEnd] = useState<LcatAssignment | null>(null);
  const shownEnd = useLastTarget(confirmEnd);
  // certified-outputs C3: optional INCLUSIVE end date (default today) — a promotion can end yesterday and start today.
  const [endDate, setEndDate] = useState<CalendarDate | null>(null);

  const highlighted = useMemo(() => new Set(filters.assignments), [filters.assignments]);
  const rows = useMemo(() => assignments.filter((a) =>
    (!filters.laborCategoryId || (a.laborCategoryId === filters.laborCategoryId && activeOn(a, today)))
    && (!filters.userId || a.userId === filters.userId)), [assignments, filters.laborCategoryId, filters.userId, today]);

  const chips: Array<{ key: LcatFilterKey; label: string }> = [];
  if (filters.laborCategoryId) {
    const c = categoryNames[filters.laborCategoryId];
    chips.push({ key: 'laborCategoryId', label: c ? `Labor category: ${c.lcatCode} · CLIN ${c.clinNumber}` : 'Labor category: unknown' });
  }
  if (filters.userId) {
    const u = users.find((x) => x.id === filters.userId);
    chips.push({ key: 'userId', label: `Employee: ${u?.fullName ?? 'unknown'}` });
  }

  async function handleAssign() {
    if (!assignUserId || !assignLcatId || !assignEffectiveDate || !isCalendarDate(assignEffectiveDate)) return;
    try {
      const end: CalendarDate | undefined = assignEndDate && isCalendarDate(assignEndDate) ? assignEndDate : undefined;
      const result = await runAction(assignUserToLaborCategory({
        userId: assignUserId, laborCategoryId: assignLcatId, effectiveDate: assignEffectiveDate, endDate: end,
      }), { errorTitle: 'Assignment Failed' });
      if (!result.ok) return;
      setAssignments(await getUserLaborCategoryAssignments());
      setAssignUserId(null);
      setAssignLcatId(null);
      setAssignEffectiveDate(null);
      setAssignEndDate(null);
      notifications.show({ title: 'Assignment Created', message: 'User has been assigned to the labor category.', color: 'success' });
    } catch {
      toastError({ title: 'Assignment Failed', message: 'Something went wrong. Please refresh and try again.' });
    }
  }

  async function handleEnd(assignment: LcatAssignment) {
    try {
      const result = await runAction(endUserLaborCategoryAssignment(assignment.id, endDate ?? undefined), { errorTitle: 'Couldn’t end assignment' });
      if (!result.ok) return;
      setAssignments(await getUserLaborCategoryAssignments());
      notifications.show({
        title: 'Assignment Ended',
        message: `${assignment.userName}'s assignment to ${assignment.lcatCode} has been ended.`,
        color: 'warning',
      });
      setConfirmEnd(null);
      setEndDate(null);
    } catch {
      toastError({ title: 'Error', message: 'Something went wrong. Please refresh and try again.' });
    }
  }

  function closeEnd() {
    if (busy.is('end')) return;
    setConfirmEnd(null);
    setEndDate(null);
  }

  const columns: MRT_ColumnDef<LcatAssignment>[] = [
    {
      accessorKey: 'userName', header: 'Employee', size: 180,
      Cell: ({ row }) => (
        <>
          {row.original.userName}
          {highlighted.has(row.original.id) && <VisuallyHidden>, overlapping</VisuallyHidden>}
        </>
      ),
    },
    { id: 'contract', header: 'Contract', accessorFn: (row) => `${row.contractName} (${row.contractNumber})`, size: 200 },
    { accessorKey: 'clinNumber', header: 'CLIN', size: 100 },
    { id: 'lcat', header: 'LCAT', accessorFn: (row) => `${row.lcatCode} — ${row.lcatTitle}`, size: 200 },
    {
      id: 'currentRate', header: 'Rate', size: 120,
      // The category's CURRENT rate (rateByCategory covers every category, inactive ones too), never a starting rate.
      accessorFn: (row) => rateByCategory[row.laborCategoryId] ?? null,
      Cell: ({ cell }) => perHour(cell.getValue<string | null>()),
    },
    { accessorKey: 'effectiveDate', header: 'Effective Date', Cell: ({ cell }) => formatDate(cell.getValue<CalendarDate>()), size: 140 },
    { accessorKey: 'endDate', header: 'End Date', Cell: ({ cell }) => formatDate(cell.getValue<CalendarDate | null>()), size: 140 },
  ];

  const table = useAppTable({
    columns,
    data: rows,
    enableRowActions: true,
    mantineTableBodyRowProps: ({ row }) => (highlighted.has(row.original.id)
      ? { className: classes.overlap, 'data-overlap': 'true' }
      : {}),
    renderRowActions: ({ row }) => (
      <RowActions
        rowLabel={`${row.original.userName} — ${row.original.lcatCode}`}
        items={[{
          key: 'end', label: 'End assignment…', icon: 'endAssignment',
          hidden: row.original.endDate !== null, // already ended
          onSelect: () => setConfirmEnd(row.original),
        }]}
      />
    ),
  });

  return (
    <>
      <Text size="sm" c="dimmed" mb="md">
        Give each employee the labor category that prices their hours on a CLIN. Hours are priced at the category&apos;s
        rate in effect on each day worked.
      </Text>

      <Paper withBorder p="md" mb="xl">
        <Title order={4} mb="sm">Create Assignment</Title>
        <Group align="flex-end" wrap="wrap">
          <Select
            label="User"
            placeholder="Select employee"
            data={users.map((u) => ({ value: u.id, label: u.fullName }))}
            value={assignUserId}
            onChange={setAssignUserId}
            searchable
            style={{ minWidth: 200 }}
          />
          <Select
            label="Labor Category"
            placeholder="Select labor category"
            data={assignableLcats.map((lc) => ({
              value: lc.id,
              label: `${lc.contractName} — ${lc.clinNumber} — ${lc.lcatCode}: ${lc.title} (${perHour(rateByCategory[lc.id])})`,
            }))}
            value={assignLcatId}
            onChange={setAssignLcatId}
            searchable
            style={{ minWidth: 400 }}
          />
          <DateInput label="Effective Date" value={assignEffectiveDate} onChange={setAssignEffectiveDate} required style={{ minWidth: 160 }} />
          <DateInput label="End Date" value={assignEndDate} onChange={setAssignEndDate} clearable style={{ minWidth: 160 }} />
          <WriteButton
            {...busy.props('assign')}
            onClick={() => { void busy.run('assign', handleAssign); }}
            disabled={!assignUserId || !assignLcatId || !assignEffectiveDate}
          >
            Assign
          </WriteButton>
        </Group>
      </Paper>

      {chips.length > 0 && (
        <Group gap="xs" mb="sm" data-testid="lcat-filter-chips">
          {chips.map((c) => (
            <span key={c.key} className={classes.chip} data-testid={`lcat-chip-${c.key}`}>
              {c.label}
              <CloseButton size="xs" aria-label={`Remove filter ${c.label}`} onClick={() => onRemoveFilter(c.key)} />
            </span>
          ))}
        </Group>
      )}

      <MantineReactTable table={table} />

      <Modal opened={!!confirmEnd} onClose={closeEnd} title="End assignment?">
        {shownEnd && (
          <Stack>
            <Text size="sm">
              This ends {shownEnd.userName}&apos;s assignment to {shownEnd.lcatCode}. The last day is included; leave the
              date empty to end it today. It can&apos;t be before the assignment&apos;s effective date.
            </Text>
            <DateInput
              label="Last day (optional)"
              value={endDate}
              onChange={(d) => setEndDate(d && isCalendarDate(d) ? d : null)}
              clearable
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={closeEnd}>Cancel</Button>
              <WriteButton color="warning" {...busy.props('end')} onClick={() => { if (confirmEnd) void busy.run('end', () => handleEnd(confirmEnd)); }}>
                End Assignment
              </WriteButton>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
