'use client';

import { useState, useTransition } from 'react';
import {
  Container,
  Title,
  Text,
  Paper,
  Group,
  Badge,
  Button,
  Stack,
  Table,
  Tabs,
  Alert,
  ThemeIcon,
  Anchor,
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
  importMigrationData,
  importMigrationPeriods,
  type MigrationEntryRow,
  type MigrationValidationResult,
} from '@/server/actions/migration';

export function MigrationClient() {
  const [isPending, startTransition] = useTransition();

  // Timesheet entries tab state
  const [entryRows, setEntryRows] = useState<MigrationEntryRow[]>([]);
  const [entryValidation, setEntryValidation] = useState<MigrationValidationResult[]>([]);
  const [entryValidated, setEntryValidated] = useState(false);

  // Period status tab state
  const [periodRows, setPeriodRows] = useState<any[]>([]);
  const [periodValidated, setPeriodValidated] = useState(false);

  function handleEntryFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows = (results.data as any[]).map((row) => ({
          employeeEmail: row['Employee Email'] ?? '',
          entryDate: row['Entry Date'] ?? '',
          contractNumber: row['Contract Number'] ?? '',
          clinNumber: row['CLIN Number'] ?? '',
          indirectCode: row['Indirect Code'] ?? '',
          hours: row['Hours'] ?? '',
          changeReason: row['Change Reason'] ?? '',
          comment: row['Comment'] ?? '',
          createdAt: row['Created At'] ?? '',
        }));
        setEntryRows(rows);
        setEntryValidation([]);
        setEntryValidated(false);
        notifications.show({ title: 'File loaded', message: `${rows.length} rows parsed`, color: 'blue' });
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
        const rows = (results.data as any[]).map((row) => ({
          employeeEmail: row['Employee Email'] ?? '',
          periodStart: row['Period Start'] ?? '',
          status: row['Status'] ?? '',
          submittedAt: row['Submitted At'] ?? '',
          reviewedAt: row['Reviewed At'] ?? '',
          reviewedByEmail: row['Reviewed By Email'] ?? '',
          reviewComment: row['Review Comment'] ?? '',
        }));
        setPeriodRows(rows);
        setPeriodValidated(false);
        notifications.show({ title: 'File loaded', message: `${rows.length} rows parsed`, color: 'blue' });
      },
    });
  }

  async function handleValidateEntries() {
    if (entryRows.length === 0) return;
    startTransition(async () => {
      try {
        const results = await validateMigrationData(entryRows);
        setEntryValidation(results);
        setEntryValidated(true);
        const valid = results.filter((r) => r.isValid).length;
        const invalid = results.filter((r) => !r.isValid).length;
        notifications.show({
          title: 'Validation complete',
          message: `${valid} valid, ${invalid} with errors`,
          color: invalid === 0 ? 'green' : 'yellow',
        });
      } catch (error) {
        notifications.show({ title: 'Validation failed', message: String(error), color: 'red' });
      }
    });
  }

  async function handleImportEntries() {
    if (!entryValidated || entryRows.length === 0) return;
    startTransition(async () => {
      try {
        const result = await importMigrationData(entryRows);
        notifications.show({
          title: 'Import complete',
          message: `${result.imported} imported, ${result.skipped} skipped, ${result.errors.length} errors`,
          color: result.errors.length === 0 ? 'green' : 'yellow',
        });
      } catch (error) {
        notifications.show({ title: 'Import failed', message: String(error), color: 'red' });
      }
    });
  }

  async function handleImportPeriods() {
    if (periodRows.length === 0) return;
    startTransition(async () => {
      try {
        const result = await importMigrationPeriods(periodRows);
        notifications.show({
          title: 'Period import complete',
          message: `${result.imported} imported, ${result.errors.length} errors`,
          color: result.errors.length === 0 ? 'green' : 'yellow',
        });
      } catch (error) {
        notifications.show({ title: 'Import failed', message: String(error), color: 'red' });
      }
    });
  }

  const validCount = entryValidation.filter((r) => r.isValid).length;
  const invalidCount = entryValidation.filter((r) => !r.isValid).length;

  return (
    <Container size="lg" py="xl">
      <Group gap="sm" mb="xl">
        <ThemeIcon size="lg" color="violet" variant="light" radius="md">
          <IconDatabaseImport size={20} />
        </ThemeIcon>
        <Title order={2}>Data Migration</Title>
      </Group>

      <Alert icon={<IconAlertCircle size={16} />} color="orange" variant="light" mb="xl">
        <Text size="sm" fw={600}>Migration imports historical data. This is a one-time operation for switching from another system.</Text>
        <Text size="sm" mt={4}>
          <strong>Required import order:</strong>{' '}
          1. Employees, Contracts, CLINs, Indirect Codes (via{' '}
          <Anchor href="/admin/import" size="sm">Data Import</Anchor>
          ) → 2. Historical Timesheet Entries → 3. Period Statuses
        </Text>
      </Alert>

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
              <Button
                component="label"
                variant="light"
                leftSection={<IconUpload size={16} />}
                size="sm"
              >
                Upload CSV
                <input type="file" accept=".csv" hidden onChange={handleEntryFileUpload} />
              </Button>
              {entryRows.length > 0 && (
                <Button
                  variant="light"
                  size="sm"
                  onClick={handleValidateEntries}
                  loading={isPending}
                >
                  Validate ({entryRows.length} rows)
                </Button>
              )}
              {entryValidated && validCount > 0 && (
                <Button
                  variant="filled"
                  size="sm"
                  onClick={handleImportEntries}
                  loading={isPending}
                >
                  Import {validCount} Valid Rows
                </Button>
              )}
            </Group>

            {entryValidated && (
              <Group gap="md">
                <Badge color="green" variant="light" size="lg">{validCount} valid</Badge>
                {invalidCount > 0 && <Badge color="red" variant="light" size="lg">{invalidCount} with errors</Badge>}
              </Group>
            )}

            {entryValidation.length > 0 && (
              <Paper withBorder radius="md">
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
                            {row.data.contractNumber
                              ? `${row.data.contractNumber} / ${row.data.clinNumber}`
                              : row.data.indirectCode}
                          </Text>
                        </Table.Td>
                        <Table.Td><Text size="xs">{row.data.hours}</Text></Table.Td>
                        <Table.Td>
                          {row.isValid ? (
                            <Badge color="green" variant="light" size="sm" leftSection={<IconCheck size={10} />}>Valid</Badge>
                          ) : (
                            <Stack gap={2}>
                              <Badge color="red" variant="light" size="sm" leftSection={<IconX size={10} />}>Error</Badge>
                              {row.errors.map((err, i) => (
                                <Text key={i} size="xs" c="red">{err}</Text>
                              ))}
                            </Stack>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
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
              <Button
                component="label"
                variant="light"
                leftSection={<IconUpload size={16} />}
                size="sm"
              >
                Upload CSV
                <input type="file" accept=".csv" hidden onChange={handlePeriodFileUpload} />
              </Button>
              {periodRows.length > 0 && (
                <Button
                  variant="filled"
                  size="sm"
                  onClick={handleImportPeriods}
                  loading={isPending}
                >
                  Import {periodRows.length} Period Records
                </Button>
              )}
            </Group>

            {periodRows.length > 0 && (
              <Paper withBorder radius="md">
                <Table striped highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Employee</Table.Th>
                      <Table.Th>Period Start</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th>Submitted At</Table.Th>
                      <Table.Th>Reviewed At</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {periodRows.map((row, i) => (
                      <Table.Tr key={i}>
                        <Table.Td><Text size="xs">{row.employeeEmail}</Text></Table.Td>
                        <Table.Td><Text size="xs">{row.periodStart}</Text></Table.Td>
                        <Table.Td>
                          <Badge
                            color={row.status === 'approved' ? 'green' : row.status === 'submitted' ? 'blue' : 'gray'}
                            variant="light"
                            size="sm"
                          >
                            {row.status}
                          </Badge>
                        </Table.Td>
                        <Table.Td><Text size="xs">{row.submittedAt || '—'}</Text></Table.Td>
                        <Table.Td><Text size="xs">{row.reviewedAt || '—'}</Text></Table.Td>
                      </Table.Tr>
                    ))}
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
