'use client';

import { useState, useTransition } from 'react';
import {
  Container,
  Text,
  Paper,
  Group,
  Badge,
  Button,
  Stack,
  Table,
  Tabs,
  Alert,
  Anchor,
  TextInput,
  List,
} from '@mantine/core';
import {
  IconDatabaseImport,
  IconDownload,
  IconUpload,
  IconCheck,
  IconX,
  IconAlertCircle,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import Papa from 'papaparse';
import {
  validateMigrationData,
  validateMigrationPeriods,
  importMigrationData,
  importMigrationPeriods,
} from '@/server/actions/migration';
import type {
  MigrationEntryRow,
  MigrationPeriodRow,
  MigrationPeriodValidationResult,
  MigrationResult,
  MigrationValidationResult,
} from '@/types/migration';
import { runMigrationBatches, toFileRow, type BatchRunReport } from '@/lib/migration/batch-runner';
import { PageHeader } from '@/components/ui/PageHeader';
import { WriteButton } from '@/components/shell/WorkspaceMode';

type RowError = { row: number; message: string };

/** Summary of a (possibly multi-batch) import: committed batches, file-wide row errors, and where it stopped. */
interface ImportSummary {
  imported: number;
  skipped: number;
  errors: RowError[];
  report: BatchRunReport<MigrationResult>;
}

function summarize(report: BatchRunReport<MigrationResult>): ImportSummary {
  return {
    imported: report.completed.reduce((n, b) => n + b.result.imported, 0),
    skipped: report.completed.reduce((n, b) => n + b.result.skipped, 0),
    errors: report.completed.flatMap((b) => b.result.errors.map((e) => ({ row: toFileRow(b.firstRow, e.row), message: e.message }))),
    report,
  };
}

function ImportSummaryAlert({ summary }: { summary: ImportSummary }) {
  const { report } = summary;
  return (
    <Alert color={report.stopped || summary.errors.length ? 'warning' : 'success'} variant="light" icon={<IconAlertCircle size={16} />}>
      <Text size="sm" fw={600}>
        {summary.imported} imported{summary.skipped ? `, ${summary.skipped} already imported (skipped)` : ''}, {summary.errors.length} row errors
        {report.totalBatches > 1 ? ` — ${report.completed.length} of ${report.totalBatches} batches committed` : ''}.
      </Text>
      {report.stopped && (
        <Text size="sm" mt={4}>
          Batch {report.stopped.index} (rows {report.stopped.firstRow}–{report.stopped.lastRow}) was refused: {report.stopped.message}{' '}
          Nothing from that batch was imported; rows {report.stopped.firstRow}–{report.stopped.firstRow + report.stopped.remainingRows - 1} remain.
        </Text>
      )}
      {summary.errors.length > 0 && (
        <List size="xs" mt="xs" spacing={2}>
          {summary.errors.slice(0, 50).map((e) => <List.Item key={`${e.row}-${e.message}`}>Row {e.row}: {e.message}</List.Item>)}
          {summary.errors.length > 50 && <List.Item>…and {summary.errors.length - 50} more</List.Item>}
        </List>
      )}
    </Alert>
  );
}

export function MigrationClient() {
  const [isPending, startTransition] = useTransition();
  const [sourceSystem, setSourceSystem] = useState('');

  // Timesheet entries tab state
  const [entryFileName, setEntryFileName] = useState<string | null>(null);
  const [entryRows, setEntryRows] = useState<MigrationEntryRow[]>([]);
  const [entryValidation, setEntryValidation] = useState<MigrationValidationResult[]>([]);
  const [entryValidated, setEntryValidated] = useState(false);
  const [entrySummary, setEntrySummary] = useState<ImportSummary | null>(null);

  // Period status tab state
  const [periodFileName, setPeriodFileName] = useState<string | null>(null);
  const [periodRows, setPeriodRows] = useState<MigrationPeriodRow[]>([]);
  const [periodValidation, setPeriodValidation] = useState<MigrationPeriodValidationResult[]>([]);
  const [periodValidated, setPeriodValidated] = useState(false);
  const [periodSummary, setPeriodSummary] = useState<ImportSummary | null>(null);

  const sourceOk = sourceSystem.trim().length > 0 && sourceSystem.trim().length <= 100;

  function handleEntryFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows = (results.data as Record<string, string>[]).map((row) => ({
          employeeEmail: row['Employee Email'] ?? '',
          entryDate: row['Entry Date'] ?? '',
          contractNumber: row['Contract Number'] ?? '',
          clinNumber: row['CLIN Number'] ?? '',
          indirectCode: row['Indirect Code'] ?? '',
          hours: row['Hours'] ?? '',
          changeReason: row['Change Reason'] ?? '',
          comment: row['Comment'] ?? '',
          createdAt: row['Created At'] ?? '',
          enteredBy: row['Entered By'] ?? '',
        }));
        setEntryFileName(file.name);
        setEntryRows(rows);
        setEntryValidation([]);
        setEntryValidated(false);
        setEntrySummary(null);
        notifications.show({ title: 'File loaded', message: `${rows.length} rows parsed`, color: 'signal' });
      },
      error: (error) => {
        notifications.show({ title: 'Parse error', message: error.message, color: 'red' });
      },
    });
  }

  function handlePeriodFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows = (results.data as Record<string, string>[]).map((row) => ({
          employeeEmail: row['Employee Email'] ?? '',
          periodStart: row['Period Start'] ?? '',
          status: row['Status'] ?? '',
          submittedAt: row['Submitted At'] ?? '',
          reviewedAt: row['Reviewed At'] ?? '',
          reviewedByEmail: row['Reviewed By Email'] ?? '',
          reviewComment: row['Review Comment'] ?? '',
        }));
        setPeriodFileName(file.name);
        setPeriodRows(rows);
        setPeriodValidation([]);
        setPeriodValidated(false);
        setPeriodSummary(null);
        notifications.show({ title: 'File loaded', message: `${rows.length} rows parsed`, color: 'signal' });
      },
    });
  }

  function handleValidateEntries() {
    if (entryRows.length === 0) return;
    startTransition(async () => {
      // Batched like the import (a whole file in one request can exceed the 1 MB server-action limit).
      const report = await runMigrationBatches(entryRows, (r) => r.employeeEmail, (batch) => validateMigrationData(batch));
      if (report.stopped) {
        notifications.show({ title: 'Validation failed', message: report.stopped.message, color: 'red' });
        return;
      }
      const results = report.completed.flatMap((b) => b.result.map((r) => ({ ...r, rowIndex: toFileRow(b.firstRow, r.rowIndex) })));
      setEntryValidation(results);
      setEntryValidated(true);
      const invalid = results.filter((r) => !r.isValid).length;
      notifications.show({
        title: 'Validation complete',
        message: `${results.length - invalid} valid, ${invalid} with errors`,
        color: invalid === 0 ? 'success' : 'warning',
      });
    });
  }

  function handleImportEntries() {
    if (!entryValidated || entryRows.length === 0 || !sourceOk) return;
    startTransition(async () => {
      const report = await runMigrationBatches(entryRows, (r) => r.employeeEmail,
        (batch) => importMigrationData({ rows: batch, sourceSystem, fileName: entryFileName }));
      setEntrySummary(summarize(report));
    });
  }

  function handleValidatePeriods() {
    if (periodRows.length === 0) return;
    startTransition(async () => {
      const report = await runMigrationBatches(periodRows, (r) => r.employeeEmail, (batch) => validateMigrationPeriods(batch));
      if (report.stopped) {
        notifications.show({ title: 'Validation failed', message: report.stopped.message, color: 'red' });
        return;
      }
      const results = report.completed.flatMap((b) => b.result.map((r) => ({ ...r, rowIndex: toFileRow(b.firstRow, r.rowIndex) })));
      setPeriodValidation(results);
      setPeriodValidated(true);
      const invalid = results.filter((r) => !r.isValid).length;
      notifications.show({
        title: 'Validation complete',
        message: `${results.length - invalid} valid, ${invalid} with errors`,
        color: invalid === 0 ? 'success' : 'warning',
      });
    });
  }

  function handleImportPeriods() {
    if (!periodValidated || periodRows.length === 0 || !sourceOk) return;
    startTransition(async () => {
      const report = await runMigrationBatches(periodRows, (r) => r.employeeEmail,
        (batch) => importMigrationPeriods({ rows: batch, sourceSystem, fileName: periodFileName }));
      setPeriodSummary(summarize(report));
    });
  }

  const validCount = entryValidation.filter((r) => r.isValid).length;
  const invalidCount = entryValidation.filter((r) => !r.isValid).length;
  const validPeriodCount = periodValidation.filter((r) => r.isValid).length;
  const invalidPeriodCount = periodValidation.filter((r) => !r.isValid).length;

  return (
    <Container size="lg" py="xl">
      <PageHeader
        title="Data Migration"
        description="Import historical data when switching from another timekeeping system."
      />

      <Alert icon={<IconAlertCircle size={16} />} color="warning" variant="light" mb="md">
        <Text size="sm" fw={600}>
          Timesheet history can be imported only during onboarding — before your workspace&apos;s first submitted
          timesheet. Contracts, CLINs, users and charge codes can be imported any time.
        </Text>
        <Text size="sm" mt={4}>
          <strong>Required import order:</strong>{' '}
          1. Employees, Contracts, CLINs, Indirect Codes (via{' '}
          <Anchor href="/settings/import" size="sm">Data Import</Anchor>
          ) → 2. Historical Timesheet Entries → 3. Period Statuses. Entries can&apos;t be imported into a period that is
          already submitted or approved, so import entries <strong>before</strong> periods.
        </Text>
        <Text size="sm" mt={4}>
          Imported rows are labelled as imported (source system, import date and the importing admin) everywhere they
          appear; the original author and dates are kept as data. Only past dates and finished periods can be imported,
          and a row is refused when the employee already has hours on that CLIN or indirect code that day. That check
          runs at import only: hours entered in CadenzPoint later on an imported CLIN and day are accepted as usual.
        </Text>
      </Alert>

      <TextInput
        label="Source system"
        description="The timekeeping system this history comes from (shown on every imported row)."
        placeholder="e.g. Deltek Time & Expense"
        value={sourceSystem}
        onChange={(e) => setSourceSystem(e.currentTarget.value)}
        maxLength={100}
        required
        mb="xl"
        maw={420}
      />

      <Tabs defaultValue="entries">
        <Tabs.List mb="md">
          <Tabs.Tab value="entries" leftSection={<IconDatabaseImport size={16} />}>
            Timesheet Entries
          </Tabs.Tab>
          <Tabs.Tab value="periods" leftSection={<IconDatabaseImport size={16} />}>
            Period Status
          </Tabs.Tab>
        </Tabs.List>

        {/* Timesheet Entries Tab */}
        <Tabs.Panel value="entries">
          <Stack gap="md">
            <Group>
              <Button
                component="a"
                href="/templates/migration-timesheet-template.csv"
                download
                variant="light"
                leftSection={<IconDownload size={16} />}
                size="sm"
              >
                Download Template
              </Button>
              <Button component="label" variant="light" leftSection={<IconUpload size={16} />} size="sm">
                Upload CSV
                <input type="file" accept=".csv" hidden onChange={handleEntryFileUpload} />
              </Button>
              {entryRows.length > 0 && (
                <Button variant="light" size="sm" onClick={handleValidateEntries} loading={isPending}>
                  Validate ({entryRows.length} rows)
                </Button>
              )}
              {entryValidated && validCount > 0 && (
                <WriteButton variant="filled" size="sm" onClick={handleImportEntries} loading={isPending} disabled={!sourceOk}>
                  Import {validCount} Valid Rows
                </WriteButton>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              Optional column &quot;Entered By&quot;: the original author (email or name). Without it, imported rows show
              &quot;author not recorded&quot;. Large files are sent in batches of up to 2,000 rows and 200 employees.
            </Text>
            {entryValidated && !sourceOk && <Text size="sm" c="red">Enter the source system before importing.</Text>}

            {entrySummary && <ImportSummaryAlert summary={entrySummary} />}

            {entryValidated && (
              <Group gap="md">
                <Badge color="success" variant="light" size="lg">{validCount} valid</Badge>
                {invalidCount > 0 && <Badge color="red" variant="light" size="lg">{invalidCount} with errors</Badge>}
              </Group>
            )}

            {entryValidation.length > 0 && (
              <Paper withBorder radius="md">
                <Table.ScrollContainer minWidth={700}>
                  <Table striped highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Row</Table.Th>
                        <Table.Th>Employee</Table.Th>
                        <Table.Th>Date</Table.Th>
                        <Table.Th>Charge Code</Table.Th>
                        <Table.Th>Hours</Table.Th>
                        <Table.Th>Status</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {entryValidation.map((row) => (
                        <Table.Tr key={row.rowIndex}>
                          <Table.Td>{row.rowIndex}</Table.Td>
                          <Table.Td><Text size="xs">{row.data.employeeEmail}</Text></Table.Td>
                          <Table.Td><Text size="xs">{row.data.entryDate}</Text></Table.Td>
                          <Table.Td>
                            <Text size="xs">
                              {row.data.contractNumber ? `${row.data.contractNumber} / ${row.data.clinNumber}` : row.data.indirectCode}
                            </Text>
                          </Table.Td>
                          <Table.Td><Text size="xs">{row.data.hours}</Text></Table.Td>
                          <Table.Td>
                            {row.isValid ? (
                              <Badge color="success" variant="light" size="sm" leftSection={<IconCheck size={10} />}>Valid</Badge>
                            ) : (
                              <Stack gap={2}>
                                <Badge color="red" variant="light" size="sm" leftSection={<IconX size={10} />}>Error</Badge>
                                {row.errors.map((err, i) => <Text key={i} size="xs" c="red">{err}</Text>)}
                              </Stack>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Paper>
            )}
          </Stack>
        </Tabs.Panel>

        {/* Period Status Tab */}
        <Tabs.Panel value="periods">
          <Stack gap="md">
            <Group>
              <Button
                component="a"
                href="/templates/migration-periods-template.csv"
                download
                variant="light"
                leftSection={<IconDownload size={16} />}
                size="sm"
              >
                Download Template
              </Button>
              <Button component="label" variant="light" leftSection={<IconUpload size={16} />} size="sm">
                Upload CSV
                <input type="file" accept=".csv" hidden onChange={handlePeriodFileUpload} />
              </Button>
              {periodRows.length > 0 && (
                <Button variant="light" size="sm" onClick={handleValidatePeriods} loading={isPending}>
                  Validate ({periodRows.length} rows)
                </Button>
              )}
              {periodValidated && validPeriodCount > 0 && (
                <WriteButton variant="filled" size="sm" onClick={handleImportPeriods} loading={isPending} disabled={!sourceOk}>
                  Import {validPeriodCount} Period Records
                </WriteButton>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              Only submitted, approved or rejected periods that ended before today are imported. An imported approval is
              shown as &quot;Approved in {sourceSystem.trim() || 'your previous system'}&quot; — never as a CadenzPoint approval.
            </Text>
            {periodValidated && !sourceOk && <Text size="sm" c="red">Enter the source system before importing.</Text>}

            {periodSummary && <ImportSummaryAlert summary={periodSummary} />}

            {periodValidated && (
              <Group gap="md">
                <Badge color="success" variant="light" size="lg">{validPeriodCount} valid</Badge>
                {invalidPeriodCount > 0 && <Badge color="red" variant="light" size="lg">{invalidPeriodCount} with errors</Badge>}
              </Group>
            )}

            {periodRows.length > 0 && (
              <Paper withBorder radius="md">
                <Table striped highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Row</Table.Th>
                      <Table.Th>Employee</Table.Th>
                      <Table.Th>Period Start</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th>Submitted At</Table.Th>
                      <Table.Th>Reviewed At</Table.Th>
                      <Table.Th>Check</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {periodRows.map((row, i) => {
                      const v = periodValidation[i];
                      return (
                        <Table.Tr key={i}>
                          <Table.Td>{i + 1}</Table.Td>
                          <Table.Td><Text size="xs">{row.employeeEmail}</Text></Table.Td>
                          <Table.Td><Text size="xs">{row.periodStart}</Text></Table.Td>
                          <Table.Td>
                            <Badge
                              color={row.status === 'approved' ? 'success' : row.status === 'submitted' ? 'signal' : 'gray'}
                              variant="light"
                              size="sm"
                            >
                              {row.status}
                            </Badge>
                          </Table.Td>
                          <Table.Td><Text size="xs">{row.submittedAt || '—'}</Text></Table.Td>
                          <Table.Td><Text size="xs">{row.reviewedAt || '—'}</Text></Table.Td>
                          <Table.Td>
                            {!v ? <Text size="xs" c="dimmed">Not validated</Text> : v.isValid ? (
                              <Badge color="success" variant="light" size="sm" leftSection={<IconCheck size={10} />}>Valid</Badge>
                            ) : (
                              <Stack gap={2}>
                                <Badge color="red" variant="light" size="sm" leftSection={<IconX size={10} />}>Error</Badge>
                                {v.errors.map((err, j) => <Text key={j} size="xs" c="red">{err}</Text>)}
                              </Stack>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </Paper>
            )}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Container>
  );
}
