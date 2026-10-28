'use client';

import { useTimesheetState } from '@/components/timesheet/TimesheetContext';
import { formatCalendarDate, isBefore } from '@/lib/calendar-date';
import styles from './Timesheet.module.css';

const n = (v: number) => Number(v.toFixed(2));

/**
 * The status line (feature-plan-ux-timesheet-ui.md §4.1 item 2): a plain <p>, deliberately NOT a live region (the
 * mockup's role="status" is not used, trap T-K). Built from periodProgress over the WORKING entries, so it follows
 * unsaved edits; submitted / approved periods use the server's submittedOn / reviewedOn calendar days.
 */
export function StatusLine() {
  const { state, checks } = useTimesheetState();
  const { progress } = checks;
  let text: string;
  if (state.periodStatus === 'submitted') {
    text = `${n(progress.total)} hours · Submitted ${state.submittedOn ? formatCalendarDate(state.submittedOn, 'MMM D, YYYY') : ''}`.trimEnd();
  } else if (state.periodStatus === 'approved') {
    text = `${n(progress.total)} hours · Approved ${state.reviewedOn ? formatCalendarDate(state.reviewedOn, 'MMM D, YYYY') : ''}`.trimEnd();
  } else {
    const due = isBefore(progress.dueDate, state.today)
      ? `Was due ${formatCalendarDate(progress.dueDate, 'MMM D')}`
      : `Due ${formatCalendarDate(progress.dueDate, 'dddd, MMM D')}`;
    text = `${n(progress.total)} hours entered · ${progress.workdaysFilled} of ${progress.expectedWorkdays} workdays so far are filled in · ${due}`;
  }
  return <p className={styles.statusLine} data-testid="status-line">{text}</p>;
}
