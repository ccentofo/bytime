'use client';

import React, { createContext, useContext, useReducer, useCallback, useMemo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { TimesheetState, TimesheetAction, TimesheetPageData, DirtyCell, SavedNote, LoadGen, TimesheetPeriodData } from '@/types/timesheet';
import { addDays, formatCalendarDate, isBefore, type CalendarDate } from '@/lib/calendar-date';
import { saveTimesheetBatch, getTimesheetPeriod } from '@/server/actions/timesheet';
import { submitPeriod, getWorkspaceContext } from '@/server/actions/periods';
import { runAction, type RunResult } from '@/lib/run-action';
import { getNeighborPeriod } from '@/server/actions/pay-period-config';
import { quietToast } from '@/lib/timesheet/toast';
import { AnnouncerProvider, useAnnounce } from '@/components/timesheet/TimesheetAnnouncer';
import { ReasonModal } from '@/components/timesheet/ReasonModal';
import { SubmitModal } from '@/components/timesheet/SubmitModal';
import { useSubmitChecks, type SubmitChecks } from '@/components/timesheet/useSubmitChecks';

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** The working copy (bodies) of a saved-notes baseline. */
function noteBodies(saved: Record<string, SavedNote>): Record<string, string> {
  return Object.fromEntries(Object.entries(saved).map(([key, note]) => [key, note.body]));
}

/** A dirty note (UX-3 A4.9): its key, row and day, and the trimmed body to send. */
export interface DirtyNote { key: string; rowId: string; dayIndex: number; body: string }

/** Notes whose trimmed working body differs from the saved body (over the keys of both maps). */
export function dirtyNotesOf(notes: Record<string, string>, savedNotes: Record<string, SavedNote>): DirtyNote[] {
  const keys = new Set([...Object.keys(notes), ...Object.keys(savedNotes)]);
  const out: DirtyNote[] = [];
  for (const key of keys) {
    const body = (notes[key] ?? '').trim();
    if (body === (savedNotes[key]?.body ?? '')) continue;
    const split = key.lastIndexOf('-'); // rowId is a UUID (it has dashes); the day index follows the last one
    out.push({ key, rowId: key.slice(0, split), dayIndex: Number(key.slice(split + 1)), body });
  }
  return out;
}

const copyEntries = (entries: TimesheetState['entries']) => entries.map((e) => ({ ...e, hours: [...e.hours] }));
const isStale = (state: TimesheetState, gen: LoadGen | undefined) => gen !== undefined && (gen.loadGen !== state.loadGen || gen.syncGen !== state.syncGen);

/** The state before any period is applied (the initializer runs SET_PERIOD_DATA on it). */
const EMPTY_PERIOD: Omit<TimesheetState, 'userId' | 'today' | 'readOnly' | 'flsaExempt'> = {
  periodStart: '1970-01-01' as CalendarDate, periodEnd: '1970-01-01' as CalendarDate, numDays: 0,
  periodConfig: { periodType: 'semimonthly', anchorDate: '1970-01-01' as CalendarDate, weekStartDay: 1 },
  chargeCodes: [], entries: [], savedEntries: [], savedCellRevisions: {}, periodStatus: 'draft', approvalBadge: null,
  notes: {}, savedNotes: {}, reviewComment: null, summary: null, submitOpensOn: '1970-01-01' as CalendarDate,
  workweekStartDay: null, outsideWeekHours: {}, userCreatedOn: '1970-01-01' as CalendarDate, isCurrent: false,
  submittedOn: null, reviewedOn: null, isSaving: false, isLoadingPeriod: false, syncGen: 0, loadGen: 0, activeNoteCell: null,
};

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
      return { ...state, notes: { ...state.notes, [key]: action.body } };
    }

    case 'OPEN_NOTE_MODAL': {
      return { ...state, activeNoteCell: { chargeCodeId: action.chargeCodeId, dayIndex: action.dayIndex, editable: action.editable } };
    }

    case 'CLOSE_NOTE_MODAL': {
      return { ...state, activeNoteCell: null };
    }

    case 'BEGIN_PERIOD_LOAD': {
      // Keep showing the current period until the server returns the new one; a newer load supersedes this one.
      return { ...state, isLoadingPeriod: true, loadGen: state.loadGen + 1 };
    }

    case 'PERIOD_LOAD_FAILED': {
      if (isStale(state, action.gen)) return state;
      return { ...state, isLoadingPeriod: false };
    }

    case 'SET_PAGE_CONTEXT': {
      // feature-plan-ux-timesheet-ui.md §4.4: the only way the page context changes.
      if (isStale(state, action.gen)) return state;
      return { ...state, today: action.today, readOnly: action.readOnly, flsaExempt: action.flsaExempt ?? state.flsaExempt };
    }

    case 'SET_PERIOD_DATA': {
      // A load that a newer load or a re-sync superseded is ignored (latest wins, §4.4). Page context never changes here.
      if (isStale(state, action.gen)) return state;
      const notes = action.notes ?? {};
      return {
        ...state,
        periodStart: action.periodStart,
        periodEnd: addDays(action.periodStart, action.numDays - 1),
        numDays: action.numDays,
        periodConfig: action.periodConfig,
        // certified-outputs C4: each period has its own code list (assignable ∪ codes with recorded hours).
        chargeCodes: action.chargeCodes,
        entries: action.entries,
        savedEntries: copyEntries(action.entries),
        savedCellRevisions: action.revisions,
        periodStatus: action.periodStatus,
        approvalBadge: action.approvalBadge ?? null,
        // UX-3 A4.9: the period's saved notes become both the working copy and the baseline.
        notes: noteBodies(notes),
        savedNotes: notes,
        reviewComment: action.reviewComment ?? null,
        summary: action.summary ?? null,
        submitOpensOn: action.submitOpensOn,
        workweekStartDay: action.workweekStartDay ?? null,
        outsideWeekHours: action.outsideWeekHours ?? {},
        userCreatedOn: action.userCreatedOn,
        isCurrent: action.isCurrent ?? false,
        submittedOn: action.submittedOn ?? null,
        reviewedOn: action.reviewedOn ?? null,
        isLoadingPeriod: false,
        syncGen: action.resync ? state.syncGen + 1 : state.syncGen,
        activeNoteCell: null,
      };
    }

    case 'SET_SAVING': {
      return { ...state, isSaving: action.isSaving };
    }

    case 'MARK_SAVED': {
      // A save that finishes after the user moved to another period — or after a re-sync replaced the data — must not
      // touch the baseline: revision keys (`code-dayIndex`) don't say which period they're for.
      if (action.periodStart !== state.periodStart || action.syncGen !== state.syncGen) return { ...state, isSaving: false };
      // UX-3 A4.9: the baseline moves for every note that was SENT — to the trimmed body, at the server's new revision
      // when it wrote one (a no-op keeps the previous revision). A cleared note stays as { body: '', revision }.
      const savedNotes = { ...state.savedNotes };
      for (const [key, body] of Object.entries(action.sentNotes ?? {})) {
        savedNotes[key] = { body, revision: action.noteRevisions?.[key] ?? state.savedNotes[key]?.revision ?? 0 };
      }
      return {
        ...state,
        savedEntries: copyEntries(action.entries),
        savedCellRevisions: { ...state.savedCellRevisions, ...action.revisions },
        savedNotes,
        isSaving: false,
      };
    }

    case 'DISCARD_CHANGES': {
      return { ...state, entries: copyEntries(state.savedEntries), notes: noteBodies(state.savedNotes) };
    }

    case 'SET_PERIOD_STATUS': {
      // Right after a submit in this session the submitted date is the workspace's today (§4.1).
      return {
        ...state,
        periodStatus: action.status,
        approvalBadge: null,
        submittedOn: action.status === 'submitted' ? state.today : state.submittedOn,
      };
    }

    case 'SET_TODAY': {
      return { ...state, today: action.today };
    }

    default:
      return state;
  }
}

/** The page context of `initialData` (§4.4). */
export function pageContextOf(d: TimesheetPageData): Pick<TimesheetState, 'userId' | 'today' | 'readOnly' | 'flsaExempt'> {
  return { userId: d.userId, today: d.today, readOnly: d.readOnly, flsaExempt: d.flsaExempt };
}

/** The initial state: the page context, then the period applied by the same SET_PERIOD_DATA as every later load. */
export function initialTimesheetState(d: TimesheetPageData): TimesheetState {
  return timesheetReducer({ ...EMPTY_PERIOD, ...pageContextOf(d) }, { type: 'SET_PERIOD_DATA', ...d.period });
}

// ---------------------------------------------------------------------------
// Contexts (feature-plan-ux-timesheet-ui.md §4.4: dispatch lives in its own context)
// ---------------------------------------------------------------------------

export interface TimesheetStateValue {
  state: TimesheetState;
  dirtyCells: DirtyCell[];
  /** UX-3 A4.9: unsaved notes (they count toward Save/Discard and block Submit). */
  dirtyNotes: DirtyNote[];
  hasUnsaved: boolean;
  unsavedCount: number;
  hasEdits: boolean;        // true if any dirty cell has a prior revision (isEdit=true)
  hasLateEntries: boolean;  // true if any dirty cell is a late first-time entry
  checks: SubmitChecks;
}

export interface TimesheetActionsValue {
  /** Save every unsaved change (ReasonModal when hours need a reason). Resolves true when nothing is left unsaved. */
  requestSave: () => Promise<boolean>;
  /** Resolves to the save's result — never throws. MARK_SAVED happens only on `ok` (launch-blockers P4). */
  saveAll: (changeReasonCode?: string, comment?: string) => Promise<RunResult<void>>;
  loadPeriod: (direction: 'prev' | 'next') => Promise<void>;
  loadPeriodByDate: (periodStart: CalendarDate) => Promise<void>;
  discardChanges: () => void;
  /** Opens SubmitModal (certification). */
  openSubmit: () => void;
  /** Resolves to the submit's result — never throws. The status becomes 'submitted' only on `ok`. */
  submitTimesheet: (comment?: string) => Promise<RunResult<void>>;
}

const StateContext = createContext<TimesheetStateValue | undefined>(undefined);
const DispatchContext = createContext<React.Dispatch<TimesheetAction> | undefined>(undefined);
const ActionsContext = createContext<TimesheetActionsValue | undefined>(undefined);

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
  return (
    <AnnouncerProvider>
      <TimesheetStateProvider initialData={initialData}>{children}</TimesheetStateProvider>
    </AnnouncerProvider>
  );
}

function TimesheetStateProvider({ initialData, children }: ProviderProps) {
  const [state, dispatch] = useReducer(timesheetReducer, initialData, initialTimesheetState);
  const announce = useAnnounce();

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
          dirty.push({ chargeCodeId: entry.chargeCodeId, dayIndex: i, hours: current, isEdit, isLateEntry });
        }
      }
    }
    return dirty;
  }, [state.entries, state.savedEntries, state.savedCellRevisions, state.periodStart, state.today]);

  const dirtyNotes = useMemo(() => dirtyNotesOf(state.notes, state.savedNotes), [state.notes, state.savedNotes]);
  const hasEdits = useMemo(() => dirtyCells.some((c) => c.isEdit), [dirtyCells]);
  const hasLateEntries = useMemo(() => dirtyCells.some((c) => c.isLateEntry), [dirtyCells]);
  const unsavedCount = dirtyCells.length + dirtyNotes.length;
  const hasUnsaved = unsavedCount > 0;
  const checks = useSubmitChecks(state);

  const saveAll = useCallback(
    async (changeReasonCode?: string, comment?: string): Promise<RunResult<void>> => {
      // Nothing to save is a successful no-op. UX-3 A4.9: a notes-only save is a real save (no reason code needed).
      if (dirtyCells.length === 0 && dirtyNotes.length === 0) return { ok: true, data: undefined };
      const kindOf = (rowId: string) => {
        const row = state.chargeCodes.find((cc) => cc.id === rowId);
        return row?.kind ?? (row?.isIndirect ? 'indirect' : 'charge');
      };
      // The notes sent, each with the revision it was based on; the baseline moves only for these.
      const sentNotes = Object.fromEntries(dirtyNotes.map((n) => [n.key, n.body]));
      const sentEntries = state.entries;
      const { periodStart, syncGen } = state;

      dispatch({ type: 'SET_SAVING', isSaving: true });
      // silent: the save flow shows the server's message itself.
      const result = await runAction(saveTimesheetBatch({
        periodStart,
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
        notes: dirtyNotes.map((n) => ({
          ...cellRefForKind(kindOf(n.rowId), n.rowId),
          dayIndex: n.dayIndex,
          body: n.body,
          expectedRevision: state.savedNotes[n.key]?.revision ?? 0,
        })),
        changeReasonCode,
        comment,
      }), { silent: true });

      if (!result.ok) {
        // Nothing was saved: keep the unsaved changes exactly as they are.
        dispatch({ type: 'SET_SAVING', isSaving: false });
        return result;
      }

      // Only a confirmed save moves the saved snapshot — committed synchronously (trap T-N), so the save flow's re-check
      // after this sees the new baseline.
      flushSync(() => dispatch({
        type: 'MARK_SAVED',
        periodStart,
        syncGen,
        entries: sentEntries,
        revisions: result.data.revisions,
        sentNotes,
        noteRevisions: result.data.noteRevisions,
      }));
      return { ok: true, data: undefined };
    },
    [dirtyCells, dirtyNotes, state],
  );

  // ── useSaveFlow (§4.4). Refs are used only because an await intervenes; they're updated in layout effects.
  const saveAllRef = useRef(saveAll);
  const flowRef = useRef({ hasUnsaved, needsReason: hasEdits || hasLateEntries, unsavedCount });
  useLayoutEffect(() => {
    saveAllRef.current = saveAll;
    flowRef.current = { hasUnsaved, needsReason: hasEdits || hasLateEntries, unsavedCount };
  });
  const runningRef = useRef<Promise<boolean> | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const reasonResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const failSave = useCallback((error: string) => {
    announce(error, 'assertive');
    quietToast({ title: 'Save failed', message: error, color: 'red', error: true });
  }, [announce]);

  /** One save, with the ReasonModal when hours need a reason. Resolves true on success, false on cancel or failure. */
  const saveOnce = useCallback(async (): Promise<boolean> => {
    if (!flowRef.current.needsReason) {
      const result = await saveAllRef.current();
      if (!result.ok) { failSave(result.error); return false; }
      return true;
    }
    // A failed save keeps the ReasonModal open for a retry; the promise settles on success or Cancel.
    return new Promise<boolean>((resolve) => {
      reasonResolveRef.current = resolve;
      setReasonOpen(true);
    });
  }, [failSave]);

  const handleReasonConfirm = useCallback(async (reasonCode: string, comment: string) => {
    const result = await saveAllRef.current(reasonCode, comment);
    if (!result.ok) { failSave(result.error); return; }
    setReasonOpen(false);
    reasonResolveRef.current?.(true);
    reasonResolveRef.current = null;
  }, [failSave]);

  const handleReasonCancel = useCallback(() => {
    setReasonOpen(false);
    reasonResolveRef.current?.(false);
    reasonResolveRef.current = null;
  }, []);

  const requestSave = useCallback((): Promise<boolean> => {
    // A save already running is awaited first; then the same re-check applies (saves are serialized).
    const run = (runningRef.current ?? Promise.resolve(true)).then(async () => {
      let saved = 0;
      // Edits made during a save are saved again before resolving (bounded, so a failing loop can't spin).
      for (let round = 0; round < 5 && flowRef.current.hasUnsaved; round++) {
        const count = flowRef.current.unsavedCount;
        if (!(await saveOnce())) return false;
        saved += count;
      }
      if (saved > 0) {
        const message = saved === 1 ? 'Saved' : `${saved} changes saved`;
        announce(message);
        quietToast({ title: 'Timesheet saved', message: saved === 1 ? '1 change saved.' : `${saved} changes saved.`, color: 'success' });
      }
      return !flowRef.current.hasUnsaved;
    });
    runningRef.current = run;
    void run.finally(() => { if (runningRef.current === run) runningRef.current = null; });
    return run;
  }, [saveOnce, announce]);

  // ── Period loads: the latest load wins (loadGen), and a re-sync supersedes any load in flight (syncGen).
  const genRef = useRef<LoadGen>({ loadGen: state.loadGen, syncGen: state.syncGen });
  useLayoutEffect(() => { genRef.current = { loadGen: state.loadGen, syncGen: state.syncGen }; });

  const showPeriod = useCallback(
    async (resolveStart: () => Promise<CalendarDate>) => {
      flushSync(() => dispatch({ type: 'BEGIN_PERIOD_LOAD' }));
      const gen = { ...genRef.current };
      try {
        const period: TimesheetPeriodData = await getTimesheetPeriod(await resolveStart());
        dispatch({ type: 'SET_PAGE_CONTEXT', today: period.today, readOnly: period.readOnly, gen });
        // F8: SET_PERIOD_DATA replaces the code list with THIS period's (never the one being left).
        dispatch({ type: 'SET_PERIOD_DATA', ...period, gen });
      } catch (error) {
        console.error('Failed to load pay period:', error);
        dispatch({ type: 'PERIOD_LOAD_FAILED', gen });
        if (gen.loadGen === genRef.current.loadGen && gen.syncGen === genRef.current.syncGen) {
          announce('Could not load that pay period. Check your connection and try again.', 'assertive');
          quietToast({ title: 'Could not load that pay period', message: 'Check your connection and try again.', color: 'red', error: true });
        }
      }
    },
    [announce],
  );

  const loadPeriod = useCallback(
    (direction: 'prev' | 'next') =>
      showPeriod(async () => (await getNeighborPeriod(state.periodStart, direction)).periodStart),
    [showPeriod, state.periodStart],
  );

  const loadPeriodByDate = useCallback((periodStart: CalendarDate) => showPeriod(async () => periodStart), [showPeriod]);

  const discardChanges = useCallback(() => {
    flushSync(() => dispatch({ type: 'DISCARD_CHANGES' }));
  }, []);

  const submitTimesheet = useCallback(
    async (comment?: string): Promise<RunResult<void>> => {
      dispatch({ type: 'SET_SAVING', isSaving: true });
      const result = await runAction(submitPeriod({ periodStart: state.periodStart, comment }), { silent: true });
      // Only a confirmed submission changes the status.
      if (result.ok) dispatch({ type: 'SET_PERIOD_STATUS', status: 'submitted' });
      dispatch({ type: 'SET_SAVING', isSaving: false });
      return result.ok ? { ok: true, data: undefined } : result;
    },
    [state.periodStart],
  );

  const [submitOpen, setSubmitOpen] = useState(false);
  const openSubmit = useCallback(() => setSubmitOpen(true), []);
  const periodLabel = `${formatCalendarDate(state.periodStart, 'MMM D')} – ${formatCalendarDate(state.periodEnd, 'MMM D, YYYY')}`;

  async function handleSubmitConfirm(comment?: string) {
    const result = await submitTimesheet(comment);
    if (!result.ok) {
      announce(result.error, 'assertive');
      quietToast({ title: 'Submit failed', message: result.error, color: 'red', error: true });
      return;
    }
    setSubmitOpen(false);
    announce('Submitted');
    quietToast({ title: 'Timesheet submitted', message: `Your timesheet for ${periodLabel} has been submitted for supervisor review.`, color: 'signal' });
  }

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

  const stateValue = useMemo<TimesheetStateValue>(
    () => ({ state, dirtyCells, dirtyNotes, hasUnsaved, unsavedCount, hasEdits, hasLateEntries, checks }),
    [state, dirtyCells, dirtyNotes, hasUnsaved, unsavedCount, hasEdits, hasLateEntries, checks],
  );
  const actionsValue = useMemo<TimesheetActionsValue>(
    () => ({ requestSave, saveAll, loadPeriod, loadPeriodByDate, discardChanges, openSubmit, submitTimesheet }),
    [requestSave, saveAll, loadPeriod, loadPeriodByDate, discardChanges, openSubmit, submitTimesheet],
  );

  return (
    <DispatchContext.Provider value={dispatch}>
      <ActionsContext.Provider value={actionsValue}>
        <StateContext.Provider value={stateValue}>
          {children}
          <ReasonModal
            opened={reasonOpen}
            onClose={handleReasonCancel}
            onConfirm={handleReasonConfirm}
            editedCells={dirtyCells.filter((c) => c.isEdit)}
            lateEntryCells={dirtyCells.filter((c) => c.isLateEntry)}
            chargeCodes={state.chargeCodes}
            periodStart={state.periodStart}
            isSaving={state.isSaving}
          />
          <SubmitModal
            opened={submitOpen}
            onClose={() => setSubmitOpen(false)}
            onConfirm={handleSubmitConfirm}
            isSaving={state.isSaving}
            periodLabel={periodLabel}
            flsaExempt={state.flsaExempt}
            totalPeriodHours={checks.totalPeriodHours}
            uncompensatedHours={checks.uncompensatedHours}
            completenessWarnings={checks.completenessWarnings}
          />
        </StateContext.Provider>
      </ActionsContext.Provider>
    </DispatchContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useTimesheetState(): TimesheetStateValue {
  const ctx = useContext(StateContext);
  if (!ctx) throw new Error('useTimesheetState must be used within a <TimesheetProvider>');
  return ctx;
}

export function useTimesheetDispatch(): React.Dispatch<TimesheetAction> {
  const ctx = useContext(DispatchContext);
  if (!ctx) throw new Error('useTimesheetDispatch must be used within a <TimesheetProvider>');
  return ctx;
}

export function useTimesheetActions(): TimesheetActionsValue {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error('useTimesheetActions must be used within a <TimesheetProvider>');
  return ctx;
}

/** Everything at once (state, dispatch and actions) — for components that need all three. */
export function useTimesheet(): TimesheetStateValue & TimesheetActionsValue & { dispatch: React.Dispatch<TimesheetAction> } {
  return { ...useTimesheetState(), ...useTimesheetActions(), dispatch: useTimesheetDispatch() };
}
