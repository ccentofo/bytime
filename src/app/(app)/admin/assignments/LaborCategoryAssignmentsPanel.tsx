'use client';

import { useId, useMemo, useState } from 'react';
import { Button, Group, Modal, Select, Stack, Text, VisuallyHidden } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { RowActions } from '@/components/ui/RowActions';
import { FilterChip } from '@/components/ui/FilterChip';
import { Notice } from '@/components/ui/Notice';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useBusy } from '@/components/ui/useBusy';
import { useLastTarget } from '@/components/ui/useRowState';
import { useAppTable, numericColumn, type AppTableExpandable } from '@/components/table/mrtDefaults';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { runAction } from '@/lib/run-action';
import { toastError, toastSuccess } from '@/lib/toast';
import { formatCount, formatCurrency } from '@/lib/format';
import { compare, formatCalendarDate, isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import {
  assignUserToLaborCategory, endUserLaborCategoryAssignment, getLaborCategoryAssignmentsWithOverlaps,
} from '@/server/actions/labor-categories';
import classes from './LaborCategoryAssignments.module.css';
import styles from './Assignments.module.css';

/**
 * People → Assignments → "Labor categories" (feature-plan-ux-people-codes.md §4.3; ux-kit-contracts §4.3): grouped by
 * person, with each assignment's status on the workspace's today — Overlaps (from the page's overlap ids; it wins),
 * Current, "Starts {date}" or "Ended {date}". "Current and upcoming" hides the ended ones. The URL filters are as
 * before: `laborCategoryId` narrows to that category's assignments active today, `userId` to that employee (and
 * pre-selects them in the form), `assignments` highlights rows; each shows a chip.
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
  users: Array<{ id: string; fullName: string; isActive?: boolean }>;
  assignableLcats: AssignableLcat[];
  /** laborCategoryId → its current hourly rate (null = none), for every category. */
  rateByCategory: Record<string, string | null>;
  /** laborCategoryId → code, CLIN and SLIN, for every category (the chip names a category even with no assignments). */
  categoryNames: Record<string, { lcatCode: string; clinNumber: string; slinNumber?: string | null }>;
  today: CalendarDate;
  /** §4.3: the assignment ids that overlap another on the same CLIN / SLIN (computed by the page with findOverlaps). */
  overlapIds?: string[];
  filters: { laborCategoryId: string | null; userId: string | null; assignments: string[] };
  onRemoveFilter: (key: LcatFilterKey) => void;
};

export const UNPRICED_CONFLICTS_HREF = '/admin/reports/unpriced?reason=conflict';

const perHour = (r: string | null | undefined) => `${formatCurrency(r ?? null)}/hr`;
const activeOn = (a: LcatAssignment, day: CalendarDate) =>
  compare(a.effectiveDate, day) <= 0 && (a.endDate === null || compare(a.endDate, day) >= 0);

type Status = { kind: 'overlaps' | 'current' | 'starts' | 'ended'; word: string };
/** §4.3: Overlaps wins; else by the workspace's today. Exported for tests. */
export function lcatStatus(a: LcatAssignment, today: CalendarDate, overlaps: boolean): Status {
  if (overlaps) return { kind: 'overlaps', word: 'Overlaps' };
  if (a.endDate !== null && compare(a.endDate, today) < 0) return { kind: 'ended', word: `Ended ${formatCalendarDate(a.endDate, 'MMM D, YYYY')}` };
  if (compare(a.effectiveDate, today) > 0) return { kind: 'starts', word: `Starts ${formatCalendarDate(a.effectiveDate, 'MMM D')}` };
  return { kind: 'current', word: 'Current' };
}
const TONE: Record<Status['kind'], 'warn' | 'ok' | 'info' | 'dim'> = { overlaps: 'warn', current: 'ok', starts: 'info', ended: 'dim' };

type Row =
  | { level: 'person'; id: string; name: string; children: Row[] }
  | { level: 'lcat'; id: string; a: LcatAssignment; status: Status };

export function LaborCategoryAssignmentsPanel({
  initialAssignments, users, assignableLcats, rateByCategory, categoryNames, today, overlapIds = [], filters, onRemoveFilter,
}: Props) {
  const busy = useBusy();
  const [assignments, setAssignments] = useState<LcatAssignment[]>(initialAssignments);
  const [show, setShow] = useState<'current' | 'all'>('current');
  // UX-4C1-AUDIT.md M3: the overlap ids are refetched with the assignments after every write.
  const [overlaps, setOverlaps] = useState<string[]>(overlapIds);
  const overlapSet = useMemo(() => new Set(overlaps), [overlaps]);
  async function reload() {
    const fresh = await getLaborCategoryAssignmentsWithOverlaps();
    setAssignments(fresh.assignments);
    setOverlaps(fresh.overlapIds);
  }

  // Assign form (a Modal). A `userId` in the URL pre-selects that employee (again whenever the parameter changes).
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignUserId, setAssignUserId] = useState<string | null>(filters.userId);
  const [seenUserParam, setSeenUserParam] = useState(filters.userId);
  if (filters.userId !== seenUserParam) {
    setSeenUserParam(filters.userId);
    if (filters.userId) setAssignUserId(filters.userId);
  }
  const [assignLcatId, setAssignLcatId] = useState<string | null>(null);
  const [assignEffectiveDate, setAssignEffectiveDate] = useState<string | null>(null);
  const [assignEndDate, setAssignEndDate] = useState<string | null>(null);
  // UX-4B1-AUDIT L13: Assign is never `disabled`; an incomplete form is aria-disabled with the reason, and a click shows
  // which fields are missing.
  const [showAssignErrors, setShowAssignErrors] = useState(false);
  const assignHintId = useId();
  const missing = { user: !assignUserId, lcat: !assignLcatId, date: !assignEffectiveDate || !isCalendarDate(assignEffectiveDate) };
  const assignIncomplete = missing.user || missing.lcat || missing.date;

  const [confirmEnd, setConfirmEnd] = useState<LcatAssignment | null>(null);
  const shownEnd = useLastTarget(confirmEnd);
  // certified-outputs C3: optional INCLUSIVE end date (default today) — a promotion can end yesterday and start today.
  const [endDate, setEndDate] = useState<CalendarDate | null>(null);

  const highlighted = useMemo(() => new Set(filters.assignments), [filters.assignments]);
  const rows = useMemo<Row[]>(() => {
    const visible = assignments
      .filter((a) => (!filters.laborCategoryId || (a.laborCategoryId === filters.laborCategoryId && activeOn(a, today)))
        && (!filters.userId || a.userId === filters.userId))
      .map((a) => ({ a, status: lcatStatus(a, today, overlapSet.has(a.id)) }))
      .filter((x) => show === 'all' || x.status.kind !== 'ended');
    const byPerson = new Map<string, { name: string; rows: typeof visible }>();
    for (const x of visible) {
      const g = byPerson.get(x.a.userId) ?? { name: x.a.userName, rows: [] };
      g.rows.push(x);
      byPerson.set(x.a.userId, g);
    }
    return [...byPerson.entries()]
      .sort(([, x], [, y]) => x.name.localeCompare(y.name))
      .map(([userId, g]): Row => ({
        level: 'person', id: userId, name: g.name,
        children: g.rows
          .sort((x, y) => compare(x.a.effectiveDate, y.a.effectiveDate) || x.a.lcatCode.localeCompare(y.a.lcatCode))
          .map((x): Row => ({ level: 'lcat', id: x.a.id, a: x.a, status: x.status })),
      }));
  }, [assignments, filters.laborCategoryId, filters.userId, today, overlapSet, show]);

  // §4.3: the overlap notice counts people (all of them, not just the visible ones).
  const overlapPeople = useMemo(() => {
    const names = new Map<string, string>();
    for (const a of assignments) if (overlapSet.has(a.id)) names.set(a.userId, a.userName);
    return [...names.values()];
  }, [assignments, overlapSet]);

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
      await reload();
      setAssignUserId(null);
      setAssignLcatId(null);
      setAssignEffectiveDate(null);
      setAssignEndDate(null);
      setShowAssignErrors(false);
      setAssignOpen(false);
      toastSuccess({ title: 'Labor category assigned', message: 'The assignment was added.' });
    } catch {
      toastError({ title: 'Assignment Failed', message: 'Something went wrong. Please refresh and try again.' });
    }
  }

  async function handleEnd(assignment: LcatAssignment) {
    try {
      const result = await runAction(endUserLaborCategoryAssignment(assignment.id, endDate ?? undefined), { errorTitle: 'Couldn’t end assignment' });
      if (!result.ok) return;
      await reload();
      toastSuccess({ title: 'Assignment ended', message: `${assignment.userName}'s assignment to ${assignment.lcatCode} has been ended.` });
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

  const where = (a: LcatAssignment) => {
    const slin = categoryNames[a.laborCategoryId]?.slinNumber;
    return `${a.contractName} · CLIN ${a.clinNumber}${slin ? ` · SLIN ${slin}` : ''}`;
  };

  const columns = useMemo<MRT_ColumnDef<Row>[]>(() => [
    {
      id: 'who', header: 'Person / category', enableSorting: false,
      Cell: ({ row: { original: r } }) => (r.level === 'person'
        ? <Text fw={600} span>{r.name}</Text>
        : (
          <span className={styles.oneLine}>
            <span className={styles.mono}>{r.a.lcatCode}</span> {r.a.lcatTitle}
            {highlighted.has(r.a.id) && <VisuallyHidden>, overlapping</VisuallyHidden>}
          </span>
        )),
    },
    { id: 'where', header: 'Where', enableSorting: false, Cell: ({ row: { original: r } }) => (r.level === 'lcat' ? where(r.a) : null) },
    numericColumn<Row>({ id: 'rate', header: 'Rate today', enableSorting: false, Cell: ({ row: { original: r } }) => (r.level === 'lcat' ? perHour(rateByCategory[r.a.laborCategoryId]) : null) }),
    { id: 'from', header: 'From', enableSorting: false, Cell: ({ row: { original: r } }) => (r.level === 'lcat' ? formatCalendarDate(r.a.effectiveDate, 'MMM D, YYYY') : null) },
    {
      id: 'until', header: 'Until', enableSorting: false,
      Cell: ({ row: { original: r } }) => (r.level !== 'lcat' ? null : r.a.endDate ? formatCalendarDate(r.a.endDate, 'MMM D, YYYY') : <span className={styles.dim}>No end</span>),
    },
    {
      id: 'status', header: 'Status', enableSorting: false,
      Cell: ({ row: { original: r } }) => (r.level === 'lcat' ? <span data-testid="lcat-status"><StatusBadge word={r.status.word} tone={TONE[r.status.kind]} /></span> : null),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps -- where() reads categoryNames
  ], [highlighted, rateByCategory, categoryNames]);

  const expandable = useMemo<AppTableExpandable<Row>>(() => ({
    getSubRows: (r) => (r.level === 'person' ? r.children : undefined),
    label: (r) => (r.level === 'person' ? `categories for ${r.name}` : r.a.lcatCode),
    searchText: (r) => (r.level === 'person' ? r.name : `${r.a.lcatCode} ${r.a.lcatTitle}`),
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
    mantineTableBodyRowProps: ({ row: { original: r } }) => (r.level !== 'lcat' ? {} : {
      'data-row': 'lcat',
      'data-person': r.a.userName,
      ...(highlighted.has(r.a.id) || r.status.kind === 'overlaps' ? { className: classes.overlap, 'data-overlap': 'true' } : {}),
    }),
    renderRowActions: ({ row: { original: r } }) => (r.level !== 'lcat' || r.a.endDate !== null ? null : (
      <RowActions
        rowLabel={`${r.a.userName} — ${r.a.lcatCode}`}
        primary={{ key: 'end', label: 'End…', icon: 'endAssignment', onSelect: () => setConfirmEnd(r.a) }}
        items={[]}
      />
    )),
    emptyState: { title: 'No labor category assignments here.', body: 'Assign a labor category to price someone’s hours on a CLIN.' },
  });

  return (
    <Stack gap="sm">
      {overlapPeople.length > 0 && (
        <div data-testid="overlap-notice">
          <Notice action={{ label: 'See what to fix', href: UNPRICED_CONFLICTS_HREF }}>
            {overlapPeople.length === 1
              ? <><b>{overlapPeople[0]} has overlapping labor categories,</b> so some hours aren&apos;t priced.</>
              : <><b>{formatCount(overlapPeople.length)} people have overlapping labor categories,</b> so some hours aren&apos;t priced.</>}
          </Notice>
        </div>
      )}
      <Group align="flex-end" justify="space-between" wrap="wrap">
        <Select
          label="Show" w={260} allowDeselect={false}
          data={[{ value: 'current', label: 'Current and upcoming' }, { value: 'all', label: 'Everything, including ended' }]}
          value={show} onChange={(v) => setShow(v === 'all' ? 'all' : 'current')}
        />
        <WriteButton onClick={() => setAssignOpen(true)}>Assign a labor category</WriteButton>
      </Group>

      {chips.length > 0 && (
        <Group gap="xs" data-testid="lcat-filter-chips">
          {chips.map((c) => <FilterChip key={c.key} label={c.label} onRemove={() => onRemoveFilter(c.key)} data-testid={`lcat-chip-${c.key}`} />)}
        </Group>
      )}

      <MantineReactTable table={table} />

      <Modal opened={assignOpen} onClose={() => { if (!busy.is('assign')) setAssignOpen(false); }} title="Assign a labor category" size="lg">
        <Stack>
          <Select
            label="Person"
            placeholder="Select employee"
            data={users.filter((u) => u.isActive !== false).map((u) => ({ value: u.id, label: u.fullName }))}
            value={assignUserId}
            onChange={setAssignUserId}
            searchable
            error={showAssignErrors && missing.user ? 'Choose an employee.' : undefined}
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
            error={showAssignErrors && missing.lcat ? 'Choose a labor category.' : undefined}
          />
          <Group grow>
            <DateInput
              label="Effective Date" value={assignEffectiveDate} onChange={setAssignEffectiveDate} required
              error={showAssignErrors && missing.date ? 'Enter the effective date.' : undefined}
            />
            <DateInput label="End Date" value={assignEndDate} onChange={setAssignEndDate} clearable />
          </Group>
          {assignIncomplete && (
            <Text size="xs" c="dimmed" id={assignHintId} data-testid="assign-hint">
              Choose an employee, a labor category and an effective date.
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => { if (!busy.is('assign')) setAssignOpen(false); }}>Cancel</Button>
            <WriteButton
              {...busy.props('assign', { blocked: assignIncomplete })}
              aria-describedby={assignIncomplete ? assignHintId : undefined}
              onClick={() => {
                if (assignIncomplete) { setShowAssignErrors(true); return; }
                void busy.run('assign', handleAssign);
              }}
            >
              Assign
            </WriteButton>
          </Group>
        </Stack>
      </Modal>

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
    </Stack>
  );
}
