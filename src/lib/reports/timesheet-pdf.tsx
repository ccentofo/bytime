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
