'use client';

import { useState, useEffect } from 'react';
import { Button, Group, Modal, Text, Textarea } from '@mantine/core';
import dayjs from 'dayjs';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';

/** feature-plan-ux-timesheet.md A4.2: a note's maximum length (the server enforces it too). */
const NOTE_MAX_LENGTH = 1000;

/**
 * The old grid's note editor (UX-3 A4.9, until Part B's NoteModal). A note is text only — no reason code (L3); every
 * change is kept as a revision on the server and notes lock with the period. Saving here only updates the working copy;
 * the timesheet's Save sends it. Read-only on a cell that isn't editable (locked period, future date, read-only mode).
 */
export function DailyNoteModal() {
  const { state, dispatch } = useTimesheet();
  const { activeNoteCell, chargeCodes, notes, periodStart } = state;

  const isOpen = activeNoteCell !== null;
  const editable = activeNoteCell?.editable ?? false;

  const noteKey = activeNoteCell
    ? `${activeNoteCell.chargeCodeId}-${activeNoteCell.dayIndex}`
    : '';
  const existingBody = noteKey ? notes[noteKey] ?? '' : '';

  const [body, setBody] = useState('');

  // Pre-populate when the modal opens
  useEffect(() => {
    if (isOpen) setBody(existingBody);
  }, [isOpen, noteKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = () => {
    dispatch({ type: 'CLOSE_NOTE_MODAL' });
  };

  const handleSave = () => {
    if (!activeNoteCell || !editable) return;
    dispatch({
      type: 'SET_NOTE',
      chargeCodeId: activeNoteCell.chargeCodeId,
      dayIndex: activeNoteCell.dayIndex,
      body,
    });
    dispatch({ type: 'CLOSE_NOTE_MODAL' });
  };

  // Build modal title
  let title = 'Daily Note';
  if (activeNoteCell) {
    const chargeCode = chargeCodes.find(
      (cc) => cc.id === activeNoteCell.chargeCodeId
    );
    const cellDate = dayjs(periodStart).add(activeNoteCell.dayIndex, 'day');
    title = `Daily Note — ${chargeCode?.projectName ?? ''} — ${cellDate.format('MMM D, YYYY')}`;
  }

  return (
    <Modal
      opened={isOpen}
      onClose={handleClose}
      title={title}
      centered
    >
      <Textarea
        label="Note"
        placeholder="Describe the work, or the reason for this entry or correction..."
        minRows={3}
        maxLength={NOTE_MAX_LENGTH}
        value={body}
        readOnly={!editable}
        onChange={(e) => setBody(e.currentTarget.value)}
        mb="sm"
      />
      {editable ? (
        <Group justify="flex-end" mt="md">
          <Button onClick={handleSave}>Save Note</Button>
        </Group>
      ) : (
        <Text size="sm" c="dimmed">This note can&apos;t be changed here.</Text>
      )}
    </Modal>
  );
}
