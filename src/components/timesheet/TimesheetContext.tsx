'use client';

import React, { createContext, useContext, useReducer, useCallback, useMemo, useEffect, useRef } from 'react';
import { notifications } from '@mantine/notifications';
import type { TimesheetState, TimesheetAction, TimesheetPageData, DirtyCell } from '@/types/timesheet';
import { addDays, isBefore, type CalendarDate } from '@/lib/calendar-date';
import { saveTimesheetBatch, getTimesheetPeriod } from '@/server/actions/timesheet';
import { submitPeriod, getWorkspaceContext } from '@/server/actions/periods';
import { runAction, type RunResult } from '@/lib/run-action';
import { getNeighborPeriod } from '@/server/actions/pay-period-config';
import { seedOfflineStore } from '@/lib/offline/offline-store';

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Exported for tests (fix round 1, F8). */
export function timesheetReducer(
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

    case 'BEGIN_PERIOD_LOAD': {
      // Keep showing the current period (read-only while loading) until the server returns the
      // new one. The client never guesses the next period itself.
      return { ...state, isLoadingPeriod: true };
    }

    case 'PERIOD_LOAD_FAILED': {
      return { ...state, isLoadingPeriod: false };
    }

    case 'SET_PERIOD_DATA': {
      return {
        ...state,
        periodStart: action.periodStart,
        numDays: action.numDays,
        entries: action.entries,
        savedEntries: action.entries.map((e) => ({ ...e, hours: [...e.hours] })),
        savedCellRevisions: action.revisions,
        notes: {},
        periodStatus: action.periodStatus,
        approvalBadge: action.approvalBadge ?? null,
        // certified-outputs C4: each period has its own code list (assignable ∪ codes with recorded hours).
        chargeCodes: action.chargeCodes,
        periodConfig: action.periodConfig,
        isLoadingPeriod: false,
      };
    }

    case 'SET_SAVING': {
      return { ...state, isSaving: action.isSaving };
    }

    case 'MARK_SAVED': {
      // A save that finishes after the user moved to another period must not touch that
      // period's baseline: revision keys (`code-dayIndex`) don't say which period they're for.
      if (action.periodStart !== state.periodStart) return { ...state, isSaving: false };
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
      return { ...state, periodStatus: action.status, approvalBadge: null };
    }

    case 'SET_TODAY': {
      return { ...state, today: action.today };
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
  /** Resolves to the save's result — never throws. MARK_SAVED happens only on `ok` (launch-blockers P4). */
  saveAll: (changeReasonCode?: string, comment?: string) => Promise<RunResult<void>>;
  loadPeriod: (direction: 'prev' | 'next') => Promise<void>;
  loadPeriodByDate: (periodStart: CalendarDate) => Promise<void>;
  discardChanges: () => void;
  /** Resolves to the submit's result — never throws. The status becomes 'submitted' only on `ok`. */
  submitTimesheet: (comment?: string) => Promise<RunResult<void>>;
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

/** certified-outputs C4: the save cell's column for a row of this kind. */
export function cellRefForKind(kind: 'charge' | 'clin' | 'indirect', id: string): { chargeCodeId?: string; clinId?: string; indirectCodeId?: string } {
  if (kind === 'indirect') return { indirectCodeId: id };
  if (kind === 'clin') return { clinId: id };
  return { chargeCodeId: id };
}

export function TimesheetProvider({ initialData, children }: ProviderProps) {
  const initialState: TimesheetState = {
    chargeCodes: initialData.chargeCodes,
    entries: initialData.entries,
    savedEntries: initialData.entries.map((e) => ({ ...e, hours: [...e.hours] })),
    savedCellRevisions: initialData.revisions ?? {},
    notes: {},
    periodStart: initialData.periodStart,
    numDays: initialData.numDays,
    activeNoteCell: null,
    userId: initialData.userId,
    isSaving: false,
    isLoadingPeriod: false,
    periodStatus: initialData.periodStatus ?? 'draft',
    approvalBadge: initialData.approvalBadge ?? null,
    flsaExempt: initialData.flsaExempt ?? false,
    periodConfig: initialData.periodConfig,
    today: initialData.today,
    readOnly: initialData.readOnly,
  };

  const [state, dispatch] = useReducer(timesheetReducer, initialState);

  // Compute dirty cells by comparing entries to savedEntries
  const dirtyCells = useMemo<DirtyCell[]>(() => {
    const dirty: DirtyCell[] = [];
    for (const entry of state.entries) {
      const savedEntry = state.savedEntries.find((se) => se.chargeCodeId === entry.chargeCodeId);
      if (!savedEntry) continue;
      for (let i = 0; i < entry.hours.length; i++) {
        const current = entry.hours[i] ?? 0;
        const saved = savedEntry.hours[i] ?? 0;
        if (current !== saved) {
          const key = `${entry.chargeCodeId}-${i}`;
          const revisionNumber = state.savedCellRevisions[key] ?? 0;
          const cellDate = addDays(state.periodStart, i);
          const isEdit = revisionNumber > 0;
          // Late entry: first-time entry (no prior revision) on a date that has already passed.
          // Uses the server-provided `today` (never the browser's clock — a user could spoof it
          // to dodge the late-entry rule); this is advisory for the UI only, saveTimesheetBatch
          // re-derives it authoritatively server-side.
          const isLateEntry = !isEdit && saved === 0 && current > 0 && isBefore(cellDate, state.today);
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
  }, [state.entries, state.savedEntries, state.savedCellRevisions, state.periodStart, state.today]);

  // Are any dirty cells edits to previously-saved data?
  const hasEdits = useMemo(() => dirtyCells.some((c) => c.isEdit), [dirtyCells]);
  const hasLateEntries = useMemo(() => dirtyCells.some((c) => c.isLateEntry), [dirtyCells]);

  const saveAll = useCallback(
    async (changeReasonCode?: string, comment?: string): Promise<RunResult<void>> => {
      if (dirtyCells.length === 0) return { ok: true, data: undefined }; // nothing to save is a successful no-op

      dispatch({ type: 'SET_SAVING', isSaving: true });
      // silent: the toolbar shows the server's message itself.
      const result = await runAction(saveTimesheetBatch({
        periodStart: state.periodStart,
        cells: dirtyCells.map((c) => {
          const chargeCode = state.chargeCodes.find((cc) => cc.id === c.chargeCodeId);
          const revisionKey = `${c.chargeCodeId}-${c.dayIndex}`;
          return {
            // certified-outputs C4: the column follows the row's kind — 'charge' → chargeCodeId (the server denormalizes
            // CLIN/SLIN from the code), 'clin' (a legacy CLIN-only row) → clinId, 'indirect' → indirectCodeId.
            ...cellRefForKind(chargeCode?.kind ?? (chargeCode?.isIndirect ? 'indirect' : 'charge'), c.chargeCodeId),
            dayIndex: c.dayIndex,
            hours: c.hours,
            isEdit: c.isEdit,
            isLateEntry: c.isLateEntry,
            expectedRevision: state.savedCellRevisions[revisionKey] ?? 0,
          };
        }),
        changeReasonCode,
        comment,
      }), { silent: true });

      if (!result.ok) {
        // Nothing was saved: keep the unsaved changes (dirty cells) exactly as they are.
        dispatch({ type: 'SET_SAVING', isSaving: false });
        return result;
      }

      // Only a confirmed save moves the saved snapshot.
      dispatch({
        type: 'MARK_SAVED',
        periodStart: state.periodStart,
        entries: state.entries,
        revisions: result.data,
      });
      return { ok: true, data: undefined };
    },
    [dirtyCells, state.periodStart, state.entries, state.chargeCodes, state.savedCellRevisions]
  );

  // Each load gets a sequence number; a response that arrives after a newer load started is
  // dropped, so out-of-order responses can never show (or save against) the wrong period.
  const loadSeq = useRef(0);

  const showPeriod = useCallback(
    async (resolveStart: () => Promise<CalendarDate>) => {
      const seq = ++loadSeq.current;
      dispatch({ type: 'BEGIN_PERIOD_LOAD' });
      try {
        const period = await getTimesheetPeriod(await resolveStart());
        if (seq !== loadSeq.current) return;

        // Fire-and-forget offline seeding — wrapped in try/catch to prevent IndexedDB errors from crashing the app
        try {
          seedOfflineStore({
            userId: state.userId,
            periodStart: period.periodStart,
            chargeCodes: period.chargeCodes, // F8: THIS period's list, not the one being left
            entries: period.entries,
            revisions: period.revisions,
            periodStatus: period.periodStatus,
          });
        } catch {
          // IndexedDB unavailable or corrupted — app continues without offline support
        }

        dispatch({ type: 'SET_PERIOD_DATA', ...period });
      } catch (error) {
        if (seq !== loadSeq.current) return;
        // Stay on the current period rather than showing cached data of unknown freshness.
        console.error('Failed to load pay period:', error);
        dispatch({ type: 'PERIOD_LOAD_FAILED' });
        notifications.show({
          title: 'Could not load that pay period',
          message: 'Check your connection and try again.',
          color: 'red',
        });
      }
    },
    [state.userId]
  );

  const loadPeriod = useCallback(
    (direction: 'prev' | 'next') =>
      showPeriod(async () => (await getNeighborPeriod(state.periodStart, direction)).periodStart),
    [showPeriod, state.periodStart]
  );

  const loadPeriodByDate = useCallback(
    (periodStart: CalendarDate) => showPeriod(async () => periodStart),
    [showPeriod]
  );

  const discardChanges = useCallback(() => {
    dispatch({ type: 'DISCARD_CHANGES' });
  }, []);

  const submitTimesheet = useCallback(
    async (comment?: string): Promise<RunResult<void>> => {
      dispatch({ type: 'SET_SAVING', isSaving: true });
      const result = await runAction(submitPeriod({
        periodStart: state.periodStart,
        comment,
      }), { silent: true });
      // Only a confirmed submission changes the status.
      if (result.ok) dispatch({ type: 'SET_PERIOD_STATUS', status: 'submitted' });
      dispatch({ type: 'SET_SAVING', isSaving: false });
      return result.ok ? { ok: true, data: undefined } : result;
    },
    [state.periodStart]
  );

  // D4: re-ask the server for "today" on focus and every few minutes, so a tab left open
  // overnight (or across a timezone's midnight) rolls its late/future-date flags over correctly
  // instead of being stuck on the day the page first loaded.
  useEffect(() => {
    const refreshToday = () => {
      getWorkspaceContext()
        .then(({ today }) => dispatch({ type: 'SET_TODAY', today }))
        .catch(() => {
          // Best-effort — keep the last known "today" if the server is unreachable.
        });
    };
    const onFocus = () => refreshToday();
    window.addEventListener('focus', onFocus);
    const interval = setInterval(refreshToday, 5 * 60 * 1000);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
    };
  }, []);

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
