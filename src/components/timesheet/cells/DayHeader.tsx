'use client';

import { memo } from 'react';
import { formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import styles from '../Timesheet.module.css';

export interface DayHeaderProps {
  gridId: string;
  d: number;
  date: CalendarDate;
  isToday: boolean;
  /** After today: the name and date are dimmed (§14.2). */
  future: boolean;
  hours: number;
  /** A past weekday on or after the user's creation day with no hours. */
  noHoursLogged: boolean;
}

const hoursWord = (h: number) => `${Number(h.toFixed(2))} hours`;

/**
 * A day column header (§4.2, §14.2): the visible day name and, below it, the date ("Today" on today), aria-hidden; screen
 * readers get "Monday Oct 19[, today], {h} hours[, no hours logged]". The hidden `{id}-chn-{d}` span holds only the day
 * name and date, for the editor's name. No meter and no "Late" badge; today is a top edge, future days are dimmed.
 */
export const DayHeader = memo(function DayHeader(p: DayHeaderProps) {
  const dayDate = formatCalendarDate(p.date, 'dddd MMM D');
  return (
    <th scope="col" id={`${p.gridId}-ch-${p.d}`} className={[styles.dayHeader, p.isToday && styles.todayHead, p.future && styles.futureHead].filter(Boolean).join(' ')}>
      <span aria-hidden="true" className={styles.dayHeadVisible}>
        <span className={styles.dayName}>{formatCalendarDate(p.date, 'ddd')}</span>
        <span className={styles.dayDate}>{p.isToday ? 'Today' : formatCalendarDate(p.date, 'MMM D')}</span>
      </span>
      <span className={styles.srOnly}>{dayDate}{p.isToday ? ', today' : ''}, {hoursWord(p.hours)}{p.noHoursLogged ? ', no hours logged' : ''}</span>
      <span id={`${p.gridId}-chn-${p.d}`} hidden>{dayDate}</span>
    </th>
  );
});
