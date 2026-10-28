'use client';

import { memo } from 'react';
import { CLOSED_TO_NEW_HOURS } from '@/lib/timesheet/copy';
import { RH } from '@/lib/timesheet/grid-positions';
import styles from '../Timesheet.module.css';

export interface RowHeaderCellProps {
  gridId: string;
  rowKey: string;
  r: number | 'foot';
  code: string;
  name: string;
  closed: boolean;
  isActive: boolean;
}

/** A row header (§4.2): the code and the row's name (rowName), plus "Closed to new hours" on a correction-only row. */
export const RowHeaderCell = memo(function RowHeaderCell(p: RowHeaderCellProps) {
  return (
    <th scope="row" id={`${p.gridId}-rh-${p.rowKey}`} data-r={p.r} data-c={RH} tabIndex={p.isActive ? 0 : -1} className={[styles.cell, styles.rowHeader].join(' ')}>
      {p.code && <span className={styles.code}>{p.code}</span>} <span className={styles.name}>{p.name}</span>
      {p.closed && <span className={styles.closedNote}> {CLOSED_TO_NEW_HOURS}</span>}
    </th>
  );
});
