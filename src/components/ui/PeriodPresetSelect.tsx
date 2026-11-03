'use client';

import { Group, Select, Stack } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { isCalendarDate, type CalendarDate } from '@/lib/calendar-date';

export const CUSTOM_PRESET = 'custom';

export interface PeriodSelection {
  /** A preset key from `presets`, or CUSTOM_PRESET. */
  preset: string;
  start: CalendarDate | null;
  end: CalendarDate | null;
}

export const RANGE_ORDER_ERROR = 'The end date must be on or after the start date.';

/** The selection's inline error (custom only), or null. */
export function periodSelectionError(v: PeriodSelection): string | null {
  return v.preset === CUSTOM_PRESET && v.start && v.end && v.end < v.start ? RANGE_ORDER_ERROR : null;
}

/** A custom selection that's complete and in order (the caller can download). */
export function periodSelectionReady(v: PeriodSelection): boolean {
  return v.preset !== CUSTOM_PRESET || (!!v.start && !!v.end && !periodSelectionError(v));
}

/**
 * A period preset picker (feature-plan-ux-kit-contracts.md §3.8): a Select of presets ("Last pay period · Oct 1 – 15,
 * 2026", …) plus "Custom dates…", which reveals start and end DateInputs with an inline start ≤ end check. The caller
 * turns the selection into a range (resolvePeriodRange) when it's used.
 */
export function PeriodPresetSelect({ label, presets, value, onChange, w }: {
  label: string;
  presets: Array<{ value: string; label: string }>;
  value: PeriodSelection;
  onChange: (next: PeriodSelection) => void;
  w?: number | string;
}) {
  const error = periodSelectionError(value);
  const asDate = (v: string | null) => (v && isCalendarDate(v) ? v : null);
  return (
    <Stack gap={6}>
      <Select
        label={label}
        data={[...presets, { value: CUSTOM_PRESET, label: 'Custom dates…' }]}
        value={value.preset}
        onChange={(preset) => preset && onChange({ preset, start: value.start, end: value.end })}
        allowDeselect={false}
        w={w}
      />
      {value.preset === CUSTOM_PRESET && (
        <Group gap="sm" align="flex-start" wrap="wrap">
          <DateInput label="Start date" value={value.start} onChange={(d) => onChange({ ...value, start: asDate(d) })} clearable w={160} />
          <DateInput label="End date" value={value.end} onChange={(d) => onChange({ ...value, end: asDate(d) })} clearable w={160}
            error={error ?? undefined} />
        </Group>
      )}
    </Stack>
  );
}
