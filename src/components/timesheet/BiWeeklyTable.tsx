'use client';

import { useMemo, useRef, useState, useEffect } from 'react';
import { Text } from '@mantine/core';
import dayjs from 'dayjs';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import { ChargeCodeCell } from '@/components/timesheet/cells/ChargeCodeCell';
import { HourCell } from '@/components/timesheet/cells/HourCell';
import { TotalHoursCell } from '@/components/timesheet/cells/TotalHoursCell';
import { ColumnHeaderDate } from '@/components/timesheet/cells/ColumnHeaderDate';
import { getNumDaysInPeriod } from '@/lib/date-utils';
import styles from './Timesheet.module.css';

export type Density = 'comfortable' | 'compact' | 'dense';

// Fixed column widths (px). Day columns get all remaining space via 1fr.
const CC_WIDTH_COMFORTABLE = 240;
const CC_WIDTH_DENSE = 180;
const TOTAL_WIDTH = 72;

function getDensity(perDayPx: number): Density {
  if (perDayPx >= 52) return 'comfortable';
  if (perDayPx >= 36) return 'compact';
  return 'dense';
}

function formatFooterHours(value: number, density: Density): string {
  if (density === 'dense') {
    return value === Math.floor(value) ? String(Math.floor(value)) : value.toFixed(1);
  }
  return value.toFixed(2);
}

export function BiWeeklyTable() {
  const { state } = useTimesheet();
  const { chargeCodes, entries, periodStart } = state;
  const numDays = getNumDaysInPeriod(periodStart, state.periodConfig);

  // Measure container width for density calculation
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ccWidth = containerWidth < 900 ? CC_WIDTH_DENSE : CC_WIDTH_COMFORTABLE;
  const perDayPx = containerWidth > 0
    ? (containerWidth - ccWidth - TOTAL_WIDTH) / numDays
    : 52; // default comfortable until measured
  const density = getDensity(perDayPx);

  // Compute daily totals and missing-hours flags
  const { dailyTotals, dailyHasMissing } = useMemo(() => {
    const hasChargeCodes = chargeCodes.length > 0;
    const totals: number[] = Array(numDays).fill(0);
    const missing: boolean[] = Array(numDays).fill(false);

    for (let i = 0; i < numDays; i++) {
      let dayTotal = 0;
      for (const entry of entries) {
        dayTotal += (entry.hours ?? [])[i] ?? 0;
      }
      totals[i] = dayTotal;

      if (hasChargeCodes) {
        const date = dayjs(periodStart).add(i, 'day');
        const dow = date.day();
        const isWeekday = dow >= 1 && dow <= 5;
        const isPast = date.isBefore(dayjs(), 'day');
        missing[i] = isWeekday && isPast && dayTotal === 0;
      }
    }
    return { dailyTotals: totals, dailyHasMissing: missing };
  }, [entries, numDays, periodStart, chargeCodes.length]);

  const grandTotal = useMemo(
    () => entries.reduce((sum, e) => sum + (e.hours ?? []).reduce((a, b) => a + (b ?? 0), 0), 0),
    [entries]
  );

  // CSS grid template
  const gridTemplateColumns = `${ccWidth}px repeat(${numDays}, minmax(0, 1fr)) ${TOTAL_WIDTH}px`;

  return (
    <div className={styles.gridWrapper} ref={containerRef}>
      <div
        className={styles.grid}
        style={{ gridTemplateColumns }}
        role="table"
        aria-label="Timesheet"
      >
        {/* ── HEADER ROW ── */}
        <div className={styles.headerCellCC} role="columnheader">
          <Text fw={700} size="sm">Charge Code</Text>
        </div>
        {Array.from({ length: numDays }, (_, i) => {
          const date = dayjs(periodStart).add(i, 'day').toDate();
          const isWeekend = dayjs(date).day() === 0 || dayjs(date).day() === 6;
          return (
            <div
              key={`hdr-${i}`}
              className={`${styles.headerCell}${isWeekend ? ' ' + styles.weekend : ''}`}
              role="columnheader"
            >
              <ColumnHeaderDate
                date={date}
                dayIndex={i}
                hasMissingHours={dailyHasMissing[i]}
                density={density}
              />
            </div>
          );
        })}
        <div className={styles.headerCellTotal} role="columnheader">
          <Text fw={700} size="sm">Total</Text>
        </div>

        {/* ── BODY ROWS ── */}
        {chargeCodes.map((cc, rowIdx) => {
          const isOdd = rowIdx % 2 === 1;
          const rowClass = isOdd ? styles.rowOdd : '';
          return [
            // Charge code cell
            <div key={`cc-${cc.id}`} className={`${styles.bodyCellCC} ${rowClass}`} role="cell">
              <ChargeCodeCell chargeCode={cc} density={density} />
            </div>,
            // Day cells
            ...Array.from({ length: numDays }, (_, i) => {
              const isWeekend = dayjs(periodStart).add(i, 'day').day() === 0
                || dayjs(periodStart).add(i, 'day').day() === 6;
              return (
                <div
                  key={`cell-${cc.id}-${i}`}
                  className={`${styles.bodyCell} ${rowClass}${isWeekend ? ' ' + styles.weekend : ''}`}
                  role="cell"
                >
                  <HourCell chargeCodeId={cc.id} dayIndex={i} density={density} />
                </div>
              );
            }),
            // Total cell
            <div key={`total-${cc.id}`} className={`${styles.bodyCellTotal} ${rowClass}`} role="cell">
              <TotalHoursCell chargeCodeId={cc.id} density={density} />
            </div>,
          ];
        })}

        {/* ── FOOTER ROW ── */}
        <div className={styles.footerCellCC} role="cell">
          <Text fw={700} size="sm">Daily Totals</Text>
        </div>
        {Array.from({ length: numDays }, (_, i) => {
          const isWeekend = dayjs(periodStart).add(i, 'day').day() === 0
            || dayjs(periodStart).add(i, 'day').day() === 6;
          return (
            <div
              key={`ftr-${i}`}
              className={`${styles.footerCell}${isWeekend ? ' ' + styles.weekend : ''}`}
              role="cell"
            >
              <Text fw={700} ta="center" size={density === 'dense' ? 'xs' : 'sm'}
                style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatFooterHours(dailyTotals[i], density)}
              </Text>
            </div>
          );
        })}
        <div className={styles.footerCellTotal} role="cell">
          <Text fw={900} ta="center" size="sm" c="signal"
            style={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatFooterHours(grandTotal, density)}
          </Text>
        </div>
      </div>
    </div>
  );
}
