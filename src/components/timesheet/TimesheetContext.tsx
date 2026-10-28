'use client';

import React, { createContext, useContext, useReducer, useCallback, useMemo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Button, Group, Modal, Text } from '@mantine/core';
import { confirmLeave, registerUnsavedGuard, type LeaveChoice } from '@/lib/timesheet/unsaved-guard';
import type { TimesheetState, TimesheetAction, TimesheetPageData, DirtyCell, SavedNote, LoadGen, TimesheetPeriodData } from '@/types/timesheet';
import { addDays, formatCalendarDate, isAfter, isBefore, type CalendarDate } from '@/lib/calendar-date';
import { STATUS_WORD, periodLabel as periodRangeLabel } from '@/lib/timesheet/labels';
import { saveTimesheetBatch, getTimesheetPeriod } from '@/server/actions/timesheet';
import { submitPeriod, getWorkspaceContext } from '@/server/actions/periods';
import { runAction, type RunResult } from '@/lib/run-action';
import { getNeighborPeriod } from '@/server/actions/pay-period-config';
import { quietToast } from '@/lib/timesheet/toast';
import { AnnouncerProvider, useAnnounce } from '@/components/timesheet/TimesheetAnnouncer';
import { ReasonModal } from '@/components/timesheet/ReasonModal';
import { SubmitModal } from '@/components/timesheet/SubmitModal';
import { useSubmitChecks, type SubmitChecks } from '@/components/timesheet/useSubmitChecks';
import { GridRefContext, NoteModal, type GridHandle } from '@/components/timesheet/NoteModal';
import { SESSION_USER_CHANGED } from '@/lib/timesheet/copy';

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
  submittedOn: null, reviewedOn: null, isSaving: false, isLoadingPeriod: false, syncGen: 0, loadGen: 0, shownLoadGen: 0, activeNoteCell: null,
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
        // Only an in-page load (it carries its generations) counts as shown — never the first apply or a re-sync.
        shownLoadGen: action.gen && !action.resync ? state.loadGen : state.shownLoadGen,
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
      // L4: a submit that lands after the user moved to another period, or after a re-sync, changes nothing here.
      if (action.periodStart !== state.periodStart || action.syncGen !== state.syncGen) return state;
      // Right after a submit in this session the submitted date is the workspace's today (§4.1).
      return {
        ...state,
        periodStatus: action.status,
        approvalBadge: null,
        submittedOn: action.status === 'submitted' ? state.today : state.submittedOn,
      };
    }

    case 'SET_TODAY': {
      // L9: a tab left open past the period's end is no longer on the current period (the URL then gains ?period=).
      return { ...state, today: action.today, isCurrent: state.isCurrent && !isAfter(action.today, state.periodEnd) };
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
  /**
   * The session alert (§4.4): the session expired (with the new-tab sign-in link), or a different person is signed in
   * now (UX-TIMESHEET-B-AUDIT H3: no sign-in link — reload). Null otherwise.
   */
  sessionAlert: SessionAlert | null;
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
  /** Run an in-page period change (‹, ›, Choose period, Today) — behind the unsaved-changes guard (§4.9). */
  guardPeriodChange: (change: () => Promise<void>) => Promise<void>;
}

export interface SessionAlert { message: string; signInHref: string | null }
/** The alert and the load (and sync) it was raised under: any later landed load or re-sync hides it for good (L8). */
type RaisedSessionAlert = SessionAlert & { shownLoadGen: number; syncGen: number };

/** §4.4: what a save says when the session expired. */
export const SESSION_EXPIRED = "Your session expired. Your changes aren't saved yet. Sign in again in a new tab, then come back and press Save.";

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
  // The grid's focusActive handle, held here for NoteModal and the guard's confirm (§4.3, §4.8, §4.9).
  const gridRef = useRef<GridHandle | null>(null);

  // Re-sync on RSC navigation (§4.4, trap T-H): the page segment doesn't remount for a new ?period=, so a NEW initialData
  // object is applied during render — dispatches to this component's own reducer only (no refs, storage or effects) —
  // and SET_PERIOD_DATA's resync bumps syncGen, which supersedes any load in flight and stale saves.
  const [seenInitial, setSeenInitial] = useState(initialData);
  if (seenInitial !== initialData) {
    setSeenInitial(initialData);
    dispatch({ type: 'SET_PAGE_CONTEXT', today: initialData.today, readOnly: initialData.readOnly, flsaExempt: initialData.flsaExempt });
    dispatch({ type: 'SET_PERIOD_DATA', ...initialData.period, resync: true });
  }

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
        expectedUserId: state.userId,
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

  // Generations of the committed state, for async continuations: the latest load wins (loadGen) and a re-sync
  // supersedes any load in flight (syncGen).
  const genRef = useRef<LoadGen>({ loadGen: state.loadGen, syncGen: state.syncGen });
  useLayoutEffect(() => { genRef.current = { loadGen: state.loadGen, syncGen: state.syncGen }; });

  // ── useSaveFlow (§4.4). Refs are used only because an await intervenes; they're updated in layout effects.
  const saveAllRef = useRef(saveAll);
  const flowRef = useRef({ hasUnsaved, needsReason: hasEdits || hasLateEntries, unsavedCount, periodStart: state.periodStart, syncGen: state.syncGen, shownLoadGen: state.shownLoadGen });
  useLayoutEffect(() => {
    saveAllRef.current = saveAll;
    flowRef.current = { hasUnsaved, needsReason: hasEdits || hasLateEntries, unsavedCount, periodStart: state.periodStart, syncGen: state.syncGen, shownLoadGen: state.shownLoadGen };
  });
  const runningRef = useRef<Promise<boolean> | null>(null);
  // The ReasonModal is open for the syncGen it was opened under; a re-sync closes it without a state update (§4.4).
  const [reasonGen, setReasonGen] = useState<number | null>(null);
  const reasonOpen = reasonGen !== null && reasonGen === state.syncGen;
  const reasonResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const [raisedAlert, setRaisedAlert] = useState<RaisedSessionAlert | null>(null);
  // L8: a period change or a re-sync hides it (derived, no effect); Discard and a successful save clear it.
  const sessionAlert: SessionAlert | null = raisedAlert && raisedAlert.shownLoadGen === state.shownLoadGen && raisedAlert.syncGen === state.syncGen
    ? { message: raisedAlert.message, signInHref: raisedAlert.signInHref } : null;
  const setSessionAlert = useCallback((alert: SessionAlert | null) => {
    setRaisedAlert(alert && { ...alert, shownLoadGen: flowRef.current.shownLoadGen, syncGen: flowRef.current.syncGen });
  }, []);
  /** True when the result means nothing can succeed in this tab right now (the ReasonModal closes, the save stops). */
  const failSave = useCallback((result: { code: string; error: string }): boolean => {
    if (result.code === 'unauthenticated') {
      // §4.4: the edits stay dirty; sign in again in a NEW tab (the session cookie is shared), then Save works here.
      setSessionAlert({ message: SESSION_EXPIRED, signInHref: `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}` });
      announce(SESSION_EXPIRED, 'assertive');
      return true;
    }
    if (result.error === SESSION_USER_CHANGED) {
      // H3: someone else is signed in now. Nothing was written; the edits stay dirty; no sign-in link — reload.
      setSessionAlert({ message: SESSION_USER_CHANGED, signInHref: null });
      announce(SESSION_USER_CHANGED, 'assertive');
      return true;
    }
    announce(result.error, 'assertive');
    quietToast({ title: 'Save failed', message: result.error, color: 'red', error: true });
    return false;
  }, [announce, setSessionAlert]);

  /** One save, with the ReasonModal when hours need a reason. Resolves true on success, false on cancel or failure. */
  const saveOnce = useCallback(async (): Promise<boolean> => {
    if (!flowRef.current.needsReason) {
      const result = await saveAllRef.current();
      if (!result.ok) { failSave(result); return false; }
      setSessionAlert(null);
      return true;
    }
    // A failed save keeps the ReasonModal open for a retry; the promise settles on success or Cancel.
    return new Promise<boolean>((resolve) => {
      reasonResolveRef.current = resolve;
      setReasonGen(genRef.current.syncGen);
    });
  }, [failSave, setSessionAlert]);

  const handleReasonConfirm = useCallback(async (reasonCode: string, comment: string): Promise<boolean> => {
    // L5: the modal this confirm belongs to — captured BEFORE the save, so a save that lands after a re-sync settled it
    // (and maybe a newer modal opened) can't resolve or close the newer one.
    const resolve = reasonResolveRef.current;
    const result = await saveAllRef.current(reasonCode, comment);
    const stillOurs = resolve !== null && reasonResolveRef.current === resolve;
    if (!result.ok) {
      // A failed save keeps the ReasonModal open for a retry — except when the session expired or a different person is
      // signed in: then it closes and the save resolves false (nothing can succeed until that's fixed).
      if (failSave(result) && stillOurs) {
        setReasonGen(null);
        reasonResolveRef.current = null;
        resolve(false);
      }
      return false;
    }
    setSessionAlert(null);
    if (stillOurs) {
      setReasonGen(null);
      reasonResolveRef.current = null;
      resolve(true);
    }
    return true;
  }, [failSave, setSessionAlert]);

  const handleReasonCancel = useCallback(() => {
    setReasonGen(null);
    reasonResolveRef.current?.(false);
    reasonResolveRef.current = null;
  }, []);

  // A re-sync replaced the data: a pending ReasonModal closes and its save promise settles false (§4.4).
  useEffect(() => {
    reasonResolveRef.current?.(false);
    reasonResolveRef.current = null;
  }, [state.syncGen]);

  const requestSave = useCallback((): Promise<boolean> => {
    // The period this save is for (H2): the re-check below stops once another period, or a re-sync, replaced it.
    const forPeriod = { periodStart: flowRef.current.periodStart, syncGen: flowRef.current.syncGen };
    const samePeriod = () => flowRef.current.periodStart === forPeriod.periodStart && flowRef.current.syncGen === forPeriod.syncGen;
    // A save already running is awaited first; then the same re-check applies (saves are serialized).
    const run = (runningRef.current ?? Promise.resolve(true)).then(async () => {
      let saved = 0;
      // Edits made during a save are saved again before resolving (bounded, so a failing loop can't spin) — but only
      // the period's own: what's unsaved after a period change or a re-sync belongs to a period this save wasn't for.
      for (let round = 0; round < 5 && samePeriod() && flowRef.current.hasUnsaved; round++) {
        const count = flowRef.current.unsavedCount;
        if (!(await saveOnce())) return false;
        saved += count;
      }
      if (saved > 0) {
        const message = saved === 1 ? 'Saved' : `${saved} changes saved`;
        announce(message);
        quietToast({ title: 'Timesheet saved', message: saved === 1 ? '1 change saved.' : `${saved} changes saved.`, color: 'success' });
      }
      return samePeriod() && !flowRef.current.hasUnsaved;
    });
    runningRef.current = run;
    void run.finally(() => { if (runningRef.current === run) runningRef.current = null; });
    return run;
  }, [saveOnce, announce]);


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
    setSessionAlert(null); // L8: nothing unsaved is left for the alert to be about
  }, [setSessionAlert]);

  const submitTimesheet = useCallback(
    async (comment?: string): Promise<RunResult<void>> => {
      const { periodStart, syncGen } = state;
      dispatch({ type: 'SET_SAVING', isSaving: true });
      const result = await runAction(submitPeriod({ expectedUserId: state.userId, periodStart, comment }), { silent: true });
      // Only a confirmed submission changes the status — of the period it was for (L4).
      if (result.ok) dispatch({ type: 'SET_PERIOD_STATUS', status: 'submitted', periodStart, syncGen });
      dispatch({ type: 'SET_SAVING', isSaving: false });
      return result.ok ? { ok: true, data: undefined } : result;
    },
    [state],
  );

  // ── The unsaved-changes guard (§4.9). In-page period changes wait for confirmLeave(); on cancel nothing changes (the
  // Choose period Select is controlled, so it snaps back).
  const guardPeriodChange = useCallback(async (change: () => Promise<void>) => {
    if (await confirmLeave()) await change();
  }, []);

  // The confirm: open for the syncGen it was opened under (a re-sync closes it); it resolves after its exit transition
  // so it is closed before any ReasonModal opens; on Cancel focus returns to the trigger (or the grid's active cell).
  const [confirm, setConfirm] = useState<{ n: number; gen: number; resolve: (c: LeaveChoice) => void } | null>(null);
  const [confirmShown, setConfirmShown] = useState(false);
  const confirmOpen = confirm !== null && confirmShown && confirm.gen === state.syncGen;
  const chosenRef = useRef<LeaveChoice | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const openConfirm = useCallback((n: number) => new Promise<LeaveChoice>((resolve) => {
    triggerRef.current ??= (document.activeElement as HTMLElement | null);
    chosenRef.current = null;
    setConfirm({ n, gen: genRef.current.syncGen, resolve });
    setConfirmShown(true);
  }), []);
  const choose = (c: LeaveChoice) => { chosenRef.current = c; setConfirmShown(false); };
  const confirmClosed = () => {
    if (!confirm) return;
    const choice = chosenRef.current ?? 'cancel';
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (choice === 'cancel') {
      if (trigger?.isConnected) trigger.focus();
      else gridRef.current?.focusActive();
    }
    confirm.resolve(choice);
    setConfirm(null);
  };

  // Registered while mounted (functions read the latest state through refs updated in layout effects).
  const guardRef = useRef({ count: unsavedCount, requestSave, discard: discardChanges, openConfirm });
  useLayoutEffect(() => { guardRef.current = { count: unsavedCount, requestSave, discard: discardChanges, openConfirm }; });
  useLayoutEffect(() => registerUnsavedGuard({
    token: Symbol('timesheet'),
    getCount: () => guardRef.current.count,
    // H2: the confirm waits for a running save; MARK_SAVED commits in flushSync, so the count read after it is current.
    whenSaved: () => runningRef.current,
    requestSave: () => guardRef.current.requestSave(),
    discard: () => guardRef.current.discard(),
    openConfirm: (n) => guardRef.current.openConfirm(n),
  }), []);

  // In-app links: ONE capture-phase listener (it runs before Link's onClick, and Link skips navigation when
  // defaultPrevented is set). Only with unsaved changes, for a plain primary click on a same-origin link that would
  // navigate (not a new tab, a download, an in-page #hash jump).
  const router = useRouter();
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (guardRef.current.count === 0 || e.defaultPrevented) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.hasAttribute('download')) return;
      const target = a.getAttribute('target');
      if (target && target !== '_self') return;
      const raw = a.getAttribute('href') ?? '';
      if (raw.startsWith('#')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash !== '') return;
      e.preventDefault();
      triggerRef.current = a;
      void confirmLeave().then((ok) => {
        if (!ok) return;
        const dest = url.pathname + url.search + url.hash;
        if (url.pathname.startsWith('/api/')) window.location.assign(dest);
        else router.push(dest);
      });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [router]);

  // Tab close / reload: armed while COMMITTED unsaved changes exist; re-evaluated after every commit.
  useEffect(() => {
    if (!hasUnsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = true; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsaved]);

  // M5: after an in-page load lands (‹, ›, Choose period, Today), say which period is showing — politely, once per load;
  // not on mount and not on a re-sync (shownLoadGen changes only when a load's data is applied).
  const announcedLoadRef = useRef(state.shownLoadGen);
  useEffect(() => {
    if (state.shownLoadGen === announcedLoadRef.current) return;
    announcedLoadRef.current = state.shownLoadGen;
    announce(`Showing ${periodRangeLabel(state.periodStart, state.periodEnd)}, ${STATUS_WORD[state.periodStatus]}`);
  }, [state.shownLoadGen, state.periodStart, state.periodEnd, state.periodStatus, announce]);

  // URL sync (§4.10): after the committed period changes — never from a fetch continuation — and only when the URL
  // differs. replaceState doesn't re-run the server components (trap T-H); on mount it canonicalizes to the period shown.
  useEffect(() => {
    const target = state.isCurrent ? '/timesheet' : `/timesheet?period=${state.periodStart}`;
    if (window.location.pathname + window.location.search !== target) window.history.replaceState(null, '', target);
  }, [state.periodStart, state.isCurrent, state.syncGen]);

  // L4: like the ReasonModal, the SubmitModal is open for the syncGen it was opened under — a re-sync closes it.
  const [submitGen, setSubmitGen] = useState<number | null>(null);
  const submitOpen = submitGen !== null && submitGen === state.syncGen;
  const setSubmitOpen = (open: boolean) => setSubmitGen(open ? state.syncGen : null);
  const openSubmit = useCallback(() => setSubmitGen(genRef.current.syncGen), []);
  const periodLabel = `${formatCalendarDate(state.periodStart, 'MMM D')} – ${formatCalendarDate(state.periodEnd, 'MMM D, YYYY')}`;

  async function handleSubmitConfirm(comment?: string) {
    const result = await submitTimesheet(comment);
    if (!result.ok && result.error === SESSION_USER_CHANGED) {
      // H3: nothing was certified. The submit can't succeed in this tab, so the modal closes and the session alert says why.
      setSubmitOpen(false);
      setSessionAlert({ message: SESSION_USER_CHANGED, signInHref: null });
      announce(SESSION_USER_CHANGED, 'assertive');
      return;
    }
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
    () => ({ state, dirtyCells, dirtyNotes, hasUnsaved, unsavedCount, hasEdits, hasLateEntries, checks, sessionAlert }),
    [state, dirtyCells, dirtyNotes, hasUnsaved, unsavedCount, hasEdits, hasLateEntries, checks, sessionAlert],
  );
  const actionsValue = useMemo<TimesheetActionsValue>(
    () => ({ requestSave, saveAll, loadPeriod, loadPeriodByDate, discardChanges, openSubmit, submitTimesheet, guardPeriodChange }),
    [requestSave, saveAll, loadPeriod, loadPeriodByDate, discardChanges, openSubmit, submitTimesheet, guardPeriodChange],
  );

  return (
    <DispatchContext.Provider value={dispatch}>
      <ActionsContext.Provider value={actionsValue}>
        <StateContext.Provider value={stateValue}>
          <GridRefContext.Provider value={gridRef}>
          {children}
          <NoteModal />
          <Modal
            opened={confirmOpen}
            onClose={() => choose('cancel')}
            title={`You have ${confirm?.n ?? 0} unsaved ${confirm?.n === 1 ? 'change' : 'changes'}`}
            returnFocus={false}
            onExitTransitionEnd={confirmClosed}
          >
            <Text size="sm" mb="lg">Save them before you leave this timesheet, or discard them.</Text>
            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={() => choose('cancel')}>Cancel</Button>
              <Button color="red" variant="light" onClick={() => choose('discard')}>Discard and continue</Button>
              <Button onClick={() => choose('save')}>Save and continue</Button>
            </Group>
          </Modal>
          </GridRefContext.Provider>
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
