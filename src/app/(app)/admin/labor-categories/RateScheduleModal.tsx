'use client';

import { useState, useTransition } from 'react';
import { Button, Group, Modal, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { runAction } from '@/lib/run-action';
import { formatCalendarDate, isCalendarDate, compare, type CalendarDate } from '@/lib/calendar-date';
import { rateOn, type RatePeriodRef, type RateSchedule, type RateScheduleView } from '@/lib/labor-rates';
import {
  addLaborCategoryRateChange, correctLaborCategoryRate, previewRateChangeImpact, removeLaborCategoryRateChange,
} from '@/server/actions/labor-category-rates';
import { ImpactPanel, useImpactGate } from '@/components/admin/ImpactGate';

/**
 * A labor category's rate schedule (feature-plan-dated-rates.md D2): "From the start" then each change, ascending.
 * Add a rate change, correct a period, or remove a change — each through Preview → (Reason + checkbox when it
 * re-prices recorded hours) → save. On success the modal's schedule is replaced AND the page merges the returned
 * schedule (onSaved), so the main table shows the new current rate.
 */

type Mode = { kind: 'add' } | { kind: 'correct'; target: RatePeriodRef } | { kind: 'remove'; changeId: string } | null;

function formatRate(rate: string | null): string {
  if (!rate) return '—';
  const num = parseFloat(rate);
  return isNaN(num) ? '—' : `$${num.toFixed(2)}`;
}

export function RateScheduleModal({ opened, onClose, category, canWrite, onSaved }: {
  opened: boolean;
  onClose: () => void;
  category: { id: string; lcatCode: string; title: string; schedule: RateSchedule } | null;
  canWrite: boolean;
  onSaved: (view: RateScheduleView) => void;
}) {
  const [schedule, setSchedule] = useState<RateSchedule | null>(category?.schedule ?? null);
  const [shownFor, setShownFor] = useState<string | null>(category?.id ?? null);
  const [mode, setMode] = useState<Mode>(null);
  const [date, setDate] = useState<string | null>(null);
  const [hourly, setHourly] = useState('');
  const [ceiling, setCeiling] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const gate = useImpactGate();

  // A different category opened: show its schedule (render-time state sync, no effect).
  if (category && category.id !== shownFor) {
    setShownFor(category.id);
    setSchedule(category.schedule);
    setMode(null);
  }
  if (!category || !schedule) return null;

  const rows = [
    { ref: 'starting' as RatePeriodRef, label: 'From the start', hourlyRate: schedule.starting.hourlyRate, ceilingRate: schedule.starting.ceilingRate },
    ...[...schedule.changes].sort((a, b) => compare(a.effectiveDate, b.effectiveDate))
      .map((c) => ({ ref: c.id, label: formatCalendarDate(c.effectiveDate, 'MMM D, YYYY'), hourlyRate: c.hourlyRate, ceilingRate: c.ceilingRate })),
  ];

  function start(next: Mode) {
    setMode(next);
    setError(null);
    gate.reset();
    if (next?.kind === 'add') { setDate(null); setHourly(''); setCeiling(''); }
    if (next?.kind === 'correct') {
      const row = rows.find((r) => r.ref === next.target)!;
      setHourly(row.hourlyRate);
      setCeiling(row.ceilingRate ?? '');
    }
  }

  // A value field changed: clear the preview, the reason and the checkbox (typing the reason never does).
  function onDate(value: string | null) {
    setDate(value);
    gate.reset();
    if (value && isCalendarDate(value)) {
      const inEffect = rateOn(schedule!, value as CalendarDate);
      setHourly(inEffect.hourlyRate);
      setCeiling(inEffect.ceilingRate ?? '');
    }
  }
  function onHourly(value: string) { setHourly(value); gate.reset(); }
  function onCeiling(value: string) { setCeiling(value); gate.reset(); }

  const ceilingValue = ceiling.trim() === '' ? null : ceiling.trim();

  function preview() {
    if (!mode) return;
    setError(null);
    startTransition(async () => {
      const input = mode.kind === 'add'
        ? { kind: 'add' as const, laborCategoryId: category!.id, effectiveDate: date ?? '', hourlyRate: hourly, ceilingRate: ceilingValue }
        : mode.kind === 'correct'
          ? { kind: 'correct' as const, laborCategoryId: category!.id, target: mode.target, hourlyRate: hourly, ceilingRate: ceilingValue }
          : { kind: 'remove' as const, laborCategoryId: category!.id, changeId: mode.changeId };
      const r = await runAction(previewRateChangeImpact(input), { silent: true });
      if (!r.ok) { setError(r.error); return; }
      gate.setImpact(r.data);
    });
  }

  function save() {
    if (!mode || !gate.ready) return;
    setError(null);
    startTransition(async () => {
      const reason = gate.reason.trim() || undefined;
      const r = await runAction(mode.kind === 'add'
        ? addLaborCategoryRateChange({ laborCategoryId: category!.id, effectiveDate: date ?? '', hourlyRate: hourly, ceilingRate: ceilingValue, reason })
        : mode.kind === 'correct'
          ? correctLaborCategoryRate({ laborCategoryId: category!.id, target: mode.target, hourlyRate: hourly, ceilingRate: ceilingValue, reason })
          : removeLaborCategoryRateChange({ laborCategoryId: category!.id, changeId: mode.changeId, reason }), { silent: true });
      if (!r.ok) { setError(r.error); return; } // keep the form
      setSchedule({ starting: r.data.starting, changes: r.data.changes });
      onSaved(r.data);
      setMode(null);
      gate.reset();
    });
  }

  const saveLabel = mode?.kind === 'add' ? 'Add' : mode?.kind === 'correct' ? 'Save correction' : 'Remove change';

  return (
    <Modal opened={opened} onClose={onClose} title={`Rates — ${category.lcatCode}: ${category.title}`} size="lg">
      <Stack>
        <Table data-testid="rate-schedule">
          <Table.Thead>
            <Table.Tr><Table.Th>From</Table.Th><Table.Th>Hourly</Table.Th><Table.Th>Ceiling</Table.Th><Table.Th /><Table.Th /></Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r.ref}>
                <Table.Td>{r.label}</Table.Td>
                <Table.Td>{formatRate(r.hourlyRate)}</Table.Td>
                <Table.Td>{formatRate(r.ceilingRate)}</Table.Td>
                <Table.Td><Button size="xs" variant="subtle" disabled={!canWrite} onClick={() => start({ kind: 'correct', target: r.ref })} data-testid={`rate-correct-${r.ref}`}>Correct</Button></Table.Td>
                <Table.Td>{r.ref !== 'starting' && <Button size="xs" variant="subtle" color="red" disabled={!canWrite} onClick={() => start({ kind: 'remove', changeId: r.ref })} data-testid={`rate-remove-${r.ref}`}>Remove</Button>}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>

        {!mode && <Button variant="light" disabled={!canWrite} onClick={() => start({ kind: 'add' })} data-testid="rate-start-add">Add a rate change</Button>}

        {mode && (
          <Stack gap="xs">
            <Title order={5}>{mode.kind === 'add' ? 'Add a rate change' : mode.kind === 'correct' ? `Correct ${rows.find((r) => r.ref === mode.target)?.label}` : `Remove the change from ${rows.find((r) => r.ref === mode.changeId)?.label}`}</Title>
            {mode.kind === 'add' && <DateInput label="Effective date" value={date} onChange={onDate} valueFormat="YYYY-MM-DD" data-testid="rate-date" />}
            {mode.kind !== 'remove' && (
              <Group grow>
                <TextInput label="Hourly ($)" value={hourly} onChange={(e) => onHourly(e.currentTarget.value)} data-testid="rate-hourly" />
                <TextInput label="Ceiling ($)" placeholder="optional" value={ceiling} onChange={(e) => onCeiling(e.currentTarget.value)} data-testid="rate-ceiling" />
              </Group>
            )}
            <ImpactPanel gate={gate} testIdPrefix="rate" />
            {error && <Text size="sm" c="red" data-testid="rate-error">{error}</Text>}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => { setMode(null); gate.reset(); setError(null); }}>Cancel</Button>
              <Button variant="light" onClick={preview} loading={isPending} disabled={mode.kind === 'add' && !date} data-testid="rate-preview">Preview</Button>
              <Button onClick={save} loading={isPending} disabled={!gate.ready} color={mode.kind === 'remove' ? 'red' : undefined} data-testid="rate-save">{saveLabel}</Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
