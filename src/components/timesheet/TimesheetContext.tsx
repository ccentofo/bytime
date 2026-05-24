'use client';

import React, { createContext, useContext, useReducer, useCallback, useMemo } from 'react';
import dayjs from 'dayjs';
import type { TimesheetState, TimesheetAction, TimesheetPageData, DirtyCell } from '@/types/timesheet';
import { navigatePeriod, getNumDaysInPeriod } from '@/lib/date-utils';
import { getTimesheetEntries, saveTimesheetBatch, getRevisionMap } from '@/server/actions/timesheet';
import { submitPeriod, getPeriodStatus } from '@/server/actions/periods';
import { seedOfflineStore, getOfflineEntries, getOfflineRevisions } from '@/lib/offline/offline-store';

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
      const newPeriodStart = navigatePeriod(state.periodStart, action.direction);
      const emptyEntries = state.chargeCodes.map((cc) => ({
        chargeCodeId: cc.id,
        hours: [] as number[],
      }));
      return {
        ...state,
        periodStart: newPeriodStart,
        entries: emptyEntries,
        savedEntries: emptyEntries,
        savedCellRevisions: {},
        notes: {},
        periodStatus: 'draft',
        isLoadingPeriod: true,
      };
    }

    case 'SET_PERIOD_DATA': {
      return {
        ...state,
        periodStart: action.periodStart,
        entries: action.entries,
        savedEntries: action.entries.map((e) => ({ ...e, hours: [...e.hours] })),
        savedCellRevisions: action.revisions,
        periodStatus: action.periodStatus ?? state.periodStatus,
        isLoadingPeriod: false,
      };
    }

    case 'SET_SAVING': {
      return { ...state, isSaving: action.isSaving };
    }

    case 'MARK_SAVED': {
      return {
        ...state,
        savedEntries: action.entries.map((e) => ({ ...e, hours: [...e.hours] })),
        savedCellRevisions: { ...state.savedCellRevisions, ...action.revisions },
        isSaving: false,
      };
    }

    case 'DISCARD_CHANGES': {
      return {
        ...state,
        entries: state.savedEntries.map((e) => ({ ...e, hours: [...e.hours] })),
      };
    }

    case 'SET_PERIOD_STATUS': {
      return { ...state, periodStatus: action.status };
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
  dirtyCells: DirtyCell[];
  hasEdits: boolean;        // true if any dirty cell has a prior revision (isEdit=true)
  hasLateEntries: boolean;  // true if any dirty cell is a late first-time entry
  saveAll: (changeReasonCode?: string, comment?: string) => Promise<void>;
  loadPeriod: (direction: 'prev' | 'next') => Promise<void>;
  discardChanges: () => void;
  submitTimesheet: (comment?: string) => Promise<void>;
}

const TimesheetContext = createContext<TimesheetContextValue | undefined>(
  undefined
);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type ProviderProps = {
  initialData: TimesheetPageData;
  children: React.ReactNode;
};

export function TimesheetProvider({ initialData, children }: ProviderProps) {
  const initialState: TimesheetState = {
    chargeCodes: initialData.chargeCodes,
    entries: initialData.entries,
    savedEntries: initialData.entries.map((e) => ({ ...e, hours: [...e.hours] })),
    savedCellRevisions: initialData.revisions ?? {},
    notes: {},
    periodStart: new Date(initialData.periodStart),
    activeNoteCell: null,
    userId: initialData.userId,
    isSaving: false,
    isLoadingPeriod: false,
    periodStatus: initialData.periodStatus ?? 'draft',
  };

  const [state, dispatch] = useReducer(timesheetReducer, initialState);

  // Compute dirty cells by comparing entries to savedEntries
  const dirtyCells = useMemo<DirtyCell[]>(() => {
    const dirty: DirtyCell[] = [];
    const today = dayjs().startOf('day');
    for (const entry of state.entries) {
      const savedEntry = state.savedEntries.find((se) => se.chargeCodeId === entry.chargeCodeId);
      if (!savedEntry) continue;
      for (let i = 0; i < entry.hours.length; i++) {
        const current = entry.hours[i] ?? 0;
        const saved = savedEntry.hours[i] ?? 0;
        if (current !== saved) {
          const key = `${entry.chargeCodeId}-${i}`;
          const revisionNumber = state.savedCellRevisions[key] ?? 0;
          const cellDate = dayjs(state.periodStart).add(i, 'day').startOf('day');
          const isEdit = revisionNumber > 0;
          // Late entry: first-time entry (no prior revision) on a date that has already passed
          const isLateEntry = !isEdit && saved === 0 && current > 0 && cellDate.isBefore(today, 'day');
          dirty.push({
            chargeCodeId: entry.chargeCodeId,
            dayIndex: i,
            hours: current,
            isEdit,
            isLateEntry,
          });
        }
      }
    }
    return dirty;
  }, [state.entries, state.savedEntries, state.savedCellRevisions, state.periodStart]);

  // Are any dirty cells edits to previously-saved data?
  const hasEdits = useMemo(() => dirtyCells.some((c) => c.isEdit), [dirtyCells]);
  const hasLateEntries = useMemo(() => dirtyCells.some((c) => c.isLateEntry), [dirtyCells]);

  const saveAll = useCallback(
    async (changeReasonCode?: string, comment?: string) => {
      if (dirtyCells.length === 0) return;

      try {
        dispatch({ type: 'SET_SAVING', isSaving: true });

        const newRevisions = await saveTimesheetBatch({
          userId: state.userId,
          periodStart: state.periodStart,
          cells: dirtyCells.map((c) => ({
            clinId: c.chargeCodeId,
            dayIndex: c.dayIndex,
            hours: c.hours,
            isEdit: c.isEdit,
            isLateEntry: c.isLateEntry,
          })),
          changeReasonCode,
          comment,
        });

        // After successful save, update saved snapshot
        dispatch({
          type: 'MARK_SAVED',
          entries: state.entries,
          revisions: newRevisions,
        });
      } catch (error) {
        console.error('Failed to save timesheet:', error);
        dispatch({ type: 'SET_SAVING', isSaving: false });
        throw error; // Re-throw so the UI can show error notification
      }
    },
    [dirtyCells, state.userId, state.periodStart, state.entries]
  );

  const loadPeriod = useCallback(
    async (direction: 'prev' | 'next') => {
      dispatch({ type: 'NAVIGATE_PERIOD', direction });

      const newPeriodStart = navigatePeriod(state.periodStart, direction);
      const numDays = getNumDaysInPeriod(newPeriodStart);

      try {
        // Try server first
        const entries = await getTimesheetEntries(state.userId, newPeriodStart, state.chargeCodes);
        const revisions = await getRevisionMap(state.userId, newPeriodStart, numDays);
        const periodInfo = await getPeriodStatus(state.userId, newPeriodStart);

        // Seed offline store with fresh data
        await seedOfflineStore({
          userId: state.userId,
          periodStart: newPeriodStart,
          chargeCodes: state.chargeCodes,
          entries,
          revisions,
          periodStatus: periodInfo.status,
        });

        dispatch({
          type: 'SET_PERIOD_DATA',
          periodStart: newPeriodStart,
          entries,
          revisions,
          periodStatus: periodInfo.status,
        });
      } catch (error) {
        console.warn('Server unavailable, loading from offline store:', error);

        // Fall back to offline store
        const offlineEntries = await getOfflineEntries(newPeriodStart, state.chargeCodes);
        const offlineRevisions = await getOfflineRevisions(newPeriodStart);

        dispatch({
          type: 'SET_PERIOD_DATA',
          periodStart: newPeriodStart,
          entries: offlineEntries,
          revisions: offlineRevisions,
        });
      }
    },
    [state.periodStart, state.userId, state.chargeCodes]
  );

  const discardChanges = useCallback(() => {
    dispatch({ type: 'DISCARD_CHANGES' });
  }, []);

  const submitTimesheet = useCallback(
    async (comment?: string) => {
      try {
        dispatch({ type: 'SET_SAVING', isSaving: true });
        await submitPeriod({
          userId: state.userId,
          periodStart: state.periodStart,
          comment,
        });
        dispatch({ type: 'SET_PERIOD_STATUS', status: 'submitted' });
      } catch (error) {
        console.error('Failed to submit timesheet:', error);
        throw error;
      } finally {
        dispatch({ type: 'SET_SAVING', isSaving: false });
      }
    },
    [state.userId, state.periodStart]
  );

  return (
    <TimesheetContext.Provider
      value={{ state, dispatch, dirtyCells, hasEdits, hasLateEntries, saveAll, loadPeriod, discardChanges, submitTimesheet }}
    >
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
