'use client';

import { useState, useEffect } from 'react';
import { Button, Group, Modal, Select, Textarea } from '@mantine/core';
import dayjs from 'dayjs';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import { REASON_CODES } from '@/data/mock-timesheet';

export function DailyNoteModal() {
  const { state, dispatch } = useTimesheet();
  const { activeNoteCell, chargeCodes, notes, periodStart } = state;

  const isOpen = activeNoteCell !== null;

  // Derive existing note data for pre-population
  const noteKey = activeNoteCell
    ? `${activeNoteCell.chargeCodeId}-${activeNoteCell.dayIndex}`
    : '';
  const existingNote = noteKey ? notes[noteKey] : undefined;

  const [comment, setComment] = useState('');
  const [reasonCode, setReasonCode] = useState<string | null>(null);

  // Pre-populate form when modal opens
  useEffect(() => {
    if (isOpen && existingNote) {
      setComment(existingNote.comment);
      setReasonCode(existingNote.reasonCode);
    } else if (isOpen) {
      setComment('');
      setReasonCode(null);
    }
  }, [isOpen, noteKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = () => {
    dispatch({ type: 'CLOSE_NOTE_MODAL' });
  };

  const handleSave = () => {
    if (!activeNoteCell) return;
    dispatch({
      type: 'SET_NOTE',
      chargeCodeId: activeNoteCell.chargeCodeId,
      dayIndex: activeNoteCell.dayIndex,
      note: { comment, reasonCode: reasonCode ?? '' },
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
        label="Comments"
        placeholder="Describe the reason for this entry or correction..."
        minRows={3}
        value={comment}
        onChange={(e) => setComment(e.currentTarget.value)}
        mb="sm"
      />
      <Select
        label="Reason for Change"
        data={REASON_CODES}
        placeholder="Select a reason code..."
        value={reasonCode}
        onChange={setReasonCode}
        mb="md"
      />
      <Group justify="flex-end" mt="md">
        <Button onClick={handleSave}>Save Note</Button>
      </Group>
    </Modal>
  );
}
