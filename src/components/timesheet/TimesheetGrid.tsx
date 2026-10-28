'use client';

import { useId, useMemo, useState } from 'react';
import { useTimesheetState } from '@/components/timesheet/TimesheetContext';
import { HourCell } from '@/components/timesheet/cells/HourCell';
import { TotalCell } from '@/components/timesheet/cells/TotalCell';
import { RowHeaderCell } from '@/components/timesheet/cells/RowHeaderCell';
import { DayHeader } from '@/components/timesheet/cells/DayHeader';
import { addDays, dayOfWeek, diffDays, isAfter, isBefore, type CalendarDate } from '@/lib/calendar-date';
import { isCellEditable } from '@/lib/timesheet/cell-rules';
import { CLOSED_TO_NEW_HOURS } from '@/lib/timesheet/copy';
import { STATUS_WORD, periodWords } from '@/lib/timesheet/labels';
import { RH, TOTAL, clampPos, initialPos, type Pos } from '@/lib/timesheet/grid-positions';
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

/**
 * The accessible timesheet grid (feature-plan-ux-timesheet-ui.md §4.2): a `<table role="grid">` with a caption, column
 * and row headers, one tbody per non-empty group, a totals footer and hidden reason descriptions. Exactly one element has
 * tabIndex 0 — the ACTIVE position, derived during render by clamping the requested one (trap T-P).
 */
export function TimesheetGrid() {
  const { state, dirtyCells } = useTimesheetState();
  const gridId = useId();
  const { chargeCodes, entries, savedEntries, savedCellRevisions, periodStart, periodEnd, numDays, today, notes, userCreatedOn, periodStatus, readOnly, isLoadingPeriod } = state;
  const periodEditable = (periodStatus === 'draft' || periodStatus === 'rejected') && !readOnly && !isLoadingPeriod;
  const locked = periodStatus === 'submitted' || periodStatus === 'approved';

  // Rows precomputed once per render: Map(rowKey → row), in display order (Direct, then Indirect and leave).
  const { groups, rows, dayTotals, grand } = useMemo(() => {
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
    const totals = Array.from({ length: numDays }, (_, d) => round2([...map.values()].reduce((s, row) => s + row.hours[d], 0)));
    return {
      groups: [{ label: 'Direct', codes: direct }, { label: 'Indirect and leave', codes: indirect }].filter((g) => g.codes.length > 0),
      rows: map,
      dayTotals: totals,
      grand: round2(totals.reduce((s, h) => s + h, 0)),
    };
  }, [chargeCodes, entries, savedEntries, numDays]);

  const dirty = useMemo(() => new Set(dirtyCells.map((c) => `${c.chargeCodeId}-${c.dayIndex}`)), [dirtyCells]);
  const visibleDays = useMemo(() => Array.from({ length: numDays }, (_, d) => d), [numDays]);
  const bodyCount = rows.size;
  const todayOffset = diffDays(periodStart, today);
  const todayIndex = todayOffset >= 0 && todayOffset < numDays ? todayOffset : null;

  const [requested] = useState<Pos>(() => initialPos(bodyCount, visibleDays, todayIndex));
  const active = clampPos(requested, bodyCount, visibleDays);
  const isActive = (r: Pos['r'], c: Pos['c']) => active.r === r && active.c === c;

  const why = {
    future: `${gridId}-why-future`, closed: `${gridId}-why-closed`, locked: `${gridId}-why-locked`,
    readonly: `${gridId}-why-readonly`, total: `${gridId}-why-total`,
  };
  const days = visibleDays.map((d) => {
    const date = addDays(periodStart, d);
    const past = isBefore(date, today);
    const noHours = dayTotals[d] === 0 && past && !isWeekendDay(date) && !isBefore(date, userCreatedOn);
    return { d, date, weekend: isWeekendDay(date), isToday: date === today, future: isAfter(date, today), noHours };
  });

  return (
    <div className={styles.gridArea}>
    <div className={styles.hint} aria-hidden="true">Arrows move · type a number to enter hours · N adds a note · Esc undoes the cell</div>
    <div className={styles.scroller} style={{ ['--ts-rh' as string]: 'clamp(9rem, 28vw, 16rem)' }}>
      <table role="grid" className={styles.grid} aria-labelledby={`${gridId}-cap`} aria-describedby={`${gridId}-keys`}>
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
                  <RowHeaderCell gridId={gridId} rowKey={cc.id} r={row.r} code={cc.clin} name={cc.name} closed={!cc.assignable} isActive={isActive(row.r, 'rh')} />
                  {days.map((day) => {
                    const key = `${cc.id}-${day.d}`;
                    const priorRevision = savedCellRevisions[key] ?? 0;
                    const editable = isCellEditable({ periodEditable, isFutureDate: day.future, assignable: cc.assignable, priorRevision });
                    const closed = periodEditable && !day.future && !editable;
                    const whyId = editable ? null
                      : readOnly ? why.readonly
                        : locked ? why.locked
                          : day.future ? why.future
                            : closed ? why.closed
                              : null;
                    return (
                      <HourCell
                        key={day.d}
                        r={row.r}
                        c={day.d}
                        rowKey={cc.id}
                        gridId={gridId}
                        value={row.hours[day.d]}
                        savedValue={row.saved[day.d]}
                        editable={editable}
                        whyId={whyId}
                        hasNote={Boolean(notes[key]?.trim())}
                        provenanceId={row.provenance[day.d] ? `${gridId}-prov-${row.r}-${day.d}` : null}
                        isActive={isActive(row.r, day.d)}
                        unsaved={dirty.has(key)}
                        editor={null}
                        future={day.future}
                        weekend={day.weekend}
                        today={day.isToday}
                        closedEmpty={closed}
                      />
                    );
                  })}
                  <TotalCell r={row.r} c={TOTAL} value={row.total} isActive={isActive(row.r, 'total')} whyId={why.total} />
                </tr>
              );
            })}
          </tbody>
        ))}
        <tfoot>
          <tr>
            <th scope="row" id={`${gridId}-rh-foot`} data-r="foot" data-c={RH} tabIndex={isActive('foot', 'rh') ? 0 : -1} className={[styles.cell, styles.rowHeader].join(' ')}>Daily total</th>
            {days.map((day) => (
              <TotalCell key={day.d} r="foot" c={day.d as never} value={dayTotals[day.d]} isActive={isActive('foot', day.d)} whyId={why.total}
                srExtra={day.noHours ? ', no hours, past workday' : undefined} weekend={day.weekend} today={day.isToday} />
            ))}
            <TotalCell r="foot" c={TOTAL} value={grand} isActive={isActive('foot', 'total')} whyId={why.total} grand />
          </tr>
        </tfoot>
      </table>
      <p id={`${gridId}-keys`} className={styles.srOnly}>Arrow keys move between days and codes. Type a number to enter hours. Press N to add a note. Escape undoes the cell.</p>
      <div hidden>
        <span id={why.future}>Future date. Hours can&apos;t be entered yet.</span>
        <span id={why.closed}>{CLOSED_TO_NEW_HOURS}. You can correct hours already recorded.</span>
        <span id={why.locked}>This timesheet is {periodStatus === 'approved' ? 'approved' : 'submitted'} and can&apos;t be changed.</span>
        <span id={why.readonly}>This workspace is read-only.</span>
        <span id={why.total}>Totals are calculated.</span>
        {[...rows.values()].flatMap((row) => row.provenance.map((p, d) => (p ? <span key={`${row.r}-${d}`} id={`${gridId}-prov-${row.r}-${d}`}>{p}</span> : null)))}
      </div>
    </div>
    </div>
  );
}
