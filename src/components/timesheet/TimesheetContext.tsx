'use client';

import React, { createContext, useContext, useReducer, useCallback, useMemo } from 'react';
import dayjs from 'dayjs';
import type { TimesheetState, TimesheetAction, TimesheetPageData, DirtyCell } from '@/types/timesheet';
import { navigatePeriod, getNumDaysInPeriod, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { getTimesheetEntries, saveTimesheetBatch, getRevisionMap } from '@/server/actions/timesheet';
import { submitPeriod, getPeriodStatus } from '@/server/actions/periods';
import { getNeighborPeriod, getEffectiveConfigAt } from '@/server/actions/pay-period-config';
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
        periodConfig: action.periodConfig ?? state.periodConfig,
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
  loadPeriodByDate: (periodStart: Date) => Promise<void>;
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
    flsaExempt: initialData.flsaExempt ?? false,
    periodConfig: initialData.periodConfig ?? DEFAULT_PERIOD_CONFIG,
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
          periodStart: state.periodStart,
          cells: dirtyCells.map((c) => {
            const chargeCode = state.chargeCodes.find((cc) => cc.id === c.chargeCodeId);
            const revisionKey = `${c.chargeCodeId}-${c.dayIndex}`;
            return {
              // Direct entries: send chargeCodeId; server denormalizes clinId/slinId from the charge code.
              // Indirect entries: send indirectCodeId as before.
              chargeCodeId: chargeCode?.isIndirect ? undefined : c.chargeCodeId,
              indirectCodeId: chargeCode?.isIndirect ? c.chargeCodeId : undefined,
              dayIndex: c.dayIndex,
              hours: c.hours,
              isEdit: c.isEdit,
              isLateEntry: c.isLateEntry,
              expectedRevision: state.savedCellRevisions[revisionKey] ?? 0,
            };
          }),
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

      try {
        // Server resolves the neighbor period start + the config effective there,
        // handling schedule changes correctly (two-sided snap).
        const neighbor = await getNeighborPeriod(state.periodStart, direction);
        const { periodStart: newPeriodStart, periodConfig: neighborConfig, numDays } = neighbor;

        // Parallel fetch — all 3 queries at once instead of sequential
        const [entries, revisions, periodInfo] = await Promise.all([
          getTimesheetEntries(newPeriodStart, state.chargeCodes),
          getRevisionMap(newPeriodStart, numDays),
          getPeriodStatus(newPeriodStart),
        ]);

        // Fire-and-forget offline seeding — wrapped in try/catch to prevent IndexedDB errors from crashing the app
        try {
          seedOfflineStore({
            userId: state.userId,
            periodStart: newPeriodStart,
            chargeCodes: state.chargeCodes,
            entries,
            revisions,
            periodStatus: periodInfo.status,
          });
        } catch {
          // IndexedDB unavailable or corrupted — app continues without offline support
        }

        dispatch({
          type: 'SET_PERIOD_DATA',
          periodStart: newPeriodStart,
          entries,
          revisions,
          periodStatus: periodInfo.status,
          periodConfig: neighborConfig,
        });
      } catch (error) {
        console.warn('Server unavailable, loading from offline store:', error);

        // Fall back to offline store using current config as best-effort
        const { periodStart: newPeriodStart } = await getNeighborPeriod(state.periodStart, direction).catch(() => ({
          periodStart: state.periodStart,
          periodConfig: state.periodConfig,
          numDays: getNumDaysInPeriod(state.periodStart, state.periodConfig),
        }));
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
    [state.periodStart, state.userId, state.chargeCodes, state.periodConfig]
  );

  const loadPeriodByDate = useCallback(
    async (newPeriodStart: Date) => {
      // Dispatch a navigate action to show loading state
      dispatch({ type: 'NAVIGATE_PERIOD', direction: 'next' }); // Direction doesn't matter — we override below

      // Resolve the schedule effective at the TARGET period (not the one we're leaving),
      // so jumping across a pay-schedule change renders the correct period shape.
      const periodConfig = await getEffectiveConfigAt(newPeriodStart);
      const numDays = getNumDaysInPeriod(newPeriodStart, periodConfig);

      try {
        const [entries, revisions, periodInfo] = await Promise.all([
          getTimesheetEntries(newPeriodStart, state.chargeCodes),
          getRevisionMap(newPeriodStart, numDays),
          getPeriodStatus(newPeriodStart),
        ]);

        // Fire-and-forget offline seeding — wrapped in try/catch to prevent IndexedDB errors from crashing the app
        try {
          seedOfflineStore({
            userId: state.userId,
            periodStart: newPeriodStart,
            chargeCodes: state.chargeCodes,
            entries,
            revisions,
            periodStatus: periodInfo.status,
          });
        } catch {
          // IndexedDB unavailable or corrupted — app continues without offline support
        }

        dispatch({
          type: 'SET_PERIOD_DATA',
          periodStart: newPeriodStart,
          entries,
          revisions,
          periodStatus: periodInfo.status,
          periodConfig,
        });
      } catch (error) {
        console.warn('Server unavailable, loading from offline store:', error);
        const offlineEntries = await getOfflineEntries(newPeriodStart, state.chargeCodes);
        const offlineRevisions = await getOfflineRevisions(newPeriodStart);
        dispatch({
          type: 'SET_PERIOD_DATA',
          periodStart: newPeriodStart,
          entries: offlineEntries,
          revisions: offlineRevisions,
          periodConfig,
        });
      }
    },
    [state.userId, state.chargeCodes]
  );

  const discardChanges = useCallback(() => {
    dispatch({ type: 'DISCARD_CHANGES' });
  }, []);

  const submitTimesheet = useCallback(
    async (comment?: string) => {
      try {
        dispatch({ type: 'SET_SAVING', isSaving: true });
        await submitPeriod({
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
      value={{ state, dispatch, dirtyCells, hasEdits, hasLateEntries, saveAll, loadPeriod, loadPeriodByDate, discardChanges, submitTimesheet }}
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
