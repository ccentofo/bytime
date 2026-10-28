'use client';

import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Button, Select } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useGridRef } from '@/components/timesheet/NoteModal';
import { Icons } from '@/components/ui/icons';
import { flushSync } from 'react-dom';
import { useTimesheetDispatch, useTimesheetState } from '@/components/timesheet/TimesheetContext';
import { useAnnounce } from '@/components/timesheet/TimesheetAnnouncer';
import { HourCell } from '@/components/timesheet/cells/HourCell';
import { TotalCell } from '@/components/timesheet/cells/TotalCell';
import { RowHeaderCell } from '@/components/timesheet/cells/RowHeaderCell';
import { DayHeader } from '@/components/timesheet/cells/DayHeader';
import { CellEditor } from '@/components/timesheet/cells/CellEditor';
import { addDays, dayOfWeek, diffDays, formatCalendarDate, isAfter, isBefore, type CalendarDate } from '@/lib/calendar-date';
import { isCellEditable } from '@/lib/timesheet/cell-rules';
import { CLOSED_TO_NEW_HOURS } from '@/lib/timesheet/copy';
import { STATUS_WORD, periodWords } from '@/lib/timesheet/labels';
import { RH, TOTAL, clampPos, columnsOf, initialPos, rowsOf, type Col, type Pos, type Row } from '@/lib/timesheet/grid-positions';
import { draftOf, normalizeDraft, seedChar, validateDraft } from '@/lib/timesheet/cell-input';
import type { ChargeCode } from '@/types/timesheet';
import styles from './Timesheet.module.css';

const round2 = (n: number) => Math.round(n * 100) / 100;
const isWeekendDay = (d: CalendarDate) => { const w = dayOfWeek(d); return w === 0 || w === 6; };

interface GridRow {
  cc: ChargeCode;
  r: number;
  hours: number[];
  saved: number[];
  provenance: Array<string | null>;
  total: number;
}

/** A day cell's facts for the handlers (computed from the same render as the cells). */
interface DayCellInfo { row: GridRow; d: number; editable: boolean; reason: string | null; value: number; saved: number }

const TOTALS_CALCULATED = 'Totals are calculated.';

/**
 * The accessible timesheet grid (feature-plan-ux-timesheet-ui.md §4.2, §4.3): a `<table role="grid">` with one tab stop
 * (the ACTIVE position, derived during render by clamping the requested one), WAI-ARIA data-grid navigation, and one
 * editing input inside the active cell. Handlers are plain per-render closures on the table; the refs (suppressBlurCommit,
 * gridHadFocus) are written only inside handlers (trap T-M).
 */
export function TimesheetGrid() {
  const { state, dirtyCells } = useTimesheetState();
  const dispatch = useTimesheetDispatch();
  const announce = useAnnounce();
  const gridId = useId();
  const { chargeCodes, entries, savedEntries, savedCellRevisions, periodStart, periodEnd, numDays, today, notes, userCreatedOn, periodStatus, readOnly, isLoadingPeriod, syncGen, workweekStartDay } = state;
  // Week view below 40em (§4.7): the first paint is the full grid (useMediaQuery reads in an effect), then it switches.
  const narrow = useMediaQuery('(max-width: 40em)', false) ?? false;
  const periodEditable = (periodStatus === 'draft' || periodStatus === 'rejected') && !readOnly && !isLoadingPeriod;
  const locked = periodStatus === 'submitted' || periodStatus === 'approved';

  // Rows precomputed once per render: Map(rowKey → row), in display order (Direct, then Indirect and leave).
  const { groups, rows, rowList, dayTotals, savedDayTotals, grand } = useMemo(() => {
    const byId = new Map(entries.map((e) => [e.chargeCodeId, e]));
    const savedById = new Map(savedEntries.map((e) => [e.chargeCodeId, e]));
    const direct = chargeCodes.filter((c) => c.kind !== 'indirect');
    const indirect = chargeCodes.filter((c) => c.kind === 'indirect');
    const map = new Map<string, GridRow>();
    [...direct, ...indirect].forEach((cc, r) => {
      const hours = Array.from({ length: numDays }, (_, d) => byId.get(cc.id)?.hours[d] ?? 0);
      const saved = Array.from({ length: numDays }, (_, d) => savedById.get(cc.id)?.hours[d] ?? 0);
      const provenance = Array.from({ length: numDays }, (_, d) => byId.get(cc.id)?.provenance?.[d] ?? null);
      map.set(cc.id, { cc, r, hours, saved, provenance, total: round2(hours.reduce((s, h) => s + h, 0)) });
    });
    const list = [...map.values()];
    const totals = Array.from({ length: numDays }, (_, d) => round2(list.reduce((s, row) => s + row.hours[d], 0)));
    const savedTotals = Array.from({ length: numDays }, (_, d) => round2(list.reduce((s, row) => s + row.saved[d], 0)));
    return {
      groups: [{ label: 'Direct', codes: direct }, { label: 'Indirect and leave', codes: indirect }].filter((g) => g.codes.length > 0),
      rows: map,
      rowList: list,
      dayTotals: totals,
      savedDayTotals: savedTotals,
      grand: round2(totals.reduce((s, h) => s + h, 0)),
    };
  }, [chargeCodes, entries, savedEntries, numDays]);

  const dirty = useMemo(() => new Set(dirtyCells.map((c) => `${c.chargeCodeId}-${c.dayIndex}`)), [dirtyCells]);
  const allDays = useMemo(() => Array.from({ length: numDays }, (_, d) => d), [numDays]);
  // Weeks aligned to the workspace workweek (Sunday when unset), clipped to the period; day indexes are PERIOD indexes.
  const weeks = useMemo(() => {
    const out: number[][] = [];
    for (const d of allDays) {
      const startsWeek = d === 0 || dayOfWeek(addDays(periodStart, d)) === (workweekStartDay ?? 0);
      if (startsWeek) out.push([]);
      out[out.length - 1].push(d);
    }
    return out;
  }, [allDays, periodStart, workweekStartDay]);
  const weekOf = (d: number) => Math.max(0, weeks.findIndex((w) => w.includes(d)));
  const bodyCount = rows.size;
  const todayOffset = diffDays(periodStart, today);
  const todayIndex = todayOffset >= 0 && todayOffset < numDays ? todayOffset : null;

  // ── Grid-local state (§4.3).
  const [requested, setRequested] = useState<Pos>(() => initialPos(bodyCount, allDays, todayIndex));
  // The selected week follows the active DAY; it stays put while the active column is the row header or the total.
  const [week, setWeek] = useState(() => (todayIndex !== null ? weekOf(todayIndex) : 0));
  const requestedWeek = typeof requested.c === 'number' ? weekOf(Math.min(requested.c, numDays - 1)) : Math.min(week, weeks.length - 1);
  if (requestedWeek !== week) setWeek(requestedWeek);
  const visibleDays = narrow ? (weeks[requestedWeek] ?? allDays) : allDays;
  const [mode, setMode] = useState<'nav' | 'edit'>('nav');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cancelledGen, setCancelledGen] = useState(0);
  const suppressBlurCommit = useRef(false);
  // Whether focus was inside the grid when it last moved (written in the table's focus handlers only). A focused cell or
  // editor that unmounts fires no blur, so this stays true and the layout effect below can put focus back (M1).
  const gridHadFocus = useRef(false);

  // A period, re-sync or view change cancels an open edit — during render, with this component's own setState (§4.3).
  const periodKey = `${periodStart}|${syncGen}|${narrow ? 'week' : 'full'}`;
  const [seenPeriodKey, setSeenPeriodKey] = useState(periodKey);
  if (seenPeriodKey !== periodKey) {
    setSeenPeriodKey(periodKey);
    if (mode === 'edit') {
      setMode('nav');
      setError(null);
      setCancelledGen((g) => g + 1);
    }
  }
  // ...and the cancellation is announced from an effect, never during render.
  useEffect(() => {
    if (cancelledGen > 0) announce('Edit cancelled');
  }, [cancelledGen, announce]);

  // UX-TIMESHEET-B-AUDIT M1 (§3 inv. 4): an edit cancelled by a view switch (resize / zoom across 40em), or a re-sync with
  // fewer rows, unmounts the focused editor or cell and focus falls to <body>. If the grid held focus, put it back on the
  // active cell (the one tab stop) before paint.
  const tableId = `${gridId}-table`;
  useLayoutEffect(() => {
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (gridHadFocus.current && lost) (document.getElementById(tableId)?.querySelector('[tabindex="0"]') as HTMLElement | null)?.focus();
  }, [cancelledGen, syncGen, narrow, tableId]);

  const active = clampPos(requested, bodyCount, visibleDays);
  const isActive = (r: Row, c: Col) => active.r === r && active.c === c;
  const columns = columnsOf(visibleDays);
  const rowOrder = rowsOf(bodyCount);

  const why = {
    future: `${gridId}-why-future`, closed: `${gridId}-why-closed`, locked: `${gridId}-why-locked`,
    readonly: `${gridId}-why-readonly`, total: `${gridId}-why-total`,
  };
  const reasonText = {
    future: "Future date. Hours can't be entered yet.",
    closed: `${CLOSED_TO_NEW_HOURS}. You can correct hours already recorded.`,
    locked: `This timesheet is ${periodStatus === 'approved' ? 'approved' : 'submitted'} and can't be changed.`,
    readonly: 'This workspace is read-only.',
  };
  const days = visibleDays.map((d) => {
    const date = addDays(periodStart, d);
    const past = isBefore(date, today);
    const noHours = dayTotals[d] === 0 && past && !isWeekendDay(date) && !isBefore(date, userCreatedOn);
    return { d, date, weekend: isWeekendDay(date), isToday: date === today, future: isAfter(date, today), noHours };
  });

  /** Editability and the read-only reason of one day cell (the same rule the cells render with). */
  function dayCell(row: GridRow, d: number): DayCellInfo & { whyKey: keyof typeof reasonText | null; closed: boolean } {
    const future = isAfter(addDays(periodStart, d), today);
    const editable = isCellEditable({ periodEditable, isFutureDate: future, assignable: row.cc.assignable, priorRevision: savedCellRevisions[`${row.cc.id}-${d}`] ?? 0 });
    const closed = periodEditable && !future && !editable;
    const whyKey: keyof typeof reasonText | null = editable ? null : readOnly ? 'readonly' : locked ? 'locked' : future ? 'future' : closed ? 'closed' : null;
    return { row, d, editable, closed, whyKey, reason: whyKey ? reasonText[whyKey] : null, value: row.hours[d], saved: row.saved[d] };
  }

  const activeRow = typeof active.r === 'number' ? rowList[active.r] : undefined;
  const activeDay = activeRow && typeof active.c === 'number' ? dayCell(activeRow, active.c) : null;

  // ── Notes (§4.8): editable when the period is editable and the day isn't in the future — the row's closure doesn't
  // matter (the server accepts notes on any shown row). Not the hours rule.
  const noteEditable = (d: number) => periodEditable && !isAfter(addDays(periodStart, d), today);
  const openNote = (row: GridRow, d: number) => {
    dispatch({ type: 'OPEN_NOTE_MODAL', chargeCodeId: row.cc.id, dayIndex: d, editable: noteEditable(d) });
  };
  const gridRef = useGridRef();
  useImperativeHandle(gridRef, () => ({
    focusActive: () => {
      (document.getElementById(tableId)?.querySelector('[tabindex="0"]') as HTMLElement | null)?.focus();
    },
  }), [tableId]);
  const activeNoteKey = activeDay ? `${activeDay.row.cc.id}-${activeDay.d}` : null;
  const activeHasNote = activeNoteKey ? Boolean(notes[activeNoteKey]?.trim()) : false;
  const noteVerb = activeHasNote ? 'Edit' : 'Add';

  // ── Focus and movement (handlers only).
  const focusPos = (table: HTMLElement, p: Pos) => {
    const target = [...table.querySelectorAll<HTMLElement>('[data-r][data-c]')].find((el) => el.dataset.r === String(p.r) && el.dataset.c === String(p.c));
    target?.focus();
  };
  const moveTo = (table: HTMLElement, p: Pos) => {
    flushSync(() => setRequested(p));
    focusPos(table, p);
  };
  const enterEdit = (table: HTMLElement, initialDraft: string, caret: 'select' | 'end') => {
    flushSync(() => { setMode('edit'); setDraft(initialDraft); setError(null); });
    const input = table.querySelector('input[data-cell-editor]') as HTMLInputElement | null;
    if (!input) return;
    input.focus(); // synchronous inside the gesture (iOS keyboard, trap T-B)
    if (caret === 'select') input.select();
    else input.setSelectionRange(input.value.length, input.value.length);
  };

  /** Commit the draft of the active day cell: SET_HOURS once when the value changed. */
  const commitDraft = (cellInfo: DayCellInfo): { ok: true } | { ok: false; error: string } => {
    const result = validateDraft(draft, { current: cellInfo.value, dayTotal: dayTotals[cellInfo.d], savedDayTotal: savedDayTotals[cellInfo.d] });
    if (!result.ok) return result;
    if (result.value !== cellInfo.value) dispatch({ type: 'SET_HOURS', chargeCodeId: cellInfo.row.cc.id, dayIndex: cellInfo.d, value: result.value });
    return { ok: true };
  };
  const showInvalid = (message: string) => {
    setError(message);
    announce(message, 'assertive');
  };

  function handleEditKey(e: KeyboardEvent<HTMLTableElement>, table: HTMLElement) {
    if (!activeDay) return;
    const key = e.key;
    // Each key commit focuses its target cell BEFORE edit mode ends, so the input always blurs while still mounted —
    // and suppressBlurCommit stops that blur from committing a second time (or committing a draft Esc discarded, T-D).
    if (key === 'Escape') {
      e.preventDefault();
      suppressBlurCommit.current = true;
      focusPos(table, active);
      flushSync(() => { setMode('nav'); setError(null); });
      return;
    }
    if (key === 'Enter' || key === 'ArrowUp' || key === 'ArrowDown') {
      e.preventDefault();
      const committed = commitDraft(activeDay);
      if (!committed.ok) { showInvalid(committed.error); return; }
      const idx = rowOrder.indexOf(active.r);
      const next: Pos = key === 'Enter' ? active : { r: rowOrder[Math.min(Math.max(0, idx + (key === 'ArrowUp' ? -1 : 1)), rowOrder.length - 1)], c: active.c };
      suppressBlurCommit.current = true;
      focusPos(table, next);
      flushSync(() => { setMode('nav'); setError(null); setRequested(next); });
      return;
    }
    if (key === 'Tab') {
      const step = e.shiftKey ? -1 : 1;
      const dayIdx = visibleDays.indexOf(activeDay.d);
      const nextDay = visibleDays[dayIdx + step];
      const committed = commitDraft(activeDay);
      if (!committed.ok) {
        // Invalid: restore the earlier value, say so, and let Tab leave the grid natively — never trap.
        suppressBlurCommit.current = true;
        announce(`${draft} isn't valid; restored ${draftOf(activeDay.value) || '0.00'}`, 'assertive');
        return;
      }
      if (nextDay === undefined) {
        // Last (or first) visible day: commit and let Tab leave the grid; the blur ends edit mode.
        suppressBlurCommit.current = true;
        return;
      }
      e.preventDefault();
      const next: Pos = { r: active.r, c: nextDay };
      suppressBlurCommit.current = true;
      focusPos(table, next);
      flushSync(() => { setMode('nav'); setError(null); setRequested(next); });
    }
    // ← / → move the caret (not handled).
  }

  function handleNavKey(e: KeyboardEvent<HTMLTableElement>, table: HTMLElement) {
    const { key } = e;
    const mod = e.ctrlKey || e.metaKey;
    // Modifier rule: only Ctrl/Meta + Home/End are handled with a modifier; Alt+← and ⌘+← (browser Back) pass through.
    if ((mod || e.altKey) && !(mod && !e.altKey && (key === 'Home' || key === 'End'))) return;
    const colIdx = columns.indexOf(active.c);
    const rowIdx = rowOrder.indexOf(active.r);

    switch (key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault();
        const step = key === 'ArrowLeft' ? -1 : 1;
        // Week view, at a week edge: continue into the adjacent week (stopping at the period edges).
        if (narrow && typeof active.c === 'number') {
          const neighbourDay = active.c + step;
          const atWeekEdge = !visibleDays.includes(neighbourDay);
          if (atWeekEdge && neighbourDay >= 0 && neighbourDay < numDays) { moveTo(table, { r: active.r, c: neighbourDay }); return; }
        }
        const next = columns[colIdx + step];
        if (next !== undefined) moveTo(table, { r: active.r, c: next });
        return;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const next = rowOrder[rowIdx + (key === 'ArrowUp' ? -1 : 1)];
        if (next !== undefined) moveTo(table, { r: next, c: active.c });
        return;
      }
      case 'Home':
      case 'End': {
        e.preventDefault();
        if (mod) moveTo(table, key === 'Home' ? { r: bodyCount > 0 ? 0 : 'foot', c: allDays[0] ?? RH } : { r: 'foot', c: TOTAL });
        else moveTo(table, { r: active.r, c: key === 'Home' ? RH : TOTAL });
        return;
      }
      case 'PageUp':
      case 'PageDown': {
        if (typeof active.c !== 'number') return; // row header / total: nothing
        e.preventDefault();
        const target = Math.min(Math.max(0, active.c + (key === 'PageUp' ? -7 : 7)), numDays - 1);
        moveTo(table, { r: active.r, c: target });
        return;
      }
      case 'Enter':
      case 'F2':
      case ' ': {
        e.preventDefault();
        if (activeDay) {
          if (activeDay.editable) enterEdit(table, draftOf(activeDay.value), key === 'F2' ? 'end' : 'select');
          else if (activeDay.reason) announce(activeDay.reason);
        } else if (active.c === TOTAL) {
          announce(TOTALS_CALCULATED);
        }
        return;
      }
      case 'Delete':
      case 'Backspace': {
        if (!activeDay) return;
        e.preventDefault();
        if (!activeDay.editable) { if (activeDay.reason) announce(activeDay.reason); return; }
        dispatch({ type: 'SET_HOURS', chargeCodeId: activeDay.row.cc.id, dayIndex: activeDay.d, value: 0 });
        announce('Cleared');
        return;
      }
      case 'n':
      case 'N': {
        if (!activeDay) return;
        e.preventDefault();
        openNote(activeDay.row, activeDay.d);
        return;
      }
      case 'Escape': {
        if (!activeDay || activeDay.value === activeDay.saved) return;
        e.preventDefault();
        dispatch({ type: 'SET_HOURS', chargeCodeId: activeDay.row.cc.id, dayIndex: activeDay.d, value: activeDay.saved });
        announce(`Restored to ${activeDay.saved.toFixed(2)}`);
        return;
      }
      default: {
        const seed = seedChar(key);
        if (seed === null || !activeDay) return;
        if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME composing: no type-to-edit
        e.preventDefault(); // the seeding keystroke must not also reach the new input (trap T-C)
        if (activeDay.editable) enterEdit(table, seed, 'end');
        else if (activeDay.reason) announce(activeDay.reason);
      }
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTableElement>) {
    const table = e.currentTarget;
    if (mode === 'edit' && (e.target as HTMLElement).matches('input[data-cell-editor]')) handleEditKey(e, table);
    else if (mode === 'nav') handleNavKey(e, table);
  }

  function handleClick(e: MouseEvent<HTMLTableElement>) {
    const target = e.target as HTMLElement;
    if (target.closest('input[data-cell-editor]')) return; // clicks inside the active input don't reselect
    const el = target.closest('[data-r][data-c]') as HTMLElement | null;
    if (!el) return;
    const r: Row = el.dataset.r === 'foot' ? 'foot' : Number(el.dataset.r);
    const cRaw = el.dataset.c!;
    const c: Col = cRaw === RH || cRaw === TOTAL ? cRaw : Number(cRaw);
    const table = e.currentTarget;
    // A click that arrives while still editing came without a focus change (a screen-reader activation, an iOS tap):
    // no mousedown blurred the editor. The click on the active cell itself keeps the draft; anywhere else runs the blur
    // path first — commit, or restore and say so — then focuses the cell, so the input blurs while still mounted and
    // suppressBlurCommit stops that blur committing twice (UX-TIMESHEET-B-AUDIT H1).
    if (mode === 'edit' && activeDay) {
      if (r === active.r && c === active.c) { (table.querySelector('input[data-cell-editor]') as HTMLInputElement | null)?.focus(); return; }
      const committed = commitDraft(activeDay);
      if (!committed.ok) announce(`${draft} isn't valid; restored ${draftOf(activeDay.value) || '0.00'}`, 'assertive');
      suppressBlurCommit.current = true;
      focusPos(table, active);
      flushSync(() => { setMode('nav'); setError(null); });
    }
    flushSync(() => setRequested({ r, c }));
    const row = typeof r === 'number' ? rowList[r] : undefined;
    const info = row && typeof c === 'number' ? dayCell(row, c) : null;
    if (info?.editable) enterEdit(table, draftOf(info.value), 'select');
    else focusPos(table, { r, c });
  }

  function handleDraftChange(e: ChangeEvent<HTMLInputElement>) {
    const next = normalizeDraft(e.target.value);
    if (next !== null) { setDraft(next); setError(null); }
  }

  function handleEditorBlur(e: FocusEvent<HTMLInputElement>) {
    if (suppressBlurCommit.current) {
      suppressBlurCommit.current = false;
      setMode('nav');
      setError(null);
      return;
    }
    if (!activeDay) { setMode('nav'); return; }
    const committed = commitDraft(activeDay);
    if (!committed.ok) announce(`${draft} isn't valid; restored ${draftOf(activeDay.value) || '0.00'}`, 'assertive');
    // A window blur (switching apps or tabs) leaves the input the document's active element; once it unmounts focus would
    // be on <body> when the window comes back. Move it to the cell first — suppressing any blur that move causes (M1).
    const table = e.currentTarget.closest('table');
    if (document.activeElement === e.currentTarget && table) {
      suppressBlurCommit.current = true;
      focusPos(table, active);
      suppressBlurCommit.current = false;
    }
    setMode('nav');
    setError(null);
  }

  // Focus tracking for M1: inside the grid, or moved somewhere else (relatedTarget outside the table, or none).
  function handleGridFocus() { gridHadFocus.current = true; }
  function handleGridBlur(e: FocusEvent<HTMLTableElement>) { gridHadFocus.current = e.currentTarget.contains(e.relatedTarget as Node | null); }

  const editingKey = mode === 'edit' && activeDay?.editable ? `${activeDay.row.r}:${activeDay.d}` : null;
  const weekLabel = (w: number[]) => {
    const first = addDays(periodStart, w[0]);
    const last = addDays(periodStart, w[w.length - 1]);
    return w.length === 1 ? formatCalendarDate(first, 'MMM D') : `${formatCalendarDate(first, 'MMM D')} – ${formatCalendarDate(last, first.slice(0, 7) === last.slice(0, 7) ? 'D' : 'MMM D')}`;
  };

  return (
    <div className={styles.gridArea}>
      <div className={styles.noteBar}>
        <Button
          variant="default"
          size="sm"
          leftSection={<Icons.note size={16} />}
          aria-label={activeDay ? `${noteVerb} note, ${activeDay.row.cc.name}, ${formatCalendarDate(addDays(periodStart, activeDay.d), 'ddd MMM D')}` : undefined}
          aria-disabled={activeDay ? undefined : 'true'}
          aria-describedby={activeDay ? undefined : `${gridId}-note-why`}
          onClick={() => { if (activeDay) openNote(activeDay.row, activeDay.d); }}
        >
          {noteVerb} note
        </Button>
        {!activeDay && <span id={`${gridId}-note-why`} className={styles.reason}>Choose a day cell first</span>}
      </div>
      {/* Always a Select, whatever the number of weeks: a SegmentedControl clipped its labels at 320 px (UX-TIMESHEET-B-AUDIT M4). */}
      {narrow && weeks.length > 1 && (
        <Select
          label="Week"
          size="sm"
          value={String(requestedWeek)}
          allowDeselect={false}
          onChange={(v) => { if (v !== null) setRequested({ r: active.r, c: weeks[Number(v)][0] }); }}
          data={weeks.map((w, i) => ({ value: String(i), label: weekLabel(w) }))}
        />
      )}
      <div className={styles.hint} aria-hidden="true">Arrows move · type a number to enter hours · N adds a note · Esc undoes the cell</div>
      <div className={styles.scroller} data-view={narrow ? 'week' : 'full'} style={{ ['--ts-rh' as string]: 'clamp(9rem, 28vw, 16rem)' }}>
        <table role="grid" id={tableId} className={styles.grid} aria-labelledby={`${gridId}-cap`} aria-describedby={`${gridId}-keys`} onKeyDown={handleKeyDown} onClick={handleClick} onFocus={handleGridFocus} onBlur={handleGridBlur}>
          <caption id={`${gridId}-cap`} className={styles.srOnly}>Hours for {periodWords(periodStart, periodEnd)}, {STATUS_WORD[periodStatus]}</caption>
          <thead>
            <tr>
              <th scope="col" className={[styles.corner, styles.colHead].join(' ')}>Charge code</th>
              {days.map((day) => (
                <DayHeader key={day.d} gridId={gridId} d={day.d} date={day.date} isToday={day.isToday} weekend={day.weekend} hours={dayTotals[day.d]} noHoursLogged={day.noHours} />
              ))}
              <th scope="col" id={`${gridId}-ch-total`} className={[styles.colHead, styles.totalHead].join(' ')}>Total</th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.label}>
              <tr className={styles.groupRow}>
                <th scope="rowgroup" colSpan={visibleDays.length + 2}>{group.label}</th>
              </tr>
              {group.codes.map((cc) => {
                const row = rows.get(cc.id)!;
                return (
                  <tr key={cc.id}>
                    <RowHeaderCell gridId={gridId} rowKey={cc.id} r={row.r} code={cc.clin} name={cc.name} closed={!cc.assignable} isActive={isActive(row.r, RH)} />
                    {days.map((day) => {
                      const key = `${cc.id}-${day.d}`;
                      const info = dayCell(row, day.d);
                      const editing = editingKey === `${row.r}:${day.d}`;
                      return (
                        <HourCell
                          key={day.d}
                          r={row.r}
                          c={day.d}
                          rowKey={cc.id}
                          gridId={gridId}
                          value={row.hours[day.d]}
                          savedValue={row.saved[day.d]}
                          editable={info.editable}
                          whyId={info.whyKey ? why[info.whyKey] : null}
                          hasNote={Boolean(notes[key]?.trim())}
                          provenanceId={row.provenance[day.d] ? `${gridId}-prov-${row.r}-${day.d}` : null}
                          isActive={isActive(row.r, day.d)}
                          unsaved={dirty.has(key)}
                          editor={editing ? (
                            <CellEditor gridId={gridId} rowKey={cc.id} d={day.d} draft={draft} invalid={error !== null} onChange={handleDraftChange} onBlur={handleEditorBlur} />
                          ) : null}
                          future={day.future}
                          weekend={day.weekend}
                          today={day.isToday}
                          closedEmpty={info.closed}
                        />
                      );
                    })}
                    <TotalCell r={row.r} c={TOTAL} value={row.total} isActive={isActive(row.r, TOTAL)} whyId={why.total} />
                  </tr>
                );
              })}
            </tbody>
          ))}
          <tfoot>
            <tr>
              <th scope="row" id={`${gridId}-rh-foot`} data-r="foot" data-c={RH} tabIndex={isActive('foot', RH) ? 0 : -1} className={[styles.cell, styles.rowHeader].join(' ')}>Daily total</th>
              {days.map((day) => (
                <TotalCell key={day.d} r="foot" c={day.d as never} value={dayTotals[day.d]} isActive={isActive('foot', day.d)} whyId={why.total}
                  srExtra={day.noHours ? ', no hours, past workday' : undefined} weekend={day.weekend} today={day.isToday} />
              ))}
              <TotalCell r="foot" c={TOTAL} value={grand} isActive={isActive('foot', TOTAL)} whyId={why.total} grand />
            </tr>
          </tfoot>
        </table>
        <p id={`${gridId}-keys`} className={styles.srOnly}>Arrow keys move between days and codes. Type a number to enter hours. Press N to add a note. Escape undoes the cell.</p>
        <div hidden>
          <span id={why.future}>{reasonText.future}</span>
          <span id={why.closed}>{reasonText.closed}</span>
          <span id={why.locked}>{reasonText.locked}</span>
          <span id={why.readonly}>{reasonText.readonly}</span>
          <span id={why.total}>{TOTALS_CALCULATED}</span>
          {rowList.flatMap((row) => row.provenance.map((p, d) => (p ? <span key={`${row.r}-${d}`} id={`${gridId}-prov-${row.r}-${d}`}>{p}</span> : null)))}
        </div>
      </div>
      {error && <div id={`${gridId}-err`} className={styles.err}>{error}</div>}
    </div>
  );
}
