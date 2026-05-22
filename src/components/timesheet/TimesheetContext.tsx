'use client';

import React, { createContext, useContext, useReducer } from 'react';
import dayjs from 'dayjs';
import type { TimesheetState, TimesheetAction } from '@/types/timesheet';
import {
  MOCK_CHARGE_CODES,
  MOCK_ENTRIES,
  MOCK_PERIOD_START,
  generateMockEntries,
} from '@/data/mock-timesheet';

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function timesheetReducer(
  state: TimesheetState,
  action: TimesheetAction
): TimesheetState {
  switch (action.type) {
    case 'SET_HOURS': {
      const updatedEntries = state.entries.map((entry) => {
        if (entry.chargeCodeId !== action.chargeCodeId) return entry;
        const newHours = [...entry.hours];
        newHours[action.dayIndex] = action.value;
        return { ...entry, hours: newHours };
      });
      return { ...state, entries: updatedEntries };
    }

    case 'SET_NOTE': {
      const key = `${action.chargeCodeId}-${action.dayIndex}`;
      return {
        ...state,
        notes: { ...state.notes, [key]: action.note },
      };
    }

    case 'OPEN_NOTE_MODAL': {
      return {
        ...state,
        activeNoteCell: {
          chargeCodeId: action.chargeCodeId,
          dayIndex: action.dayIndex,
        },
      };
    }

    case 'CLOSE_NOTE_MODAL': {
      return { ...state, activeNoteCell: null };
    }

    case 'NAVIGATE_PERIOD': {
      const current = dayjs(state.periodStart);
      let newStart: dayjs.Dayjs;

      if (action.direction === 'next') {
        if (current.date() === 1) {
          // 1st → 16th of same month
          newStart = current.date(16);
        } else {
          // 16th → 1st of next month
          newStart = current.add(1, 'month').date(1);
        }
      } else {
        if (current.date() === 1) {
          // 1st → 16th of previous month
          newStart = current.subtract(1, 'month').date(16);
        } else {
          // 16th → 1st of same month
          newStart = current.date(1);
        }
      }

      const newPeriodStart = newStart.toDate();
      return {
        ...state,
        periodStart: newPeriodStart,
        entries: generateMockEntries(newPeriodStart),
        notes: {}, // clear notes when switching periods (mock behavior)
      };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface TimesheetContextValue {
  state: TimesheetState;
  dispatch: React.Dispatch<TimesheetAction>;
}

const TimesheetContext = createContext<TimesheetContextValue | undefined>(
  undefined
);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const initialState: TimesheetState = {
  chargeCodes: MOCK_CHARGE_CODES,
  entries: MOCK_ENTRIES,
  notes: {},
  periodStart: MOCK_PERIOD_START,
  activeNoteCell: null,
};

export function TimesheetProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(timesheetReducer, initialState);

  return (
    <TimesheetContext.Provider value={{ state, dispatch }}>
      {children}
    </TimesheetContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Custom hook
// ---------------------------------------------------------------------------

export function useTimesheet(): TimesheetContextValue {
  const ctx = useContext(TimesheetContext);
  if (!ctx) {
    throw new Error('useTimesheet must be used within a <TimesheetProvider>');
  }
  return ctx;
}
