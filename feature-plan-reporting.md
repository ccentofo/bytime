# Blueprint: Reporting & Export — DCAA-Compliant Reports & Document Generation

## 1. Architectural Overview & DCAA Impact

### Why Reporting Matters

DCAA auditors require contractors to produce several standard reports:
- **Individual Timesheet Reports** — PDF copies of employee timesheets with digital signatures for each pay period
- **Incurred Cost Reports** — Labor cost summaries by contract/CLIN/LCAT for annual Incurred Cost Submissions (ICS)
- **Contract Cost Reports** — Detailed cost breakdowns for contract closeout and periodic reporting
- **Employee Time Summary** — Monthly/quarterly summaries of hours by employee across all contracts

The application has all the underlying data but no way to export it in auditor-friendly formats.

### Export Formats

| Format | Use Case | Library |
|---|---|---|
| **PDF** | Individual timesheets, signed reports | `@react-pdf/renderer` (React-based PDF generation) |
| **CSV** | Data export for Excel analysis, ICS preparation | Native (no library needed) |
| **Excel (.xlsx)** | Formatted cost reports with subtotals | `exceljs` |

### DCAA Compliance Requirements Addressed

| DCAA / FAR Requirement | How Reporting Satisfies It |
|---|---|
| **FAR 31.201-1 — Allowable Costs** | Cost reports provide traceable documentation linking hours to rates to total costs |
| **DCAA Incurred Cost Submission** | Period cost reports generate the Schedule H (labor) data needed for annual ICS filings |
| **Audit Documentation** | PDF timesheets with certification statements serve as auditable records |
| **Record Retention** | Exported documents can be archived per FAR 4.703 (3-year retention requirement) |
| **CAS 418 — Cost Accounting** | Reports show labor costs allocated by the same rates used in the system, proving consistency |

---

## 2. File Topology

```
Files to CREATE:
├── src/server/actions/reports.ts                    ← Server Actions: report data queries
├── src/lib/reports/
│   ├── csv-generator.ts                             ← CSV string generation utilities
│   ├── timesheet-pdf.tsx                            ← React PDF template for individual timesheets
│   └── cost-report-excel.ts                         ← Excel workbook generation for cost reports
│
├── src/app/(app)/admin/reports/
│   ├── page.tsx                                     ← Server Component: Reports page
│   ├── ReportsClient.tsx                            ← Client Component: report selection + generation UI
│   └── Reports.module.css                           ← Module CSS for MRT table header styling
│
├── src/app/api/reports/
│   ├── timesheet-pdf/route.ts                       ← API route: generate & stream PDF
│   ├── cost-report-csv/route.ts                     ← API route: generate & stream CSV
│   └── cost-report-xlsx/route.ts                    ← API route: generate & stream Excel

Files to MODIFY:
├── src/components/shell/AppNavbar.tsx                ← Add "Reports" nav link
├── package.json                                     ← Add @react-pdf/renderer, exceljs

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                                 ← ❌ DO NOT MODIFY
├── src/auth.ts                                      ← ❌ DO NOT MODIFY
├── src/middleware.ts                                 ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/dashboard.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                    ← ❌ DO NOT MODIFY
├── src/components/timesheet/*                       ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/dashboard/*                  ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/approvals/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/audit-trail/*                 ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/users/*                       ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/*                 ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/labor-categories/*             ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify any files listed in the "DO NOT MODIFY" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`, `@mantine/dates`, `@mantine/notifications`).
> - Use **Mantine React Table v2** (`mantine-react-table`) for any data grids.
> - Use **Drizzle ORM** for all database queries.
> - Follow the step order exactly. Each step builds on the previous one.
> - **After completing each phase, run `npm run build` to verify zero errors.**

---

### Phase A: Install Dependencies (A1)

#### A1. Install report generation libraries

```bash
npm install @react-pdf/renderer exceljs
```

---

### Phase B: Report Data Queries (B1)

#### B1. Create `src/server/actions/reports.ts`

```typescript
'use server';

import { db } from '@/db';
import {
  users,
  contracts,
  clins,
  slins,
  timesheetEntries,
  timesheetPeriods,
  laborCategories,
  userLaborCategories,
  userAssignments,
} from '@/db/schema';
import { eq, and, gte, lt, desc, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import { getNumDaysInPeriod } from '@/lib/date-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimesheetReportData {
  employee: {
    id: string;
    fullName: string;
    email: string;
  };
  periodStart: Date;
  periodEnd: Date;
  periodStatus: string;
  submittedAt: Date | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  chargeCodes: Array<{
    clinNumber: string;
    contractName: string;
    contractNumber: string;
    slinNumber: string | null;
    description: string;
    dailyHours: number[]; // one per day in the period
    totalHours: number;
  }>;
  dailyTotals: number[]; // sum of all charge codes per day
  grandTotal: number;
}

export interface CostReportEntry {
  employeeName: string;
  employeeEmail: string;
  contractName: string;
  contractNumber: string;
  clinNumber: string;
  slinNumber: string | null;
  lcatCode: string;
  lcatTitle: string;
  hourlyRate: number;
  totalHours: number;
  totalCost: number;
  entryDate: string; // YYYY-MM-DD
}

export interface EmployeeSummaryEntry {
  employeeName: string;
  contractName: string;
  contractNumber: string;
  clinNumber: string;
  totalHours: number;
  totalCost: number;
}

// ---------------------------------------------------------------------------
// Individual Timesheet Report
// ---------------------------------------------------------------------------

/**
 * Get complete timesheet data for a specific user and period.
 * Used to generate the PDF timesheet report.
 */
export async function getTimesheetReportData(
  userId: string,
  periodStart: Date
): Promise<TimesheetReportData | null> {
  // Get user info
  const [user] = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) return null;

  // Get period info
  const numDays = getNumDaysInPeriod(periodStart);
  const periodEnd = dayjs(periodStart).add(numDays - 1, 'day').toDate();

  const periodRows = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, userId),
        eq(timesheetPeriods.periodStart, periodStart),
      )
    );

  const period = periodRows[0];

  // Get approved-by name if applicable
  let approvedByName: string | null = null;
  if (period?.reviewedBy) {
    const [reviewer] = await db
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, period.reviewedBy));
    approvedByName = reviewer?.fullName ?? null;
  }

  // Get user's charge codes
  const assignments = await db
    .select({
      clinId: clins.id,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      description: clins.description,
      slinId: userAssignments.slinId,
      slinNumber: slins.slinNumber,
    })
    .from(userAssignments)
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(userAssignments.slinId, slins.id))
    .where(
      and(
        eq(userAssignments.userId, userId),
        eq(userAssignments.isActive, true),
      )
    )
    .orderBy(contracts.name, clins.clinNumber);

  // Get all entries for this period (latest revision only)
  const entries = await db
    .select({
      clinId: timesheetEntries.clinId,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
    })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        gte(timesheetEntries.entryDate, periodStart),
        lt(timesheetEntries.entryDate, dayjs(periodStart).add(numDays, 'day').toDate()),
        eq(
          timesheetEntries.revisionNumber,
          sql`(
            SELECT MAX(te2.revision_number)
            FROM timesheet_entries te2
            WHERE te2.user_id = ${timesheetEntries.userId}
              AND te2.clin_id = ${timesheetEntries.clinId}
              AND te2.entry_date = ${timesheetEntries.entryDate}
          )`
        ),
      )
    );

  // Build hours map: "clinId-dayIndex" → hours
  const hoursMap = new Map<string, number>();
  for (const entry of entries) {
    const dayIndex = dayjs(entry.entryDate).diff(dayjs(periodStart), 'day');
    hoursMap.set(`${entry.clinId}-${dayIndex}`, parseFloat(entry.hours) || 0);
  }

  // Build charge code data
  const chargeCodes = assignments.map((a) => {
    const dailyHours: number[] = [];
    let totalHours = 0;
    for (let i = 0; i < numDays; i++) {
      const h = hoursMap.get(`${a.clinId}-${i}`) ?? 0;
      dailyHours.push(h);
      totalHours += h;
    }
    return {
      clinNumber: a.clinNumber,
      contractName: a.contractName,
      contractNumber: a.contractNumber,
      slinNumber: a.slinNumber,
      description: a.description ?? '',
      dailyHours,
      totalHours: Math.round(totalHours * 100) / 100,
    };
  });

  // Daily totals
  const dailyTotals: number[] = [];
  for (let i = 0; i < numDays; i++) {
    let dayTotal = 0;
    for (const cc of chargeCodes) {
      dayTotal += cc.dailyHours[i];
    }
    dailyTotals.push(Math.round(dayTotal * 100) / 100);
  }

  const grandTotal = chargeCodes.reduce((sum, cc) => sum + cc.totalHours, 0);

  return {
    employee: user,
    periodStart,
    periodEnd,
    periodStatus: period?.status ?? 'draft',
    submittedAt: period?.submittedAt ?? null,
    approvedAt: period?.reviewedAt ?? null,
    approvedBy: approvedByName,
    chargeCodes,
    dailyTotals,
    grandTotal: Math.round(grandTotal * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Cost Report (Detailed)
// ---------------------------------------------------------------------------

/**
 * Get detailed cost report for a date range.
 * Each row = one employee + one CLIN + one day with hours and cost.
 */
export async function getDetailedCostReport(
  startDate: Date,
  endDate: Date,
  contractId?: string
): Promise<CostReportEntry[]> {
  const endDateExclusive = dayjs(endDate).add(1, 'day').toDate();

  const conditions = [
    gte(timesheetEntries.entryDate, startDate),
    lt(timesheetEntries.entryDate, endDateExclusive),
    eq(
      timesheetEntries.revisionNumber,
      sql`(
        SELECT MAX(te2.revision_number)
        FROM timesheet_entries te2
        WHERE te2.user_id = ${timesheetEntries.userId}
          AND te2.clin_id = ${timesheetEntries.clinId}
          AND te2.entry_date = ${timesheetEntries.entryDate}
      )`
    ),
  ];

  if (contractId) {
    conditions.push(eq(contracts.id, contractId));
  }

  const rows = await db
    .select({
      employeeName: users.fullName,
      employeeEmail: users.email,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      clinNumber: clins.clinNumber,
      slinNumber: slins.slinNumber,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
      lcatCode: laborCategories.lcatCode,
      lcatTitle: laborCategories.title,
      hourlyRate: laborCategories.hourlyRate,
    })
    .from(timesheetEntries)
    .innerJoin(users, eq(timesheetEntries.userId, users.id))
    .innerJoin(clins, eq(timesheetEntries.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(timesheetEntries.slinId, slins.id))
    .leftJoin(
      userLaborCategories,
      and(
        eq(userLaborCategories.userId, timesheetEntries.userId),
        sql`${userLaborCategories.effectiveDate} <= ${timesheetEntries.entryDate}`,
        sql`(${userLaborCategories.endDate} IS NULL OR ${userLaborCategories.endDate} > ${timesheetEntries.entryDate})`,
      )
    )
    .leftJoin(
      laborCategories,
      and(
        eq(laborCategories.id, userLaborCategories.laborCategoryId),
        eq(laborCategories.clinId, timesheetEntries.clinId),
        eq(laborCategories.status, 'active'),
      )
    )
    .where(and(...conditions))
    .orderBy(contracts.name, clins.clinNumber, users.fullName, timesheetEntries.entryDate);

  return rows.map((row) => {
    const hours = parseFloat(row.hours) || 0;
    const rate = parseFloat(row.hourlyRate ?? '0') || 0;
    return {
      employeeName: row.employeeName,
      employeeEmail: row.employeeEmail,
      contractName: row.contractName,
      contractNumber: row.contractNumber,
      clinNumber: row.clinNumber,
      slinNumber: row.slinNumber,
      lcatCode: row.lcatCode ?? '—',
      lcatTitle: row.lcatTitle ?? 'No LCAT',
      hourlyRate: rate,
      totalHours: Math.round(hours * 100) / 100,
      totalCost: Math.round(hours * rate * 100) / 100,
      entryDate: dayjs(row.entryDate).format('YYYY-MM-DD'),
    };
  });
}

// ---------------------------------------------------------------------------
// Employee Summary Report
// ---------------------------------------------------------------------------

/**
 * Get aggregated hours/cost summary per employee per contract/CLIN.
 */
export async function getEmployeeSummaryReport(
  startDate: Date,
  endDate: Date
): Promise<EmployeeSummaryEntry[]> {
  const endDateExclusive = dayjs(endDate).add(1, 'day').toDate();

  const rows = await db
    .select({
      employeeName: users.fullName,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      clinNumber: clins.clinNumber,
      totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
      totalCost: sql<number>`COALESCE(SUM(
        CAST(${timesheetEntries.hours} AS NUMERIC) *
        COALESCE(CAST(${laborCategories.hourlyRate} AS NUMERIC), 0)
      ), 0)`,
    })
    .from(timesheetEntries)
    .innerJoin(users, eq(timesheetEntries.userId, users.id))
    .innerJoin(clins, eq(timesheetEntries.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(
      userLaborCategories,
      and(
        eq(userLaborCategories.userId, timesheetEntries.userId),
        sql`${userLaborCategories.effectiveDate} <= ${timesheetEntries.entryDate}`,
        sql`(${userLaborCategories.endDate} IS NULL OR ${userLaborCategories.endDate} > ${timesheetEntries.entryDate})`,
      )
    )
    .leftJoin(
      laborCategories,
      and(
        eq(laborCategories.id, userLaborCategories.laborCategoryId),
        eq(laborCategories.clinId, timesheetEntries.clinId),
        eq(laborCategories.status, 'active'),
      )
    )
    .where(
      and(
        gte(timesheetEntries.entryDate, startDate),
        lt(timesheetEntries.entryDate, endDateExclusive),
        eq(
          timesheetEntries.revisionNumber,
          sql`(
            SELECT MAX(te2.revision_number)
            FROM timesheet_entries te2
            WHERE te2.user_id = ${timesheetEntries.userId}
              AND te2.clin_id = ${timesheetEntries.clinId}
              AND te2.entry_date = ${timesheetEntries.entryDate}
          )`
        ),
      )
    )
    .groupBy(users.fullName, contracts.name, contracts.contractNumber, clins.clinNumber)
    .orderBy(users.fullName, contracts.name, clins.clinNumber);

  return rows.map((row) => ({
    employeeName: row.employeeName,
    contractName: row.contractName,
    contractNumber: row.contractNumber,
    clinNumber: row.clinNumber,
    totalHours: Math.round(Number(row.totalHours) * 100) / 100,
    totalCost: Math.round(Number(row.totalCost) * 100) / 100,
  }));
}

// ---------------------------------------------------------------------------
// Available Users & Contracts for Report Filters
// ---------------------------------------------------------------------------

export async function getReportFilterOptions() {
  const allUsers = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.isActive, true))
    .orderBy(users.fullName);

  const allContracts = await db
    .select({ id: contracts.id, name: contracts.name, contractNumber: contracts.contractNumber })
    .from(contracts)
    .orderBy(contracts.name);

  return { users: allUsers, contracts: allContracts };
}
```

---

### Phase C: CSV Generator Utility (C1)

#### C1. Create `src/lib/reports/csv-generator.ts`

```typescript
/**
 * Generate a CSV string from an array of objects.
 * Handles escaping commas, quotes, and newlines per RFC 4180.
 */
export function generateCsv<T extends Record<string, unknown>>(
  data: T[],
  columns: { key: keyof T; header: string }[]
): string {
  const header = columns.map((c) => escapeCSV(c.header)).join(',');

  const rows = data.map((row) =>
    columns.map((c) => escapeCSV(String(row[c.key] ?? ''))).join(',')
  );

  return [header, ...rows].join('\n');
}

function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Create a downloadable blob from CSV content.
 */
export function csvToBlob(csvContent: string): Blob {
  return new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
}
```

---

### Phase D: Excel Generator (D1)

#### D1. Create `src/lib/reports/cost-report-excel.ts`

```typescript
import ExcelJS from 'exceljs';
import type { CostReportEntry, EmployeeSummaryEntry } from '@/server/actions/reports';

/**
 * Generate an Excel workbook with detailed cost report data.
 * Returns a Buffer that can be streamed to the client.
 */
export async function generateCostReportExcel(
  data: CostReportEntry[],
  reportTitle: string,
  dateRange: string
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ByTime';
  workbook.created = new Date();

  // --- Sheet 1: Detailed Entries ---
  const detailSheet = workbook.addWorksheet('Detailed Cost Report');

  // Title row
  detailSheet.mergeCells('A1:K1');
  const titleCell = detailSheet.getCell('A1');
  titleCell.value = `${reportTitle} — ${dateRange}`;
  titleCell.font = { bold: true, size: 14 };

  // Subtitle
  detailSheet.mergeCells('A2:K2');
  detailSheet.getCell('A2').value = `Generated: ${new Date().toLocaleDateString('en-US', { dateStyle: 'full' })}`;
  detailSheet.getCell('A2').font = { italic: true, size: 10, color: { argb: '666666' } };

  // Headers
  const headers = [
    'Employee', 'Contract', 'Contract #', 'CLIN', 'SLIN',
    'LCAT Code', 'LCAT Title', 'Rate ($/hr)', 'Date', 'Hours', 'Cost ($)',
  ];

  const headerRow = detailSheet.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'E8E8E8' },
  };

  // Data rows
  for (const entry of data) {
    detailSheet.addRow([
      entry.employeeName,
      entry.contractName,
      entry.contractNumber,
      entry.clinNumber,
      entry.slinNumber ?? '',
      entry.lcatCode,
      entry.lcatTitle,
      entry.hourlyRate,
      entry.entryDate,
      entry.totalHours,
      entry.totalCost,
    ]);
  }

  // Totals row
  const totalHours = data.reduce((sum, e) => sum + e.totalHours, 0);
  const totalCost = data.reduce((sum, e) => sum + e.totalCost, 0);
  const totalsRow = detailSheet.addRow([
    'TOTALS', '', '', '', '', '', '', '', '',
    Math.round(totalHours * 100) / 100,
    Math.round(totalCost * 100) / 100,
  ]);
  totalsRow.font = { bold: true };

  // Column widths
  detailSheet.columns = [
    { width: 20 }, { width: 25 }, { width: 18 }, { width: 10 }, { width: 10 },
    { width: 12 }, { width: 25 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 14 },
  ];

  // Format currency columns
  detailSheet.getColumn(8).numFmt = '$#,##0.00';
  detailSheet.getColumn(11).numFmt = '$#,##0.00';
  detailSheet.getColumn(10).numFmt = '#,##0.00';

  // Generate buffer
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Generate an Excel workbook with employee summary data.
 */
export async function generateEmployeeSummaryExcel(
  data: EmployeeSummaryEntry[],
  dateRange: string
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ByTime';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Employee Summary');

  // Title
  sheet.mergeCells('A1:F1');
  sheet.getCell('A1').value = `Employee Summary Report — ${dateRange}`;
  sheet.getCell('A1').font = { bold: true, size: 14 };

  // Headers
  const headers = ['Employee', 'Contract', 'Contract #', 'CLIN', 'Total Hours', 'Total Cost ($)'];
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'E8E8E8' },
  };

  // Data
  for (const entry of data) {
    sheet.addRow([
      entry.employeeName,
      entry.contractName,
      entry.contractNumber,
      entry.clinNumber,
      entry.totalHours,
      entry.totalCost,
    ]);
  }

  // Totals
  const totalHours = data.reduce((sum, e) => sum + e.totalHours, 0);
  const totalCost = data.reduce((sum, e) => sum + e.totalCost, 0);
  const totalsRow = sheet.addRow([
    'TOTALS', '', '', '',
    Math.round(totalHours * 100) / 100,
    Math.round(totalCost * 100) / 100,
  ]);
  totalsRow.font = { bold: true };

  // Widths
  sheet.columns = [
    { width: 22 }, { width: 28 }, { width: 18 }, { width: 12 }, { width: 14 }, { width: 16 },
  ];

  sheet.getColumn(5).numFmt = '#,##0.00';
  sheet.getColumn(6).numFmt = '$#,##0.00';

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
```

---

### Phase E: PDF Timesheet Template (E1)

#### E1. Create `src/lib/reports/timesheet-pdf.tsx`

```tsx
import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import type { TimesheetReportData } from '@/server/actions/reports';
import dayjs from 'dayjs';

const styles = StyleSheet.create({
  page: { padding: 30, fontSize: 9, fontFamily: 'Helvetica' },
  header: { marginBottom: 20 },
  title: { fontSize: 16, fontWeight: 'bold', marginBottom: 4 },
  subtitle: { fontSize: 10, color: '#666', marginBottom: 2 },
  table: { marginTop: 10 },
  tableRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderColor: '#ccc', minHeight: 18 },
  tableHeader: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#000', backgroundColor: '#f0f0f0', minHeight: 22 },
  chargeCodeCell: { width: 120, padding: 3, borderRightWidth: 0.5, borderColor: '#ccc' },
  dayCell: { width: 32, padding: 3, textAlign: 'center', borderRightWidth: 0.5, borderColor: '#ccc' },
  totalCell: { width: 45, padding: 3, textAlign: 'center', fontWeight: 'bold' },
  bold: { fontWeight: 'bold' },
  certification: { marginTop: 30, borderTopWidth: 1, borderColor: '#000', paddingTop: 10 },
  certText: { fontSize: 8, marginBottom: 8, lineHeight: 1.4 },
  signatureLine: { flexDirection: 'row', marginTop: 20, justifyContent: 'space-between' },
  sigBlock: { width: '45%', borderTopWidth: 1, borderColor: '#000', paddingTop: 4 },
  footer: { position: 'absolute', bottom: 20, left: 30, right: 30, fontSize: 7, color: '#999', textAlign: 'center' },
  statusBadge: { fontSize: 10, padding: '2 6', borderRadius: 3, marginLeft: 10 },
});

type Props = {
  data: TimesheetReportData;
};

export function TimesheetPdfDocument({ data }: Props) {
  const periodLabel = `${dayjs(data.periodStart).format('MMM D')} – ${dayjs(data.periodEnd).format('MMM D, YYYY')}`;
  const numDays = data.dailyTotals.length;

  return (
    <Document>
      <Page size="LETTER" orientation="landscape" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>ByTime — Semi-Monthly Timesheet</Text>
          <Text style={styles.subtitle}>Employee: {data.employee.fullName} ({data.employee.email})</Text>
          <Text style={styles.subtitle}>Pay Period: {periodLabel}</Text>
          <Text style={styles.subtitle}>
            Status: {data.periodStatus.toUpperCase()}
            {data.submittedAt && ` | Submitted: ${dayjs(data.submittedAt).format('MMM D, YYYY h:mm A')}`}
            {data.approvedAt && ` | Approved: ${dayjs(data.approvedAt).format('MMM D, YYYY h:mm A')} by ${data.approvedBy}`}
          </Text>
        </View>

        {/* Table */}
        <View style={styles.table}>
          {/* Day headers */}
          <View style={styles.tableHeader}>
            <Text style={[styles.chargeCodeCell, styles.bold]}>Charge Code</Text>
            {Array.from({ length: numDays }, (_, i) => {
              const d = dayjs(data.periodStart).add(i, 'day');
              return (
                <Text key={i} style={[styles.dayCell, styles.bold]}>
                  {d.format('M/D')}
                </Text>
              );
            })}
            <Text style={[styles.totalCell, styles.bold]}>Total</Text>
          </View>

          {/* Data rows */}
          {data.chargeCodes.map((cc, rowIdx) => (
            <View key={rowIdx} style={styles.tableRow}>
              <Text style={styles.chargeCodeCell}>
                {cc.clinNumber} — {cc.contractName}
              </Text>
              {cc.dailyHours.map((h, dayIdx) => (
                <Text key={dayIdx} style={styles.dayCell}>
                  {h === 0 ? '—' : h.toFixed(2)}
                </Text>
              ))}
              <Text style={styles.totalCell}>{cc.totalHours.toFixed(2)}</Text>
            </View>
          ))}

          {/* Daily totals row */}
          <View style={[styles.tableRow, { borderTopWidth: 1, borderColor: '#000' }]}>
            <Text style={[styles.chargeCodeCell, styles.bold]}>Daily Total</Text>
            {data.dailyTotals.map((t, i) => (
              <Text key={i} style={[styles.dayCell, styles.bold]}>
                {t === 0 ? '—' : t.toFixed(2)}
              </Text>
            ))}
            <Text style={[styles.totalCell, styles.bold]}>{data.grandTotal.toFixed(2)}</Text>
          </View>
        </View>

        {/* DCAA Certification Statement */}
        <View style={styles.certification}>
          <Text style={[styles.certText, styles.bold]}>Employee Certification:</Text>
          <Text style={styles.certText}>
            I certify that the hours recorded on this timesheet are a true and accurate representation
            of the time I worked during this pay period. I understand that any misrepresentation of
            time charges may result in disciplinary action and/or criminal prosecution under 18 U.S.C. § 1001.
          </Text>

          <View style={styles.signatureLine}>
            <View style={styles.sigBlock}>
              <Text>Employee: {data.employee.fullName}</Text>
              {data.submittedAt && (
                <Text style={{ fontSize: 7, color: '#666' }}>
                  Digitally signed: {dayjs(data.submittedAt).format('MMM D, YYYY h:mm A')}
                </Text>
              )}
            </View>
            <View style={styles.sigBlock}>
              <Text>Supervisor: {data.approvedBy ?? '___________________________'}</Text>
              {data.approvedAt && (
                <Text style={{ fontSize: 7, color: '#666' }}>
                  Digitally signed: {dayjs(data.approvedAt).format('MMM D, YYYY h:mm A')}
                </Text>
              )}
            </View>
          </View>
        </View>

        {/* Footer */}
        <Text style={styles.footer}>
          Generated by ByTime on {dayjs().format('MMM D, YYYY h:mm A')} — DCAA Compliant Timesheet Record
        </Text>
      </Page>
    </Document>
  );
}
```

---

### Phase F: API Routes for File Downloads (F1–F3)

#### F1. Create `src/app/api/reports/timesheet-pdf/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { auth } from '@/auth';
import { getTimesheetReportData } from '@/server/actions/reports';
import { TimesheetPdfDocument } from '@/lib/reports/timesheet-pdf';
import React from 'react';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('userId');
  const periodStart = searchParams.get('periodStart');

  if (!userId || !periodStart) {
    return NextResponse.json({ error: 'Missing userId or periodStart' }, { status: 400 });
  }

  const data = await getTimesheetReportData(userId, new Date(periodStart));
  if (!data) {
    return NextResponse.json({ error: 'No data found' }, { status: 404 });
  }

  const pdfBuffer = await renderToBuffer(
    React.createElement(TimesheetPdfDocument, { data })
  );

  return new NextResponse(pdfBuffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="timesheet-${data.employee.fullName.replace(/\s+/g, '-')}-${periodStart}.pdf"`,
    },
  });
}
```

#### F2. Create `src/app/api/reports/cost-report-csv/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDetailedCostReport } from '@/server/actions/reports';
import { generateCsv } from '@/lib/reports/csv-generator';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const contractId = searchParams.get('contractId');

  if (!startDate || !endDate) {
    return NextResponse.json({ error: 'Missing startDate or endDate' }, { status: 400 });
  }

  const data = await getDetailedCostReport(
    new Date(startDate),
    new Date(endDate),
    contractId ?? undefined
  );

  const csv = generateCsv(data, [
    { key: 'employeeName', header: 'Employee' },
    { key: 'contractName', header: 'Contract' },
    { key: 'contractNumber', header: 'Contract Number' },
    { key: 'clinNumber', header: 'CLIN' },
    { key: 'slinNumber', header: 'SLIN' },
    { key: 'lcatCode', header: 'LCAT Code' },
    { key: 'lcatTitle', header: 'LCAT Title' },
    { key: 'hourlyRate', header: 'Rate ($/hr)' },
    { key: 'entryDate', header: 'Date' },
    { key: 'totalHours', header: 'Hours' },
    { key: 'totalCost', header: 'Cost ($)' },
  ]);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="cost-report-${startDate}-to-${endDate}.csv"`,
    },
  });
}
```

#### F3. Create `src/app/api/reports/cost-report-xlsx/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDetailedCostReport } from '@/server/actions/reports';
import { generateCostReportExcel } from '@/lib/reports/cost-report-excel';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const contractId = searchParams.get('contractId');

  if (!startDate || !endDate) {
    return NextResponse.json({ error: 'Missing startDate or endDate' }, { status: 400 });
  }

  const data = await getDetailedCostReport(
    new Date(startDate),
    new Date(endDate),
    contractId ?? undefined
  );

  const dateRange = `${startDate} to ${endDate}`;
  const buffer = await generateCostReportExcel(data, 'Cost Report', dateRange);

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="cost-report-${startDate}-to-${endDate}.xlsx"`,
    },
  });
}
```

---

### Phase G: Reports Admin Page (G1–G3)

#### G1. Create `src/app/(app)/admin/reports/Reports.module.css`

```css
.tableHeaderCell button {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
```

#### G2. Create `src/app/(app)/admin/reports/page.tsx`

```typescript
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getReportFilterOptions } from '@/server/actions/reports';
import { ReportsClient } from './ReportsClient';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');

  const filterOptions = await getReportFilterOptions();

  return <ReportsClient filterOptions={filterOptions} />;
}
```

#### G3. Create `src/app/(app)/admin/reports/ReportsClient.tsx`

This is a `'use client'` component with three sections:

**Section A — Individual Timesheet PDF:**
- Select an employee and period start date
- "Download PDF" button triggers a download from `/api/reports/timesheet-pdf`

**Section B — Cost Report (CSV/Excel):**
- Date range selector (start date, end date)
- Optional contract filter
- "Download CSV" and "Download Excel" buttons

**Section C — Employee Summary:**
- Date range selector
- "Download Excel" button for aggregated summary

The component uses `window.open()` or anchor tag downloads to trigger file downloads from the API routes.

```tsx
'use client';

import { useState } from 'react';
import {
  Title,
  Paper,
  Stack,
  Group,
  Button,
  Select,
  Divider,
  Text,
  SimpleGrid,
  ThemeIcon,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import {
  IconFileTypePdf,
  IconFileTypeCsv,
  IconFileSpreadsheet,
  IconDownload,
  IconReportAnalytics,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import dayjs from 'dayjs';

type FilterOptions = {
  users: Array<{ id: string; fullName: string; email: string }>;
  contracts: Array<{ id: string; name: string; contractNumber: string }>;
};

type Props = {
  filterOptions: FilterOptions;
};

export function ReportsClient({ filterOptions }: Props) {
  // Timesheet PDF state
  const [pdfUserId, setPdfUserId] = useState<string | null>(null);
  const [pdfPeriodStart, setPdfPeriodStart] = useState<Date | null>(null);

  // Cost Report state
  const [costStartDate, setCostStartDate] = useState<Date | null>(null);
  const [costEndDate, setCostEndDate] = useState<Date | null>(null);
  const [costContractId, setCostContractId] = useState<string | null>(null);

  // Employee Summary state
  const [summaryStartDate, setSummaryStartDate] = useState<Date | null>(null);
  const [summaryEndDate, setSummaryEndDate] = useState<Date | null>(null);

  function downloadTimesheetPdf() {
    if (!pdfUserId || !pdfPeriodStart) {
      notifications.show({ title: 'Missing Fields', message: 'Select an employee and period start date.', color: 'yellow' });
      return;
    }
    const params = new URLSearchParams({
      userId: pdfUserId,
      periodStart: dayjs(pdfPeriodStart).format('YYYY-MM-DD'),
    });
    window.open(`/api/reports/timesheet-pdf?${params.toString()}`, '_blank');
  }

  function downloadCostCsv() {
    if (!costStartDate || !costEndDate) {
      notifications.show({ title: 'Missing Fields', message: 'Select start and end dates.', color: 'yellow' });
      return;
    }
    const params = new URLSearchParams({
      startDate: dayjs(costStartDate).format('YYYY-MM-DD'),
      endDate: dayjs(costEndDate).format('YYYY-MM-DD'),
    });
    if (costContractId) params.set('contractId', costContractId);
    window.open(`/api/reports/cost-report-csv?${params.toString()}`, '_blank');
  }

  function downloadCostExcel() {
    if (!costStartDate || !costEndDate) {
      notifications.show({ title: 'Missing Fields', message: 'Select start and end dates.', color: 'yellow' });
      return;
    }
    const params = new URLSearchParams({
      startDate: dayjs(costStartDate).format('YYYY-MM-DD'),
      endDate: dayjs(costEndDate).format('YYYY-MM-DD'),
    });
    if (costContractId) params.set('contractId', costContractId);
    window.open(`/api/reports/cost-report-xlsx?${params.toString()}`, '_blank');
  }

  function downloadSummaryExcel() {
    if (!summaryStartDate || !summaryEndDate) {
      notifications.show({ title: 'Missing Fields', message: 'Select start and end dates.', color: 'yellow' });
      return;
    }
    // Uses the same Excel endpoint but with summary format — we can add a format param
    const params = new URLSearchParams({
      startDate: dayjs(summaryStartDate).format('YYYY-MM-DD'),
      endDate: dayjs(summaryEndDate).format('YYYY-MM-DD'),
      format: 'summary',
    });
    window.open(`/api/reports/cost-report-xlsx?${params.toString()}`, '_blank');
  }

  return (
    <>
      <Title order={2} mb="md">Reports & Export</Title>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="xl">
        {/* --- Individual Timesheet PDF --- */}
        <Paper withBorder p="lg" radius="md">
          <Group mb="md">
            <ThemeIcon color="red" variant="light" size="lg" radius="md">
              <IconFileTypePdf size={20} />
            </ThemeIcon>
            <div>
              <Text fw={600}>Individual Timesheet (PDF)</Text>
              <Text size="xs" c="dimmed">DCAA-compliant timesheet with certification statement</Text>
            </div>
          </Group>

          <Stack gap="sm">
            <Select
              label="Employee"
              placeholder="Select employee"
              data={filterOptions.users.map((u) => ({ value: u.id, label: `${u.fullName} (${u.email})` }))}
              value={pdfUserId}
              onChange={setPdfUserId}
              searchable
            />
            <DateInput
              label="Period Start Date"
              placeholder="Select the 1st or 16th"
              value={pdfPeriodStart}
              onChange={setPdfPeriodStart}
            />
            <Button
              leftSection={<IconDownload size={16} />}
              onClick={downloadTimesheetPdf}
              disabled={!pdfUserId || !pdfPeriodStart}
              color="red"
            >
              Download PDF
            </Button>
          </Stack>
        </Paper>

        {/* --- Cost Report (CSV/Excel) --- */}
        <Paper withBorder p="lg" radius="md">
          <Group mb="md">
            <ThemeIcon color="green" variant="light" size="lg" radius="md">
              <IconReportAnalytics size={20} />
            </ThemeIcon>
            <div>
              <Text fw={600}>Detailed Cost Report</Text>
              <Text size="xs" c="dimmed">Hours × rates by employee, CLIN, and LCAT</Text>
            </div>
          </Group>

          <Stack gap="sm">
            <Group grow>
              <DateInput
                label="Start Date"
                value={costStartDate}
                onChange={setCostStartDate}
              />
              <DateInput
                label="End Date"
                value={costEndDate}
                onChange={setCostEndDate}
              />
            </Group>
            <Select
              label="Contract (optional)"
              placeholder="All contracts"
              data={filterOptions.contracts.map((c) => ({ value: c.id, label: `${c.name} (${c.contractNumber})` }))}
              value={costContractId}
              onChange={setCostContractId}
              clearable
              searchable
            />
            <Group>
              <Button
                leftSection={<IconFileTypeCsv size={16} />}
                onClick={downloadCostCsv}
                disabled={!costStartDate || !costEndDate}
                variant="default"
              >
                Download CSV
              </Button>
              <Button
                leftSection={<IconFileSpreadsheet size={16} />}
                onClick={downloadCostExcel}
                disabled={!costStartDate || !costEndDate}
                color="green"
              >
                Download Excel
              </Button>
            </Group>
          </Stack>
        </Paper>

        {/* --- Employee Summary --- */}
        <Paper withBorder p="lg" radius="md">
          <Group mb="md">
            <ThemeIcon color="blue" variant="light" size="lg" radius="md">
              <IconFileSpreadsheet size={20} />
            </ThemeIcon>
            <div>
              <Text fw={600}>Employee Summary Report</Text>
              <Text size="xs" c="dimmed">Aggregated hours & cost by employee per contract/CLIN</Text>
            </div>
          </Group>

          <Stack gap="sm">
            <Group grow>
              <DateInput
                label="Start Date"
                value={summaryStartDate}
                onChange={setSummaryStartDate}
              />
              <DateInput
                label="End Date"
                value={summaryEndDate}
                onChange={setSummaryEndDate}
              />
            </Group>
            <Button
              leftSection={<IconFileSpreadsheet size={16} />}
              onClick={downloadSummaryExcel}
              disabled={!summaryStartDate || !summaryEndDate}
              color="blue"
            >
              Download Summary Excel
            </Button>
          </Stack>
        </Paper>
      </SimpleGrid>
    </>
  );
}
```

---

### Phase H: Add Reports Nav Link (H1)

#### H1. Modify `src/components/shell/AppNavbar.tsx`

Add `IconReportAnalytics` to the icon imports and add a new NavLink inside the `{isAdmin && (...)}` block:

```tsx
<NavLink
  label="Reports & Export"
  href="/admin/reports"
  leftSection={<IconReportAnalytics size={18} />}
  active={pathname === '/admin/reports'}
/>
```

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**.

### 4b. Functional Checks

| Check | Expected Result |
|---|---|
| **Reports page loads** | Three report cards rendered with filter inputs |
| **Download Timesheet PDF** | Opens PDF in new tab; shows employee name, period, charge codes, hours, certification |
| **PDF — approved timesheet** | Shows approved status, supervisor signature, timestamps |
| **Download Cost Report CSV** | Downloads CSV file; opens correctly in Excel |
| **Download Cost Report Excel** | Downloads .xlsx with formatted headers, currency columns, totals row |
| **Download Employee Summary** | Downloads .xlsx with aggregated data per employee per CLIN |
| **Contract filter on cost report** | Restricts data to the selected contract only |
| **Empty date range** | Returns empty report (no errors) |
| **Unauthorized access** | API routes return 401/403 for non-admin users |

### 4c. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `@react-pdf/renderer` SSR issues | PDF rendering requires Node.js APIs | Use API routes (not Server Actions) for PDF generation |
| `ExcelJS` buffer type mismatch | `writeBuffer` returns ArrayBuffer | Wrap with `Buffer.from()` |
| CSV encoding issues | Special characters in data | `escapeCSV` function handles commas, quotes, newlines |
| `DateInput` returns null | User didn't select a date | Disable download button until dates are selected |
| Large reports time out | Too much data | Add row limits or pagination for very large date ranges |
