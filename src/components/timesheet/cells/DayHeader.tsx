'use client';

import { memo } from 'react';
import { formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import styles from '../Timesheet.module.css';

export interface DayHeaderProps {
  gridId: string;
  d: number;
  date: CalendarDate;
  isToday: boolean;
  weekend: boolean;
  hours: number;
  /** A past weekday on or after the user's creation day with no hours. */
  noHoursLogged: boolean;
}

const hoursWord = (h: number) => `${Number(h.toFixed(2))} hours`;

/**
 * A day column header (§4.2, mockup): the visible day name and date ("Today" in place of the date on today) and a fill
 * meter, all aria-hidden; screen readers get "Monday Oct 19[, today], {h} hours[, no hours logged]". The hidden
 * `{id}-chn-{d}` span holds only the day name and date, for the editor's name. No "Late" badge (the meter replaces it).
 */
export const DayHeader = memo(function DayHeader(p: DayHeaderProps) {
  const dayDate = formatCalendarDate(p.date, 'dddd MMM D');
  const fill = Math.max(0, Math.min(1, p.hours / 8));
  return (
    <th scope="col" id={`${p.gridId}-ch-${p.d}`} className={[styles.dayHeader, p.weekend && styles.weekend, p.isToday && styles.todayHead].filter(Boolean).join(' ')}>
      <span aria-hidden="true" className={styles.dayHeadVisible}>
        <span className={styles.dayName}>{formatCalendarDate(p.date, 'ddd')}</span>
        <span className={styles.dayDate}>{p.isToday ? 'Today' : formatCalendarDate(p.date, 'MMM D')}</span>
        <span className={styles.meter} data-empty={p.hours === 0 || undefined}><span className={styles.meterFill} style={{ inlineSize: `${fill * 100}%` }} /></span>
      </span>
      <span className={styles.srOnly}>{dayDate}{p.isToday ? ', today' : ''}, {hoursWord(p.hours)}{p.noHoursLogged ? ', no hours logged' : ''}</span>
      <span id={`${p.gridId}-chn-${p.d}`} hidden>{dayDate}</span>
    </th>
  );
});
