'use client';

import { useId, useState } from 'react';
import { Button, Group, Modal, Stack, Text, Title } from '@mantine/core';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { useBusy } from '@/components/ui/useBusy';
import { DateInput } from '@mantine/dates';
import { runAction } from '@/lib/run-action';
import { formatCalendarDate, isCalendarDate, compare, type CalendarDate } from '@/lib/calendar-date';
import { rateOn, type RatePeriodRef, type RateSchedule, type RateScheduleView } from '@/lib/labor-rates';
import {
  addLaborCategoryRateChange, correctLaborCategoryRate, previewRateChangeImpact, removeLaborCategoryRateChange,
} from '@/server/actions/labor-category-rates';
import { ImpactPanel, useImpactGate } from '@/components/admin/ImpactGate';
import { EffectiveDatedTable } from '@/components/admin/EffectiveDatedTable';

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
  const [dateError, setDateError] = useState<string | null>(null);
  // UX-4B1-AUDIT L13: Preview and Save are never `disabled` / `loading`; they block each other while one runs (group),
  // and a step that can't run yet is aria-disabled with the reason (hintId).
  const busy = useBusy();
  const hintId = useId();
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
    setDateError(null);
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
    setDateError(null);
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
    if (mode.kind === 'add' && !date) { setDateError('Choose an effective date.'); return; }
    setError(null);
    const ticket = gate.begin();
    void busy.run('preview', async () => {
      const input = mode.kind === 'add'
        ? { kind: 'add' as const, laborCategoryId: category!.id, effectiveDate: date ?? '', hourlyRate: hourly, ceilingRate: ceilingValue }
        : mode.kind === 'correct'
          ? { kind: 'correct' as const, laborCategoryId: category!.id, target: mode.target, hourlyRate: hourly, ceilingRate: ceilingValue }
          : { kind: 'remove' as const, laborCategoryId: category!.id, changeId: mode.changeId };
      const r = await runAction(previewRateChangeImpact(input), { silent: true });
      if (!gate.isCurrent(ticket)) return; // the values changed while it ran — never apply it (audit M1)
      if (!r.ok) { setError(r.error); return; }
      gate.setImpact(r.data);
    }, { group: 'rate' });
  }

  function save() {
    if (!mode || !gate.ready) return;
    setError(null);
    void busy.run('save', async () => {
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
    }, { group: 'rate' });
  }

  function discard() { setMode(null); gate.reset(); setError(null); }
  function close() { discard(); onClose(); } // reopening never shows a half-done form (audit L5)

  const saveLabel = mode?.kind === 'add' ? 'Add' : mode?.kind === 'correct' ? 'Save correction' : 'Remove change';
  const previewBlocked = mode?.kind === 'add' && !date;
  const hint = previewBlocked ? 'Choose an effective date, then preview the change.'
    : !gate.impact ? 'Preview the change before saving it.'
      : !gate.ready ? 'Enter a reason and tick the box to save.' : null;

  return (
    <Modal opened={opened} onClose={close} title={`Rates — ${category.lcatCode}: ${category.title}`} size="lg">
      <Stack>
        <EffectiveDatedTable
          headers={['Hourly', 'Ceiling']}
          rows={rows.map((r) => ({ ref: r.ref, label: r.label, cells: [formatRate(r.hourlyRate), formatRate(r.ceilingRate)] }))}
          canWrite={canWrite}
          onCorrect={(ref) => start({ kind: 'correct', target: ref })}
          onRemove={(ref) => start({ kind: 'remove', changeId: ref })}
          testIdPrefix="rate"
        />

        {!mode && <Button variant="light" disabled={!canWrite} onClick={() => start({ kind: 'add' })} data-testid="rate-start-add">Add a rate change</Button>}

        {mode && (
          <Stack gap="xs">
            <Title order={5}>{mode.kind === 'add' ? 'Add a rate change' : mode.kind === 'correct' ? `Correct ${rows.find((r) => r.ref === mode.target)?.label}` : `Remove the change from ${rows.find((r) => r.ref === mode.changeId)?.label}`}</Title>
            {mode.kind === 'add' && <DateInput label="Effective date" value={date} onChange={onDate} error={dateError ?? undefined} data-testid="rate-date" />}
            {mode.kind !== 'remove' && (
              <Group grow>
                {/* UX-4b §4.2.6: MoneyInput (9,999.99 is validateRate's ceiling, checked on blur; the server enforces it). */}
                <MoneyInput label="Hourly" max={9_999.99} value={hourly} onChange={onHourly} data-testid="rate-hourly" />
                <MoneyInput label="Ceiling" placeholder="optional" max={9_999.99} value={ceiling} onChange={onCeiling} data-testid="rate-ceiling" />
              </Group>
            )}
            <ImpactPanel gate={gate} testIdPrefix="rate" />
            {error && <Text size="sm" c="red" data-testid="rate-error">{error}</Text>}
            <Group justify="flex-end">
              <Button variant="default" onClick={discard}>Cancel</Button>
              <Button variant="light" {...busy.props('preview', { group: 'rate', blocked: previewBlocked })} aria-describedby={previewBlocked ? hintId : undefined}
                onClick={preview} data-testid="rate-preview">Preview</Button>
              <Button {...busy.props('save', { group: 'rate', blocked: !gate.ready })} aria-describedby={!gate.ready ? hintId : undefined}
                onClick={save} color={mode.kind === 'remove' ? 'red' : undefined} data-testid="rate-save">{saveLabel}</Button>
            </Group>
            {hint && <Text size="xs" c="dimmed" ta="right" id={hintId} data-testid="rate-hint">{hint}</Text>}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
