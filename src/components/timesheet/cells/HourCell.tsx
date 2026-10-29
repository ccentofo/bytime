'use client';

import { memo, useContext, type ReactNode } from 'react';
import { Icons } from '@/components/ui/icons';
import { RenderProbeContext } from '@/components/timesheet/RenderProbe';
import styles from '../Timesheet.module.css';

export interface HourCellProps {
  r: number;
  c: number;
  rowKey: string;
  gridId: string;
  value: number;
  savedValue: number;
  editable: boolean;
  /** The hidden description of why the cell is read-only (future / closed / locked / read-only workspace), if any. */
  whyId: string | null;
  hasNote: boolean;
  /**
   * v5.2 (§14.4): the note can be opened from this cell — it's editable here (§4.8) or it exists (read-only view). The
   * trigger renders whenever this is true; CSS shows it for a note, the active cell or the pointer (no hover state here).
   */
  noteViewable: boolean;
  /** The hidden provenance description of an imported latest revision, if any. */
  provenanceId: string | null;
  isActive: boolean;
  unsaved: boolean;
  /** The CellEditor element, only for the cell being edited. */
  editor: ReactNode | null;
  future: boolean;
  weekend: boolean;
  today: boolean;
  /** Closed to new hours and empty: hatch + lock glyph. */
  closedEmpty: boolean;
}

/**
 * One day cell (feature-plan-ux-timesheet-ui.md §4.2, §4.6, §14). Memoized on plain props, so committing one cell
 * re-renders only that cell (§7). Hours always show 2 decimals; an empty cell has no text. Never aria-disabled. The note
 * trigger is an aria-hidden span, never focusable: the grid keeps its one tab stop, and N is the keyboard way (§14.4).
 */
export const HourCell = memo(function HourCell(p: HourCellProps) {
  useContext(RenderProbeContext)?.('cell', `${p.r}:${p.c}`);
  const describedBy = [p.whyId, p.provenanceId].filter(Boolean).join(' ') || undefined;
  const className = [
    styles.cell, styles.day,
    p.unsaved && styles.unsaved, p.future && styles.future, p.weekend && styles.weekend, p.today && styles.todayCol,
    p.closedEmpty && styles.closed, p.editable && styles.editable, p.hasNote && styles.hasNote,
  ].filter(Boolean).join(' ');
  return (
    <td
      role="gridcell"
      data-r={p.r}
      data-c={p.c}
      // While editing, focus lives in the input; the td leaves the tab order so Shift+Tab can't land on it.
      tabIndex={p.isActive && !p.editor ? 0 : -1}
      aria-readonly={p.editable ? undefined : 'true'}
      aria-describedby={describedBy}
      data-active={p.isActive || undefined}
      className={className}
    >
      {p.editor ?? <span className={styles.value}>{p.value === 0 ? '' : p.value.toFixed(2)}</span>}
      {p.noteViewable && (
        <span className={styles.noteTrigger} data-note-trigger aria-hidden="true" title={p.hasNote ? 'Edit note' : 'Add note'}>
          <Icons.note size={14} />
        </span>
      )}
      <span className={styles.glyphs} aria-hidden="true">
        {p.provenanceId && <Icons.import size={12} />}
        {p.closedEmpty && p.value === 0 && <Icons.lock size={12} />}
      </span>
      <span className={styles.srOnly}>{p.unsaved ? ', unsaved' : ''}{p.hasNote ? ', note' : ''}{p.provenanceId ? ', imported' : ''}</span>
    </td>
  );
});
