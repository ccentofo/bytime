'use client';

import type { ChangeEvent, FocusEvent } from 'react';
import styles from '../Timesheet.module.css';

export interface CellEditorProps {
  gridId: string;
  rowKey: string;
  d: number;
  draft: string;
  invalid: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onBlur: (e: FocusEvent<HTMLInputElement>) => void;
}

/**
 * The one editing input (feature-plan-ux-timesheet-ui.md §4.3), rendered only inside the active cell. A plain text input
 * (never NumberInput, trap T-A). Its name is the row header plus the day's hidden name span; while invalid it points at
 * the visible error. Keys are handled by the grid's delegated onKeyDown.
 */
export function CellEditor(p: CellEditorProps) {
  return (
    <input
      data-cell-editor=""
      className={styles.editor}
      type="text"
      inputMode="decimal"
      enterKeyHint="done"
      autoComplete="off"
      aria-labelledby={`${p.gridId}-rh-${p.rowKey} ${p.gridId}-chn-${p.d}`}
      aria-invalid={p.invalid ? 'true' : undefined}
      aria-describedby={p.invalid ? `${p.gridId}-err` : undefined}
      value={p.draft}
      onChange={p.onChange}
      onBlur={p.onBlur}
    />
  );
}
