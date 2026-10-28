'use client';

import { useState } from 'react';
import { ActionIcon, NumberInput, Text, Tooltip } from '@mantine/core';
import { IconNote } from '@tabler/icons-react';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import { addDays, isAfter } from '@/lib/calendar-date';
import { isCellEditable } from '@/lib/timesheet/cell-rules';
import type { Density } from '../BiWeeklyTable';

interface HourCellProps {
  chargeCodeId: string;
  dayIndex: number;
  density?: Density;
}

function formatHours(value: number, density: Density): string {
  if (value === 0) return '—';
  if (density === 'dense') {
    // Integers plain, fractions compact (no trailing zeros)
    if (value === Math.floor(value)) return String(Math.floor(value));
    // Show minimal decimals: 8.5 not 8.50, 8.25 as 8.25
    return value % 0.5 === 0 ? value.toFixed(1) : value.toFixed(2);
  }
  return value.toFixed(2);
}

export function HourCell({ chargeCodeId, dayIndex, density = 'comfortable' }: HourCellProps) {
  const { state, dispatch } = useTimesheet();
  // Read-only while another period is loading: typing into the outgoing grid would save it
  // against whichever period ends up on screen.
  const periodEditable = (state.periodStatus === 'draft' || state.periodStatus === 'rejected') && !state.isLoadingPeriod && !state.readOnly;
  const [isEditing, setIsEditing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [localValue, setLocalValue] = useState<number | string>(0);

  const entry = state.entries.find((e) => e.chargeCodeId === chargeCodeId);
  const value = entry ? ((entry.hours ?? [])[dayIndex] ?? 0) : 0;

  const savedEntry = state.savedEntries.find((e) => e.chargeCodeId === chargeCodeId);
  const savedValue = savedEntry ? ((savedEntry.hours ?? [])[dayIndex] ?? 0) : 0;
  const isDirty = value !== savedValue;

  const cellDate = addDays(state.periodStart, dayIndex);
  // Uses the server's state.today (never the browser's clock) — the server remains authoritative.
  const isFutureDate = isAfter(cellDate, state.today);
  // certified-outputs C4 (CO-D8, rulings Q1/Q4): a day with a prior revision is correctable on any row; an empty day only
  // on an assignable row (never on a legacy CLIN row). The server applies the same rule.
  const row = state.chargeCodes.find((cc) => cc.id === chargeCodeId);
  const priorRevision = state.savedCellRevisions[`${chargeCodeId}-${dayIndex}`] ?? 0;
  const isEditable = isCellEditable({ periodEditable, isFutureDate, assignable: row?.assignable ?? true, priorRevision });
  const lockedForNewHours = periodEditable && !isFutureDate && !isEditable;
  // C1 display: an imported latest revision is labelled (never shown as if the employee typed it).
  const provenance = entry?.provenance?.[dayIndex] ?? null;

  const noteKey = `${chargeCodeId}-${dayIndex}`;
  // UX-3 A4.9: a cleared ('') note shows no icon.
  const hasNote = Boolean(state.notes[noteKey]?.trim());
  const cellId = `cell-${chargeCodeId}-${dayIndex}`;

  const handleClick = () => {
    if (!isEditable) return;
    setLocalValue(value);
    setIsEditing(true);
    requestAnimationFrame(() => {
      const input = document.getElementById(cellId)?.querySelector('input');
      if (input) { input.focus(); input.select(); }
    });
  };

  const handleBlur = () => {
    const numVal = typeof localValue === 'number' ? localValue : parseFloat(String(localValue)) || 0;
    dispatch({ type: 'SET_HOURS', chargeCodeId, dayIndex, value: numVal });
    setIsEditing(false);
  };

  const handleNoteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // UX-3 A4.9: read-only on a cell whose note can't change (locked period, future date, read-only mode).
    dispatch({ type: 'OPEN_NOTE_MODAL', chargeCodeId, dayIndex, editable: periodEditable && !isFutureDate });
  };

  const showNoteIcon = isHovered || hasNote;
  const isDense = density === 'dense';
  const minHeight = isDense ? 24 : 32;
  const fontSize = isDense ? 10 : undefined;

  return (
    <div
      id={cellId}
      style={{
        position: 'relative',
        width: '100%',
        minHeight,
        backgroundColor: isDirty
          ? 'light-dark(var(--mantine-color-warning-0), var(--mantine-color-warning-9))'
          : undefined,
        borderRadius: isDirty ? 2 : undefined,
        cursor: isEditable ? 'text' : 'default',
        opacity: isFutureDate ? 0.4 : 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleClick}
      title={isFutureDate ? 'Cannot enter hours for future dates' : lockedForNewHours ? 'Closed to new hours — you can correct existing hours' : undefined}
    >
      {provenance && (
        <Tooltip label={provenance} multiline maw={320} withArrow>
          <span
            aria-label={provenance}
            data-testid="imported-indicator"
            style={{ position: 'absolute', top: 2, left: 2, width: 6, height: 6, borderRadius: 3, background: 'var(--mantine-color-signal-6)' }}
          />
        </Tooltip>
      )}
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
          style={{ width: isDense ? 36 : 52, textAlign: 'center' }}
          styles={{
            input: {
              textAlign: 'center',
              padding: 0,
              fontSize: isDense ? 10 : undefined,
              color: 'var(--mantine-color-text)',
              fontVariantNumeric: 'tabular-nums',
            },
          }}
          autoFocus
          onFocus={(e) => e.target.select()}
          onBlur={handleBlur}
          onChange={(val) => setLocalValue(val)}
        />
      ) : (
        <Text
          ta="center"
          size={isDense ? 'xs' : 'sm'}
          style={{
            lineHeight: `${minHeight}px`,
            fontSize,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatHours(value, density)}
        </Text>
      )}

      {showNoteIcon && !isDense && (
        <ActionIcon
          variant="subtle"
          size="xs"
          color={hasNote ? 'signal' : 'gray'}
          style={{ position: 'absolute', top: 0, right: 0 }}
          onClick={handleNoteClick}
          aria-label="Add note"
        >
          <IconNote size={12} />
        </ActionIcon>
      )}
      {showNoteIcon && isDense && hasNote && (
        <div
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            width: 4,
            height: 4,
            borderRadius: '50%',
            backgroundColor: 'var(--mantine-color-signal-5)',
          }}
          aria-label="Has note"
        />
      )}
    </div>
  );
}
