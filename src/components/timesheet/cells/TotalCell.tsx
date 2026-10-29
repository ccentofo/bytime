'use client';

import { memo, useContext } from 'react';
import { RenderProbeContext } from '@/components/timesheet/RenderProbe';
import styles from '../Timesheet.module.css';

export interface TotalCellProps {
  r: number | 'foot';
  c: number | 'total';
  value: number;
  isActive: boolean;
  /** Hidden "Totals are calculated." description id. */
  whyId: string;
  /** Extra screen-reader words after the value (e.g. ", no hours, past workday"). */
  srExtra?: string;
  grand?: boolean;
}

/** A calculated total (row total, a footer day, or the grand total): read-only, 2 decimals (§4.2). Memoized (§7). */
export const TotalCell = memo(function TotalCell(p: TotalCellProps) {
  useContext(RenderProbeContext)?.('cell', `${p.r}:${p.c}`);
  // The weekend and today tints are for body day cells only (§14.2); the Total column gets the heavier line before it.
  const className = [styles.cell, styles.total, p.c === 'total' && styles.totalCol, p.grand && styles.grand].filter(Boolean).join(' ');
  return (
    <td role="gridcell" data-r={p.r} data-c={p.c} aria-readonly="true" aria-describedby={p.whyId} tabIndex={p.isActive ? 0 : -1} className={className}>
      <span className={styles.value}>{p.value.toFixed(2)}</span>
      {p.srExtra && <span className={styles.srOnly}>{p.srExtra}</span>}
    </td>
  );
});
