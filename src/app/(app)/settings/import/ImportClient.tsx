'use client';

import { useState, useTransition } from 'react';
import {
  Tabs,
  Stack,
  Group,
  Button,
  FileInput,
  Text,
  Badge,
  Alert,
  Paper,
  Table,
  Modal,
  Code,
  CopyButton,
  Tooltip,
  ActionIcon,
  Divider,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { runAction } from '@/lib/run-action';
import type { ActionResult } from '@/lib/action-result';
import {
  IconUpload,
  IconDownload,
  IconCheck,
  IconX,
  IconAlertCircle,
  IconCopy,
} from '@tabler/icons-react';
import { parseCSV, type ParsedRow, type ParseResult } from '@/lib/csv-parser';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  bulkImportEmployees,
  bulkImportContracts,
  bulkImportClins,
  bulkImportLaborCategories,
  bulkImportAssignments,
  type ImportResult,
} from '@/server/actions/import';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { generateCsv } from '@/lib/reports/csv-generator';

// ---------------------------------------------------------------------------
// Parse feedback shared by both wizards (feature-plan-ux-page-fixes.md C10)
// ---------------------------------------------------------------------------

const MAX_LISTED_ERRORS = 100;
const rowsWord = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;

/** The missing-columns alert, the counts (role=status) and the list of rows with errors. */
function ParseFeedback({ parseResult }: { parseResult: ParseResult }) {
  const invalid = parseResult.rows.filter((r) => !r.isValid);
  return (
    <>
      {parseResult.missingColumns.length > 0 && (
        <Alert role="alert" color="red" variant="light" icon={<IconAlertCircle size={16} />}>
          This file is missing required columns: {parseResult.missingColumns.join(', ')}. Download the template to see the expected headers.
        </Alert>
      )}
      <Text size="sm" role="status">
        {rowsWord(parseResult.validRows)} ready to import.
        {parseResult.errorRows > 0 && ` ${rowsWord(parseResult.errorRows)} ${parseResult.errorRows === 1 ? 'has' : 'have'} errors. Fix them in your file and upload it again.`}
      </Text>
      {invalid.length > 0 && (
        <div>
          <Text fw={600} size="sm">Rows with errors ({invalid.length})</Text>
          <Text size="xs" c="dimmed" mb={4}>Row 1 is the first row after the header. Blank lines aren&apos;t counted.</Text>
          <Stack gap={2} component="ul" m={0} pl="md">
            {invalid.slice(0, MAX_LISTED_ERRORS).map((r) => (
              <Text key={r.rowIndex} component="li" size="xs" c="red">Row {r.rowIndex}: {r.errors.join('; ')}</Text>
            ))}
          </Stack>
          {invalid.length > MAX_LISTED_ERRORS && <Text size="xs" c="dimmed">…and {invalid.length - MAX_LISTED_ERRORS} more</Text>}
        </div>
      )}
    </>
  );
}

/** A row's status: the badge plus its errors as visible text (never a title= tooltip). */
export function RowStatus({ row }: { row: ParsedRow }) {
  if (row.isValid) return <Badge color="success" size="xs" variant="light">Valid</Badge>;
  return (
    <Stack gap={2}>
      <Badge color="red" size="xs" variant="light">Error</Badge>
      {/* Keyed by position: two errors can share a text (UX-4A-AUDIT.md L10). */}
      {row.errors.map((e, i) => <Text key={i} size="xs" c="red">{e}</Text>)}
    </Stack>
  );
}

/**
 * The server numbers errors over the rows it was sent (the valid ones), from 1. `fileRows` is the file row of each
 * sent row, snapshotted when Import was clicked, so a file chosen mid-import can't remap them.
 */
function ServerErrors({ errors, fileRows }: { errors: ImportResult['errors']; fileRows: number[] }) {
  if (errors.length === 0) return null;
  return (
    <Stack gap={4}>
      {errors.map((e, i) => (
        <Text key={i} size="xs" c="red">Row {fileRows[e.row - 1] ?? e.row}: {e.message}</Text>
      ))}
    </Stack>
  );
}

const validFileRows = (parseResult: ParseResult) => parseResult.rows.filter((r) => r.isValid).map((r) => r.rowIndex);

// ---------------------------------------------------------------------------
// Shared ImportWizard component
// ---------------------------------------------------------------------------

interface ImportWizardProps {
  title: string;
  description: string;
  templateUrl: string;
  templateName: string;
  requiredColumns: string[];
  /** Returns the action's result; the wizard checks it (launch-blockers P4). */
  onImport: (rows: Record<string, string>[]) => Promise<ActionResult<ImportResult>>;
  importOrderNote?: string;
}

function ImportWizard({
  title,
  description,
  templateUrl,
  templateName,
  requiredColumns,
  onImport,
  importOrderNote,
}: ImportWizardProps) {
  const [isPending, startTransition] = useTransition();
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [resultFileRows, setResultFileRows] = useState<number[]>([]);

  function handleFileChange(file: File | null) {
    if (!file) {
      setParseResult(null);
      setImportResult(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const result = parseCSV(text, requiredColumns);
      setParseResult(result);
      setImportResult(null);
    };
    reader.readAsText(file);
  }

  function handleImport() {
    if (!parseResult) return;
    const validRows = parseResult.rows.filter((r) => r.isValid).map((r) => r.data);
    if (validRows.length === 0) return;
    const fileRows = validFileRows(parseResult);

    startTransition(async () => {
      const outcome = await runAction(onImport(validRows), { errorTitle: 'Import Failed' });
      if (!outcome.ok) return;
      const result = outcome.data;
      setImportResult(result);
      setResultFileRows(fileRows);
      notifications.show({
        title: 'Import Complete',
        message: `Created: ${result.created}, Skipped: ${result.skipped}, Errors: ${result.errors.length}`,
        color: result.errors.length > 0 ? 'warning' : 'success',
      });
    });
  }

  const validCount = parseResult?.validRows ?? 0;

  return (
    <Stack gap="md">
      <div>
        <Text fw={600} size="sm" mb={4}>{title}</Text>
        <Text size="sm" c="dimmed">{description}</Text>
        {importOrderNote && (
          <Alert icon={<IconAlertCircle size={14} />} color="signal" variant="light" mt="xs">
            <Text size="xs">{importOrderNote}</Text>
          </Alert>
        )}
      </div>

      <Group>
        <Button
          component="a"
          href={templateUrl}
          download={templateName}
          variant="default"
          size="sm"
          leftSection={<IconDownload size={16} />}
        >
          Download Template
        </Button>
      </Group>

      <FileInput
        label="Upload CSV"
        placeholder="Click to select CSV file..."
        accept=".csv"
        leftSection={<IconUpload size={16} />}
        onChange={handleFileChange}
        size="sm"
      />

      {parseResult && (
        <>
          <ParseFeedback parseResult={parseResult} />

          {parseResult.rows.length > 0 && (
            <Paper withBorder radius="sm" style={{ maxHeight: 300, overflowY: 'auto' }}>
              <Table.ScrollContainer minWidth={500}>
                <Table striped>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Row</Table.Th>
                      <Table.Th>Status</Table.Th>
                      {parseResult.headers.map((h) => (
                        <Table.Th key={h}>{h}</Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {parseResult.rows.map((row) => (
                      <Table.Tr key={row.rowIndex}>
                        <Table.Td>{row.rowIndex}</Table.Td>
                        <Table.Td><RowStatus row={row} /></Table.Td>
                        {parseResult.headers.map((h) => (
                          <Table.Td key={h} style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {row.data[h] ?? ''}
                          </Table.Td>
                        ))}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Paper>
          )}

          <WriteButton
            onClick={handleImport}
            loading={isPending}
            disabled={validCount === 0}
            leftSection={<IconUpload size={16} />}
            color="signal"
          >
            Import {validCount} Valid Row{validCount !== 1 ? 's' : ''}
          </WriteButton>
        </>
      )}

      {importResult && (
        <Paper withBorder p="md" radius="sm">
          <Text fw={600} size="sm" mb="xs">Import Results</Text>
          <Group gap="sm" mb="xs">
            <Badge color="success" variant="light">✓ {importResult.created} created</Badge>
            <Badge color="gray" variant="light">⟳ {importResult.skipped} skipped</Badge>
            {importResult.errors.length > 0 && (
              <Badge color="red" variant="light">✗ {importResult.errors.length} errors</Badge>
            )}
          </Group>
          <ServerErrors errors={importResult.errors} fileRows={resultFileRows} />
        </Paper>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Employee Import with password display
// ---------------------------------------------------------------------------

function EmployeeImportWizard() {
  const [isPending, startTransition] = useTransition();
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [resultFileRows, setResultFileRows] = useState<number[]>([]);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);

  const requiredColumns = ['Name', 'Email', 'Role', 'FLSA Exempt'];

  function handleFileChange(file: File | null) {
    if (!file) { setParseResult(null); setImportResult(null); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      setParseResult(parseCSV(text, requiredColumns));
      setImportResult(null);
    };
    reader.readAsText(file);
  }

  function handleImport() {
    if (!parseResult) return;
    const validRows = parseResult.rows.filter((r) => r.isValid).map((r) => ({
      name: r.data['Name'],
      email: r.data['Email'],
      role: r.data['Role'],
      flsaExempt: r.data['FLSA Exempt'],
    }));
    if (validRows.length === 0) return;
    const fileRows = validFileRows(parseResult);

    startTransition(async () => {
      const outcome = await runAction(bulkImportEmployees(validRows), { errorTitle: 'Import Failed' });
      if (!outcome.ok) return; // e.g. the batch would exceed the plan's seat limit — shown verbatim
      const result = outcome.data;
      setImportResult(result);
      setResultFileRows(fileRows);
      if (result.created > 0) setPasswordModalOpen(true);
      notifications.show({
        title: 'Employee Import Complete',
        message: `Created: ${result.created}, Skipped: ${result.skipped}`,
        color: result.errors.length > 0 ? 'warning' : 'success',
      });
    });
  }

  const validCount = parseResult?.validRows ?? 0;
  // Fix round 1 (F13): the shared CSV writer — RFC 4180 quoting and the formula guard (a password starting with "@"
  // or "=" must not be evaluated by a spreadsheet).
  const passwordCsvContent = importResult?.generatedPasswords
    ? generateCsv(importResult.generatedPasswords, [{ key: 'email', header: 'Email' }, { key: 'password', header: 'Password' }])
    : '';

  return (
    <Stack gap="md">
      <div>
        <Text fw={600} size="sm" mb={4}>Employee Import</Text>
        <Text size="sm" c="dimmed">Bulk create user accounts. Generated passwords are shown once after import.</Text>
      </div>

      <Group>
        <Button
          component="a"
          href="/templates/employee-import-template.csv"
          download="employee-import-template.csv"
          variant="default"
          size="sm"
          leftSection={<IconDownload size={16} />}
        >
          Download Template
        </Button>
      </Group>

      <FileInput
        label="Upload CSV"
        placeholder="Click to select CSV file..."
        accept=".csv"
        leftSection={<IconUpload size={16} />}
        onChange={handleFileChange}
        size="sm"
      />

      {parseResult && (
        <>
          <ParseFeedback parseResult={parseResult} />

          {parseResult.rows.length > 0 && (
          <Paper withBorder radius="sm" style={{ overflowX: 'auto', maxHeight: 300, overflowY: 'auto' }}>
            <Table striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Row</Table.Th>
                    <Table.Th>Status</Table.Th>
                    {parseResult.headers.map((h) => <Table.Th key={h}>{h}</Table.Th>)}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {parseResult.rows.map((row) => (
                    <Table.Tr key={row.rowIndex}>
                      <Table.Td>{row.rowIndex}</Table.Td>
                      <Table.Td><RowStatus row={row} /></Table.Td>
                      {parseResult.headers.map((h) => <Table.Td key={h}>{row.data[h] ?? ''}</Table.Td>)}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Paper>
          )}

          <WriteButton onClick={handleImport} loading={isPending} disabled={validCount === 0} leftSection={<IconUpload size={16} />} color="signal">
            Import {validCount} Employee{validCount !== 1 ? 's' : ''}
          </WriteButton>
        </>
      )}

      {importResult && (
        <Paper withBorder p="md" radius="sm">
          <Group gap="sm" mb="xs">
            <Badge color="success" variant="light">✓ {importResult.created} created</Badge>
            <Badge color="gray" variant="light">⟳ {importResult.skipped} skipped</Badge>
            {importResult.errors.length > 0 && <Badge color="red" variant="light">✗ {importResult.errors.length} errors</Badge>}
          </Group>
          <ServerErrors errors={importResult.errors} fileRows={resultFileRows} />
          {importResult.created > 0 && (
            <Button size="xs" variant="light" onClick={() => setPasswordModalOpen(true)}>
              View Generated Passwords
            </Button>
          )}
        </Paper>
      )}

      {/* Password Modal */}
      <Modal
        opened={passwordModalOpen}
        onClose={() => setPasswordModalOpen(false)}
        title="Generated Passwords — Copy Now!"
        size="lg"
        closeOnClickOutside={false}
      >
        <Stack>
          <Alert icon={<IconAlertCircle size={16} />} color="warning" variant="light">
            <Text size="sm" fw={600}>These passwords are shown only once.</Text>
            <Text size="sm">Copy or download them now. Users should change their password on first login.</Text>
          </Alert>
          <Paper withBorder p="sm" radius="sm" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Email</Table.Th>
                  <Table.Th>Temporary Password</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {importResult?.generatedPasswords?.map((p) => (
                  <Table.Tr key={p.email}>
                    <Table.Td>{p.email}</Table.Td>
                    <Table.Td><Code>{p.password}</Code></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
          <Group>
            <CopyButton value={passwordCsvContent}>
              {({ copied, copy }) => (
                <Button leftSection={<IconCopy size={16} />} onClick={copy} variant="light" color={copied ? 'success' : 'signal'}>
                  {copied ? 'Copied!' : 'Copy as CSV'}
                </Button>
              )}
            </CopyButton>
            <Button
              variant="default"
              leftSection={<IconDownload size={16} />}
              onClick={() => {
                const blob = new Blob([passwordCsvContent], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'generated-passwords.csv';
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download CSV
            </Button>
          </Group>
          <Button onClick={() => setPasswordModalOpen(false)} color="success">
            I've Saved the Passwords
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Main ImportClient
// ---------------------------------------------------------------------------

export function ImportClient() {
  return (
    <>
      <PageHeader title="Data import" />
      <Alert icon={<IconAlertCircle size={16} />} color="signal" variant="light" mb="lg">
        <Text size="sm" fw={600}>Import Order — follow these steps in order:</Text>
        <Text size="sm">1. Employees → 2. Contracts → 3. CLINs → 4. Labor Categories → 5. CLIN assignments</Text>
      </Alert>

      <Tabs defaultValue="employees">
        <Tabs.List mb="md">
          <Tabs.Tab value="employees">Employees</Tabs.Tab>
          <Tabs.Tab value="contracts">Contracts</Tabs.Tab>
          <Tabs.Tab value="clins">CLINs</Tabs.Tab>
          <Tabs.Tab value="lcats">Labor Categories</Tabs.Tab>
          <Tabs.Tab value="assignments">Approval scope</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="employees">
          <EmployeeImportWizard />
        </Tabs.Panel>

        <Tabs.Panel value="contracts">
          <ImportWizard
            title="Contract Import"
            description="Bulk create contracts. Duplicate contract numbers are skipped."
            templateUrl="/templates/contract-import-template.csv"
            templateName="contract-import-template.csv"
            requiredColumns={['Contract Number', 'Name', 'Type', 'Funded Value', 'Ceiling Value', 'Start Date', 'End Date']}
            onImport={(rows) => bulkImportContracts(rows.map((r) => ({
              contractNumber: r['Contract Number'],
              name: r['Name'],
              type: r['Type'],
              fundedValue: r['Funded Value'],
              ceilingValue: r['Ceiling Value'],
              startDate: r['Start Date'],
              endDate: r['End Date'],
            })))}
          />
        </Tabs.Panel>

        <Tabs.Panel value="clins">
          <ImportWizard
            title="CLIN Import"
            description="Bulk create CLINs under existing contracts."
            templateUrl="/templates/clin-import-template.csv"
            templateName="clin-import-template.csv"
            requiredColumns={['Contract Number', 'CLIN Number', 'Description', 'Funded Amount']}
            onImport={(rows) => bulkImportClins(rows.map((r) => ({
              contractNumber: r['Contract Number'],
              clinNumber: r['CLIN Number'],
              description: r['Description'],
              fundedAmount: r['Funded Amount'],
            })))}
            importOrderNote="Contracts must be imported before CLINs."
          />
        </Tabs.Panel>

        <Tabs.Panel value="lcats">
          <ImportWizard
            title="Labor Category Import"
            description="Bulk create labor categories (LCATs) with billing rates."
            templateUrl="/templates/labor-category-import-template.csv"
            templateName="labor-category-import-template.csv"
            requiredColumns={['Contract Number', 'CLIN Number', 'LCAT Code', 'Title', 'Hourly Rate', 'Ceiling Rate']}
            onImport={(rows) => bulkImportLaborCategories(rows.map((r) => ({
              contractNumber: r['Contract Number'],
              clinNumber: r['CLIN Number'],
              lcatCode: r['LCAT Code'],
              title: r['Title'],
              hourlyRate: r['Hourly Rate'],
              ceilingRate: r['Ceiling Rate'],
            })))}
            importOrderNote="Contracts and CLINs must be imported before Labor Categories."
          />
        </Tabs.Panel>

        <Tabs.Panel value="assignments">
          <ImportWizard
            title="Approval scope"
            description="Give supervisors approval scope on CLINs. Each row lets one supervisor approve employees on one CLIN."
            templateUrl="/templates/assignment-import-template.csv"
            templateName="assignment-import-template.csv"
            requiredColumns={['Email', 'Contract Number', 'CLIN Number']}
            onImport={(rows) => bulkImportAssignments(rows.map((r) => ({
              email: r['Email'],
              contractNumber: r['Contract Number'],
              clinNumber: r['CLIN Number'],
            })))}
            importOrderNote="The supervisors must already exist (import Employees first, with the supervisor role), and so must the Contracts and CLINs."
          />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
