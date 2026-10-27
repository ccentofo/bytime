'use client';

import { useState, useTransition } from 'react';
import { Button, Group, Modal, Select, Stack, Text, Title } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { runAction } from '@/lib/run-action';
import { compare, formatCalendarDate, isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { categoryFitsCode, chargeCodeCategoryOn, type CategorySchedule, type CategoryScheduleView, type RatePeriodRef } from '@/lib/labor-rates';
import {
  addChargeCodeCategoryChange, correctChargeCodeCategory, previewChargeCodeCategoryImpact, removeChargeCodeCategoryChange,
} from '@/server/actions/charge-code-categories';
import { ImpactPanel, useImpactGate } from '@/components/admin/ImpactGate';
import { EffectiveDatedTable } from '@/components/admin/EffectiveDatedTable';

/**
 * A charge code's dated labor category (feature-plan-dated-rates.md D3) — same structure and gate as the rate schedule:
 * Preview → (Reason + checkbox when it re-prices recorded hours on this code) → save; on success the page merges the
 * returned schedule. DR-Q2 default: only categories on the code's own CLIN (and SLIN) are offered. Only the starting
 * category may be "No labor category".
 */

export interface CategoryOption { id: string; lcatCode: string; title: string; clinId: string; slinId: string | null; status: string }
type Mode = { kind: 'add' } | { kind: 'correct'; target: RatePeriodRef } | { kind: 'remove'; changeId: string } | null;
const NONE = '__none__';

export function ChargeCodeCategoryModal({ opened, onClose, code, categories, canWrite, onSaved }: {
  opened: boolean;
  onClose: () => void;
  code: { id: string; code: string; clinId: string; slinId: string | null; schedule: CategorySchedule } | null;
  categories: CategoryOption[];
  canWrite: boolean;
  onSaved: (view: CategoryScheduleView) => void;
}) {
  const [schedule, setSchedule] = useState<CategorySchedule | null>(code?.schedule ?? null);
  const [shownFor, setShownFor] = useState<string | null>(code?.id ?? null);
  const [mode, setMode] = useState<Mode>(null);
  const [date, setDate] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const gate = useImpactGate();

  if (code && code.id !== shownFor) {
    setShownFor(code.id);
    setSchedule(code.schedule);
    setMode(null);
  }
  if (!code || !schedule) return null;

  const nameOf = (id: string | null) => {
    if (!id) return 'No labor category';
    const c = categories.find((x) => x.id === id);
    return c ? `${c.lcatCode}: ${c.title}` : 'Unknown category';
  };
  const eligible = categories.filter((c) => categoryFitsCode(c, { clinId: code.clinId, slinId: code.slinId }));
  const rows = [
    { ref: 'starting' as RatePeriodRef, label: 'From the start', laborCategoryId: schedule.starting },
    ...[...schedule.changes].sort((a, b) => compare(a.effectiveDate, b.effectiveDate))
      .map((c) => ({ ref: c.id, label: formatCalendarDate(c.effectiveDate, 'MMM D, YYYY'), laborCategoryId: c.laborCategoryId as string | null })),
  ];
  const allowNone = mode?.kind === 'correct' && mode.target === 'starting';
  const options = [
    ...(allowNone ? [{ value: NONE, label: 'No labor category' }] : []),
    ...eligible.map((c) => ({ value: c.id, label: `${c.lcatCode}: ${c.title}${c.status !== 'active' ? ` (${c.status})` : ''}` })),
  ];

  function start(next: Mode) {
    setMode(next);
    setError(null);
    gate.reset();
    if (next?.kind === 'add') { setDate(null); setCategory(null); }
    if (next?.kind === 'correct') setCategory(rows.find((r) => r.ref === next.target)?.laborCategoryId ?? NONE);
  }
  // A value change clears the preview / reason / checkbox; typing the reason doesn't.
  function onDate(value: string | null) {
    setDate(value);
    gate.reset();
    if (value && isCalendarDate(value)) setCategory(chargeCodeCategoryOn(schedule!, value as CalendarDate).laborCategoryId);
  }
  function onCategory(value: string | null) { setCategory(value); gate.reset(); }
  const categoryValue = category === NONE ? null : category;

  function preview() {
    if (!mode) return;
    setError(null);
    startTransition(async () => {
      const input = mode.kind === 'add'
        ? { kind: 'add' as const, chargeCodeId: code!.id, effectiveDate: date ?? '', laborCategoryId: categoryValue }
        : mode.kind === 'correct'
          ? { kind: 'correct' as const, chargeCodeId: code!.id, target: mode.target, laborCategoryId: categoryValue }
          : { kind: 'remove' as const, chargeCodeId: code!.id, changeId: mode.changeId };
      const r = await runAction(previewChargeCodeCategoryImpact(input), { silent: true });
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
        ? addChargeCodeCategoryChange({ chargeCodeId: code!.id, effectiveDate: date ?? '', laborCategoryId: categoryValue, reason })
        : mode.kind === 'correct'
          ? correctChargeCodeCategory({ chargeCodeId: code!.id, target: mode.target, laborCategoryId: categoryValue, reason })
          : removeChargeCodeCategoryChange({ chargeCodeId: code!.id, changeId: mode.changeId, reason }), { silent: true });
      if (!r.ok) { setError(r.error); return; } // keep the form
      setSchedule({ starting: r.data.starting, changes: r.data.changes });
      onSaved(r.data);
      setMode(null);
      gate.reset();
    });
  }

  const saveLabel = mode?.kind === 'add' ? 'Add' : mode?.kind === 'correct' ? 'Save correction' : 'Remove change';

  return (
    <Modal opened={opened} onClose={onClose} title={`Labor category — ${code.code}`} size="lg">
      <Stack>
        <EffectiveDatedTable
          headers={['Labor category']}
          rows={rows.map((r) => ({ ref: r.ref, label: r.label, cells: [nameOf(r.laborCategoryId)] }))}
          canWrite={canWrite}
          onCorrect={(ref) => start({ kind: 'correct', target: ref })}
          onRemove={(ref) => start({ kind: 'remove', changeId: ref })}
          testIdPrefix="cat"
        />
        {!mode && <Button variant="light" disabled={!canWrite} onClick={() => start({ kind: 'add' })} data-testid="cat-start-add">Add a category change</Button>}
        {mode && (
          <Stack gap="xs">
            <Title order={5}>{mode.kind === 'add' ? 'Add a category change' : mode.kind === 'correct' ? `Correct ${rows.find((r) => r.ref === mode.target)?.label}` : `Remove the change from ${rows.find((r) => r.ref === mode.changeId)?.label}`}</Title>
            {mode.kind === 'add' && <DateInput label="Effective date" value={date} onChange={onDate} valueFormat="YYYY-MM-DD" data-testid="cat-date" />}
            {mode.kind !== 'remove' && (
              <Select
                label="Labor category"
                description="Only categories on this charge code's CLIN (and SLIN) are listed."
                data={options}
                value={category}
                onChange={onCategory}
                searchable
                data-testid="cat-category"
              />
            )}
            <ImpactPanel gate={gate} testIdPrefix="cat" />
            {error && <Text size="sm" c="red" data-testid="cat-error">{error}</Text>}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => { setMode(null); gate.reset(); setError(null); }}>Cancel</Button>
              <Button variant="light" onClick={preview} loading={isPending} disabled={(mode.kind === 'add' && !date) || (mode.kind !== 'remove' && category === null)} data-testid="cat-preview">Preview</Button>
              <Button onClick={save} loading={isPending} disabled={!gate.ready} color={mode.kind === 'remove' ? 'red' : undefined} data-testid="cat-save">{saveLabel}</Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
