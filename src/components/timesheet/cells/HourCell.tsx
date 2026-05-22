'use client';

import { useState } from 'react';
import { ActionIcon, NumberInput, Text } from '@mantine/core';
import { IconNote } from '@tabler/icons-react';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import dayjs from 'dayjs';

interface HourCellProps {
  chargeCodeId: string;
  dayIndex: number;
}

export function HourCell({ chargeCodeId, dayIndex }: HourCellProps) {
  const { state, dispatch } = useTimesheet();
  const isEditable = state.periodStatus === 'draft' || state.periodStatus === 'rejected';
  const [isEditing, setIsEditing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [localValue, setLocalValue] = useState<number | string>(0);

  const entry = state.entries.find((e) => e.chargeCodeId === chargeCodeId);
  const value = entry ? entry.hours[dayIndex] : 0;

  // Check if this cell is dirty (unsaved changes)
  const savedEntry = state.savedEntries.find((e) => e.chargeCodeId === chargeCodeId);
  const savedValue = savedEntry ? (savedEntry.hours[dayIndex] ?? 0) : 0;
  const isDirty = value !== savedValue;

  // Check if this cell is a candidate for late entry (past date, never saved)
  const revisionKey = `${chargeCodeId}-${dayIndex}`;
  const revisionNumber = state.savedCellRevisions[revisionKey] ?? 0;
  const cellDate = dayjs(state.periodStart).add(dayIndex, 'day');
  const isPastDate = cellDate.isBefore(dayjs(), 'day');
  const isLateEntryCandidate = isPastDate && revisionNumber === 0 && savedValue === 0;

  // Future date detection
  const isFutureDate = cellDate.isAfter(dayjs(), 'day');

  const noteKey = `${chargeCodeId}-${dayIndex}`;
  const hasNote = Boolean(state.notes[noteKey]);

  const handleClick = () => {
    if (!isEditable) return; // Period is locked (submitted/approved)
    if (isFutureDate) return; // Cannot enter hours for future dates
    setLocalValue(value);
    setIsEditing(true);
  };

  const handleBlur = () => {
    const numVal = typeof localValue === 'number' ? localValue : parseFloat(String(localValue)) || 0;
    dispatch({ type: 'SET_HOURS', chargeCodeId, dayIndex, value: numVal });
    setIsEditing(false);
    // NO auto-save — user must click the Save button
  };

  const handleNoteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'OPEN_NOTE_MODAL', chargeCodeId, dayIndex });
  };

  const showNoteIcon = isHovered || hasNote;

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        minHeight: 32,
        backgroundColor: isDirty
          ? 'light-dark(var(--mantine-color-yellow-0), var(--mantine-color-yellow-9))'
          : isLateEntryCandidate
            ? 'light-dark(var(--mantine-color-orange-0), var(--mantine-color-orange-9))'
            : undefined,
        borderRadius: (isDirty || isLateEntryCandidate) ? 2 : undefined,
        borderLeft: isLateEntryCandidate ? '3px solid var(--mantine-color-orange-5)' : undefined,
        cursor: isEditable && !isFutureDate ? 'pointer' : 'default',
        opacity: isFutureDate ? 0.4 : isEditable ? 1 : undefined,
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleClick}
      title={isFutureDate ? 'Cannot enter hours for future dates' : undefined}
    >
      {isEditing ? (
        <NumberInput
          value={localValue}
          min={0}
          max={24}
          step={0.25}
          decimalScale={2}
          fixedDecimalScale
          hideControls
          variant="unstyled"
          style={{ width: 60, textAlign: 'center' }}
          styles={{ input: { textAlign: 'center', padding: 0, color: 'var(--mantine-color-text)' } }}
          autoFocus
          onBlur={handleBlur}
          onChange={(val) => setLocalValue(val)}
        />
      ) : (
        <Text ta="center" size="sm" style={{ lineHeight: '32px' }}>
          {value === 0 ? '—' : value.toFixed(2)}
        </Text>
      )}

      {showNoteIcon && (
        <ActionIcon
          variant="subtle"
          size="xs"
          color={hasNote ? 'blue' : 'gray'}
          style={{ position: 'absolute', top: 0, right: 0 }}
          onClick={handleNoteClick}
          aria-label="Add note"
        >
          <IconNote size={12} />
        </ActionIcon>
      )}
    </div>
  );
}
