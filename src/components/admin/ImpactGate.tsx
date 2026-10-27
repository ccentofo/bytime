'use client';

import { useState } from 'react';
import { Checkbox, Stack, Text, Textarea } from '@mantine/core';
import { addDays, formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';

/**
 * The preview → reason → checkbox gate shared by the dated-schedule modals (feature-plan-dated-rates.md D2 / D3).
 * A save is enabled only once a preview for the CURRENT values has run and, when it re-prices recorded hours
 * (`reasonRequired`), a reason is typed and "I understand past costs will change" is ticked. Changing a value field
 * calls `reset()` (preview, reason and checkbox cleared); typing the reason does not.
 */
export interface Impact { hours: string; from: CalendarDate | null; toExclusive: CalendarDate | null; reasonRequired: boolean }

export function useImpactGate() {
  const [impact, setImpact] = useState<Impact | null>(null);
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const reset = () => { setImpact(null); setReason(''); setAcknowledged(false); };
  const ready = impact !== null && (!impact.reasonRequired || (reason.trim() !== '' && acknowledged));
  return { impact, setImpact, reason, setReason, acknowledged, setAcknowledged, reset, ready };
}

const day = (d: CalendarDate) => formatCalendarDate(d, 'MMM D, YYYY');

/** "(Jan 1, 2027 – Mar 31, 2027)", "(from Jan 1, 2027)", "(through Dec 31, 2026)", "(all dates)". */
export function periodLabel(from: CalendarDate | null, toExclusive: CalendarDate | null): string {
  const to = toExclusive ? addDays(toExclusive, -1) : null;
  if (from && to) return `(${day(from)} – ${day(to)})`;
  if (from) return `(from ${day(from)})`;
  if (to) return `(through ${day(to)})`;
  return '(all dates)';
}

export function impactMessage(i: Impact): string {
  return Number(i.hours) > 0
    ? `This changes the cost of ${i.hours} recorded hours ${periodLabel(i.from, i.toExclusive)}.`
    : 'No recorded hours are affected.';
}

export function ImpactPanel({ gate, testIdPrefix }: { gate: ReturnType<typeof useImpactGate>; testIdPrefix: string }) {
  if (!gate.impact) return null;
  return (
    <Stack gap="xs">
      <Text size="sm" data-testid={`${testIdPrefix}-impact`}>{impactMessage(gate.impact)}</Text>
      {gate.impact.reasonRequired && (
        <>
          <Textarea
            label="Reason"
            required
            maxLength={500}
            value={gate.reason}
            onChange={(e) => gate.setReason(e.currentTarget.value)}
            data-testid={`${testIdPrefix}-reason`}
          />
          <Checkbox
            label="I understand past costs will change"
            checked={gate.acknowledged}
            onChange={(e) => gate.setAcknowledged(e.currentTarget.checked)}
            data-testid={`${testIdPrefix}-ack`}
          />
        </>
      )}
    </Stack>
  );
}
