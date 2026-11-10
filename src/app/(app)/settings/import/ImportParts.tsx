'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Alert, Anchor, Button, Code, CopyButton, FileInput, Group, Modal, Stack, Table, Text } from '@mantine/core';
import { Icons } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { saveBlob } from '@/lib/download';
import { formatCount } from '@/lib/format';
import { generateCsv } from '@/lib/reports/csv-generator';
import type { ImportResult } from '@/server/actions/import';
import { currentStep, STEPS, type DoneResult, type Phase, type PipelineEvent, type PipelineState } from './pipeline-state';
import { checkSummary, counts, doneSummary, problemsCsv, tableRows, type CheckedRow, type PreparedFile } from './pipeline';
import type { ImportTypeDef } from './import-types';
import classes from './Import.module.css';

/** Shared pieces of the import pipeline (feature-plan-ux-setup-import.md §4.1, §4.2). */

export const BLOCKED_REASON = 'Wait for the import to finish.';
export const BLOCKED_ID = 'import-blocked-reason';

/** The non-interactive step row, with aria-current on the current step. */
export function StepRow({ phase }: { phase: Phase }) {
  const current = currentStep(phase);
  const at = STEPS.indexOf(current);
  return (
    <ol className={classes.pipe} aria-label="Import steps" data-testid="import-steps">
      {STEPS.map((s, i) => {
        const done = i < at || (phase === 'done' && i === at);
        return (
          <li key={s} aria-current={s === current ? 'step' : undefined} data-done={done || undefined}>
            {done && <span aria-hidden="true">✓ </span>}{s}{done && <span className={classes.srOnly}> (done)</span>}
          </li>
        );
      })}
    </ol>
  );
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export const READ_ERROR = "Couldn't read that file. Make sure it's a CSV.";

/**
 * Step 1: the type's title, its columns, the template, and the file. While the pipeline is empty it's the accessible
 * FileInput (a labelled button); after a file is accepted it's the file's name and "Choose a different file".
 */
export function FileStep({ def, columns, state, dispatch, prepare, children }: {
  def: ImportTypeDef;
  columns: ReactNode;
  state: PipelineState;
  dispatch: (e: PipelineEvent) => void;
  prepare: (text: string) => PreparedFile;
  children?: ReactNode;
}) {
  const request = useRef(0);
  const importing = state.phase === 'importing';

  async function onFile(file: File | null) {
    const req = ++request.current;
    if (!file) { dispatch({ type: 'reset' }); return; }
    let text: string;
    try {
      text = await readText(file);
    } catch {
      if (req === request.current) dispatch({ type: 'fileRejected', fileName: file.name, error: READ_ERROR });
      return;
    }
    if (req !== request.current) return;           // another file was chosen meanwhile
    const prepared = prepare(text);
    dispatch(prepared.ok
      ? { type: 'fileAccepted', fileName: file.name, headers: prepared.headers, rows: prepared.rows }
      : { type: 'fileRejected', fileName: file.name, error: prepared.error });
  }

  return (
    <div className={classes.panel}>
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <div>
          <h2 id="import-type-title" className={classes.title}>{def.label}</h2>
          <Text size="sm" c="dimmed" data-testid="import-columns">{columns}</Text>
          <Text size="sm" mt={4}>{def.note}</Text>
        </div>
        <Button component="a" href={`/templates/${def.template}`} download={def.template} variant="default" size="xs" leftSection={<Icons.download size={14} aria-hidden="true" />}>
          Download template
        </Button>
      </Group>
      {children}
      <div className={classes.fileRow}>
        {state.phase === 'empty' ? (
          <FileInput
            label="CSV file"
            placeholder="Choose a CSV file"
            accept=".csv"
            leftSection={<Icons.upload size={16} aria-hidden="true" />}
            onChange={(f) => { void onFile(f); }}
            error={state.fileError}
            maw={420}
          />
        ) : (
          <Group gap="md">
            <Text size="sm" data-testid="import-file"><b>{state.fileName}</b> · {formatCount(state.rows.length)} {state.rows.length === 1 ? 'row' : 'rows'}</Text>
            <Button variant="subtle" size="xs" aria-disabled={importing || undefined} aria-describedby={importing ? BLOCKED_ID : undefined}
              onClick={() => { if (!importing) dispatch({ type: 'reset' }); }}>
              Choose a different file
            </Button>
          </Group>
        )}
      </div>
    </div>
  );
}

/** The whole-request error (§5), with "Check again" when the file is kept after a failed check. */
export function ActionError({ state, dispatch }: { state: PipelineState; dispatch: (e: PipelineEvent) => void }) {
  if (!state.actionError) return null;
  const canRetry = state.phase === 'empty' && state.rows.length > 0;
  return (
    <Alert color="red" variant="light" role="alert" data-testid="import-action-error">
      <Group justify="space-between" gap="sm">
        <span>{state.actionError}</span>
        {canRetry && <Button size="xs" variant="default" onClick={() => dispatch({ type: 'checkAgain' })}>Check again</Button>}
      </Group>
    </Alert>
  );
}

export interface KeyColumn { header: string; value: (d: Record<string, string>) => string }

function resultCell(r: CheckedRow) {
  switch (r.outcome.kind) {
    case 'problem': return <span className={classes.err}>{r.outcome.message}</span>;
    case 'skip': return <span className={classes.dim}>Will be skipped: {r.outcome.reason}</span>;
    case 'ready': return <span className={classes.ok}>Ready</span>;
  }
}

/** Step 2: the summary (with "Download rows with problems") and the table — problems first, then skips, then ready rows. */
export function CheckResults({ rows, headers, keyColumns, fileName }: { rows: CheckedRow[]; headers: string[]; keyColumns: KeyColumn[]; fileName: string | null }) {
  const [showAll, setShowAll] = useState(false);
  const summary = checkSummary(rows);
  const { problems } = counts(rows);
  const { visible, hiddenReady } = tableRows(rows, showAll);
  const download = () => saveBlob(new Blob([problemsCsv(rows, headers)], { type: 'text/csv' }), `${(fileName ?? 'import').replace(/\.csv$/i, '')}-problems.csv`);
  return (
    <Stack gap="sm">
      <div role="status" data-testid="check-summary">
        <Notice tone={summary.warn ? 'warn' : 'info'} action={problems > 0 ? { label: 'Download rows with problems', onClick: download } : undefined}>
          {summary.text}
        </Notice>
      </div>
      <div className={classes.panel} data-flush>
        <Table.ScrollContainer minWidth={480}>
          <Table className={classes.table} data-testid="check-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th className={classes.num}>Row</Table.Th>
                {keyColumns.map((c) => <Table.Th key={c.header}>{c.header}</Table.Th>)}
                <Table.Th>Result</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visible.map((r) => (
                <Table.Tr key={r.row} data-outcome={r.outcome.kind}>
                  <Table.Td className={classes.num}>{r.row}</Table.Td>
                  {keyColumns.map((c) => <Table.Td key={c.header}>{c.value(r.data)}</Table.Td>)}
                  <Table.Td>{resultCell(r)}</Table.Td>
                </Table.Tr>
              ))}
              {hiddenReady > 0 && (
                <Table.Tr>
                  <Table.Td colSpan={keyColumns.length + 2} className={classes.dim}>
                    …and {formatCount(hiddenReady)} more ready {hiddenReady === 1 ? 'row' : 'rows'}.{' '}
                    <Anchor component="button" type="button" size="sm" onClick={() => setShowAll(true)}>Show all</Anchor>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </div>
    </Stack>
  );
}

/** Step 4: the counts, the problems the import itself reported (data can change after a check), and what's next. */
export function DoneResults({ done, extra, onAgain }: { done: DoneResult; extra?: ReactNode; onAgain: () => void }) {
  return (
    <Stack gap="sm">
      <div role="status" data-testid="done-summary">
        <Notice tone={done.errors.length > 0 || done.stopped ? 'warn' : 'info'}>{doneSummary(done)}{done.stopped ? ` ${done.stopped}` : ''}</Notice>
      </div>
      {done.errors.length > 0 && (
        <div className={classes.panel} data-flush>
          <Table className={classes.table} data-testid="done-problems">
            <Table.Thead><Table.Tr><Table.Th className={classes.num}>Row</Table.Th><Table.Th>Problem</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {done.errors.map((e, i) => (
                <Table.Tr key={`${e.row}-${i}`} data-outcome="problem"><Table.Td className={classes.num}>{e.row}</Table.Td><Table.Td><span className={classes.err}>{e.message}</span></Table.Td></Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      <Group gap="sm">
        {extra}
        <Button variant="default" onClick={onAgain}>Import another file</Button>
      </Group>
    </Stack>
  );
}

/**
 * People: the generated passwords, shown once (Copy / Download / "I've saved the passwords"). Fix round 1 (F13): the
 * shared CSV writer — RFC 4180 quoting and the formula guard (a password starting with "@" or "=" must not be evaluated).
 */
export function PasswordsModal({ opened, onClose, importResult }: { opened: boolean; onClose: () => void; importResult: Pick<ImportResult, 'generatedPasswords'> | null }) {
  const passwordCsvContent = importResult?.generatedPasswords
    ? generateCsv(importResult.generatedPasswords, [{ key: 'email', header: 'Email' }, { key: 'password', header: 'Password' }])
    : '';
  return (
    <Modal opened={opened} onClose={onClose} title="Generated passwords" size="lg" closeOnClickOutside={false}>
      <Stack>
        <Alert color="warning" variant="light">
          <Text size="sm" fw={600}>These passwords are shown only once.</Text>
          <Text size="sm">Copy or download them now. People should change their password when they first sign in.</Text>
        </Alert>
        <div className={classes.scroll}>
          <Table>
            <Table.Thead><Table.Tr><Table.Th>Email</Table.Th><Table.Th>Temporary password</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {importResult?.generatedPasswords?.map((p) => (
                <Table.Tr key={p.email}><Table.Td>{p.email}</Table.Td><Table.Td><Code>{p.password}</Code></Table.Td></Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
        <Group>
          <CopyButton value={passwordCsvContent}>
            {({ copied, copy }) => (
              <Button leftSection={<Icons.copy size={16} aria-hidden="true" />} onClick={copy} variant="light">{copied ? 'Copied' : 'Copy as CSV'}</Button>
            )}
          </CopyButton>
          <Button variant="default" leftSection={<Icons.download size={16} aria-hidden="true" />}
            onClick={() => saveBlob(new Blob([passwordCsvContent], { type: 'text/csv' }), 'generated-passwords.csv')}>
            Download CSV
          </Button>
        </Group>
        <Button onClick={onClose}>I&apos;ve saved the passwords</Button>
      </Stack>
    </Modal>
  );
}
