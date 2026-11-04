'use client';

import { Text, VisuallyHidden } from '@mantine/core';
import { addDays, dayOfWeek, formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { formatHours } from '@/lib/format';
import { shownRowName } from '@/lib/timesheet/labels';
import type { FlaggedCell } from '@/lib/approvals/flagged-cells';
import type { ChargeCode, TimesheetEntry } from '@/types/timesheet';
import classes from './ReviewGrid.module.css';

/**
 * The review's read-only grid (feature-plan-ux-approvals-payroll.md §3.3.1): the timesheet's visual language — a name
 * then code row header, weekday headers, weekend tint, blank empty cells, row / daily / period totals. Corrected and
 * late cells are marked (fill + line + corner) with ", corrected" / ", late entry" for screen readers; noted cells get
 * a corner and ", has a note". Imported hours keep their provenance as the cell's title.
 */
export function ReviewGrid({ chargeCodes, entries, start, numDays, flagged, notes, caption, dimmed = false }: {
  chargeCodes: ChargeCode[];
  entries: TimesheetEntry[];
  start: CalendarDate;
  numDays: number;
  flagged: FlaggedCell[];
  notes: Record<string, { body: string; revision: number }>;
  /** "Hours for {employee}, {period}". */
  caption: string;
  /** Kept on screen while another timesheet loads: the table (never a focusable element) is dimmed. */
  dimmed?: boolean;
}) {
  const days = Array.from({ length: numDays }, (_, i) => addDays(start, i));
  const weekend = (d: CalendarDate) => dayOfWeek(d) === 0 || dayOfWeek(d) === 6;
  const flagOf = new Map(flagged.map((f) => [`${f.rowId}-${f.dayIndex}`, f]));
  const hoursOf = (id: string) => entries.find((e) => e.chargeCodeId === id);
  const dayTotals = days.map((_, i) => chargeCodes.reduce((s, cc) => s + (hoursOf(cc.id)?.hours[i] ?? 0), 0));
  const total = dayTotals.reduce((a, b) => a + b, 0);
  const cell = (n: number) => (n === 0 ? '' : formatHours(n));

  return (
    <div>
      {/* A keyboard-scrollable region named by the caption (fix round 1, L4): axe's scrollable-region-focusable. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region must be reachable by keyboard */}
      <div className={classes.wrap} tabIndex={0} role="region" aria-label={caption}>
        <table className={dimmed ? `${classes.grid} ${classes.dimmed}` : classes.grid}>
          <caption className={classes.caption}>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Charge code</th>
              {days.map((d) => (
                <th key={d} scope="col" className={weekend(d) ? classes.weekend : undefined}>
                  {formatCalendarDate(d, 'ddd')}{' '}<span className={classes.day}>{formatCalendarDate(d, 'MMM D')}</span>
                </th>
              ))}
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {chargeCodes.map((cc) => {
              const entry = hoursOf(cc.id);
              const hours = entry?.hours ?? [];
              const rowTotal = hours.reduce((a, b) => a + b, 0);
              const name = shownRowName(cc);
              return (
                <tr key={cc.id}>
                  <th scope="row">
                    <Text fw={600} size="sm" span>{name || cc.clin}</Text>
                    {name && <span className={classes.code}>{cc.clin}</span>}
                    {!cc.assignable && <Text size="xs" c="dimmed">Closed to new hours (recorded hours shown)</Text>}
                  </th>
                  {days.map((d, i) => {
                    const flag = flagOf.get(`${cc.id}-${i}`);
                    const note = notes[`${cc.id}-${i}`]?.body;
                    const provenance = entry?.provenance?.[i] ?? null;
                    const cls = [weekend(d) ? classes.weekend : '', flag ? classes.flagged : '', note ? classes.noted : ''].filter(Boolean).join(' ');
                    return (
                      <td key={d} className={cls || undefined} title={provenance ?? undefined} data-flag={flag?.kind} data-note={note ? 'true' : undefined}>
                        {cell(hours[i] ?? 0)}
                        {provenance && <Text span size="xs" c="signal" data-testid="imported-indicator"> •</Text>}
                        {flag && <VisuallyHidden>{flag.kind === 'late' ? ', late entry' : ', corrected'}</VisuallyHidden>}
                        {note && <VisuallyHidden data-testid="note-indicator">, has a note</VisuallyHidden>}
                      </td>
                    );
                  })}
                  <td>{formatHours(rowTotal)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className={classes.foot}>
            <tr>
              <th scope="row">Daily total</th>
              {dayTotals.map((t, i) => <td key={days[i]} className={weekend(days[i]) ? classes.weekend : undefined}>{cell(t)}</td>)}
              <td data-testid="review-total">{formatHours(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className={classes.legend} aria-hidden="true">
        <span className={classes.legendFlag}>Corrected or late</span>
        <span className={classes.legendNote}>Has a note</span>
      </div>
    </div>
  );
}
