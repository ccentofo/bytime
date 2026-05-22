'use client';

import { useState } from 'react';
import { ActionIcon, NumberInput, Text } from '@mantine/core';
import { IconNote } from '@tabler/icons-react';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';

interface HourCellProps {
  chargeCodeId: string;
  dayIndex: number;
}

export function HourCell({ chargeCodeId, dayIndex }: HourCellProps) {
  const { state, dispatch } = useTimesheet();
  const [isEditing, setIsEditing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [localValue, setLocalValue] = useState<number | string>(0);

  const entry = state.entries.find((e) => e.chargeCodeId === chargeCodeId);
  const value = entry ? entry.hours[dayIndex] : 0;

  const noteKey = `${chargeCodeId}-${dayIndex}`;
  const hasNote = Boolean(state.notes[noteKey]);

  const handleClick = () => {
    setLocalValue(value);
    setIsEditing(true);
  };

  const handleBlur = () => {
    const numVal = typeof localValue === 'number' ? localValue : parseFloat(String(localValue)) || 0;
    dispatch({ type: 'SET_HOURS', chargeCodeId, dayIndex, value: numVal });
    setIsEditing(false);
  };

  const handleNoteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'OPEN_NOTE_MODAL', chargeCodeId, dayIndex });
  };

  const showNoteIcon = isHovered || hasNote;

  return (
    <div
      style={{ position: 'relative', width: '100%', minHeight: 32 }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleClick}
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
