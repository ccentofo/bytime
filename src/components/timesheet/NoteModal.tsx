'use client';

import { createContext, useContext, useState, type RefObject } from 'react';
import { Button, Group, Modal, Text, Textarea } from '@mantine/core';
import { useTimesheetDispatch, useTimesheetState } from '@/components/timesheet/TimesheetContext';
import { addDays, formatCalendarDate } from '@/lib/calendar-date';
import { rowLabel } from '@/lib/timesheet/labels';

/** A note's maximum length (the server enforces it too, Part A). */
export const NOTE_MAX_LENGTH = 1000;
export const NOTE_HINT = 'Your note is saved when you save your timesheet.';

/** The grid's imperative handle: NoteModal returns focus to the active cell through it (§4.3, §4.8, trap T-J). */
export interface GridHandle { focusActive: () => void }
export const GridRefContext = createContext<RefObject<GridHandle | null> | null>(null);
export function useGridRef(): RefObject<GridHandle | null> | null {
  return useContext(GridRefContext);
}

/**
 * The note editor (feature-plan-ux-timesheet-ui.md §4.8), replacing DailyNoteModal. Always mounted: it toggles `opened`
 * and keeps the last cell while the exit transition runs. A note is text only (no reason code — L3). Done only updates
 * the working copy — it joins the unsaved count and the timesheet's Save sends it — so no button here says "Save".
 * Read-only (Close only) when the note isn't editable. Focus goes back to the grid's active cell after the exit
 * transition (returnFocus off), whichever control opened it.
 */
export function NoteModal() {
  const { state } = useTimesheetState();
  const dispatch = useTimesheetDispatch();
  const gridRef = useGridRef();
  const cell = state.activeNoteCell;

  // The cell shown, kept through the exit transition; the draft resets whenever a new cell opens (render-time sync).
  const [shown, setShown] = useState(cell);
  const [body, setBody] = useState('');
  if (cell && cell !== shown) {
    setShown(cell);
    setBody(state.notes[`${cell.chargeCodeId}-${cell.dayIndex}`] ?? '');
  }

  const row = shown ? state.chargeCodes.find((cc) => cc.id === shown.chargeCodeId) : undefined;
  const date = shown ? addDays(state.periodStart, shown.dayIndex) : null;
  const editable = shown?.editable ?? false;
  const title = row && date ? `Note — ${rowLabel(row)} — ${formatCalendarDate(date, 'ddd, MMM D')}` : 'Note';

  const close = () => dispatch({ type: 'CLOSE_NOTE_MODAL' });
  const write = (next: string) => {
    if (!shown || !editable) return;
    dispatch({ type: 'SET_NOTE', chargeCodeId: shown.chargeCodeId, dayIndex: shown.dayIndex, body: next });
    close();
  };

  return (
    <Modal
      opened={cell !== null}
      onClose={close}
      title={title}
      centered
      returnFocus={false}
      onExitTransitionEnd={() => gridRef?.current?.focusActive()}
    >
      <Textarea
        label="Note"
        description={NOTE_HINT}
        data-autofocus
        rows={4}
        maxLength={NOTE_MAX_LENGTH}
        value={body}
        readOnly={!editable}
        onChange={(e) => setBody(e.currentTarget.value)}
      />
      {/* A counter, deliberately not a live region (§4.5). */}
      <Text size="sm" c="dimmed" ta="end" mt={4} data-testid="note-counter">{body.length}/{NOTE_MAX_LENGTH}</Text>
      {editable ? (
        <Group justify="space-between" mt="md">
          <Button variant="subtle" color="red" onClick={() => write('')}>Remove note</Button>
          <Group gap="sm">
            <Button variant="default" onClick={close}>Cancel</Button>
            <Button onClick={() => write(body)}>Done</Button>
          </Group>
        </Group>
      ) : (
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={close}>Close</Button>
        </Group>
      )}
    </Modal>
  );
}
