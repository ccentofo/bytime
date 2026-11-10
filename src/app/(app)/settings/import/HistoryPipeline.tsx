'use client';

import { useEffect, useRef, useState } from 'react';
import { Group, Stack, Text, TextInput } from '@mantine/core';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { Notice } from '@/components/ui/Notice';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useBusy } from '@/components/ui/useBusy';
import { SETUP_HREF } from '@/lib/setup/steps';
import { runMigrationBatches, toFileRow } from '@/lib/migration/batch-runner';
import { importMigrationData, importMigrationPeriods, validateMigrationData, validateMigrationPeriods } from '@/server/actions/migration';
import type { MigrationResult } from '@/types/migration';
import { nounFor, type HistoryTypeDef } from './import-types';
import { counts, hoursPayloadRow, mergeCheck, NOTHING_TO_IMPORT, prepareHistoryFile, statusPayloadRow } from './pipeline';
import type { DoneResult, PipelineEvent, PipelineState } from './pipeline-state';
import { ActionError, BLOCKED_ID, CheckResults, DoneResults, FileStep, type KeyColumn } from './ImportParts';
import classes from './Import.module.css';

/** P14: the import window, up front. */
export function windowCopy(open: boolean | null | undefined): string {
  if (open === undefined) return 'Checking whether past timesheets can be imported…';
  if (open === null) return "Couldn't check whether past timesheets can be imported.";
  return open ? 'Open — you can import past timesheets.' : 'Closed — contact support to reopen it.';
}
export const PAY_SCHEDULE_FIRST = 'Confirm your pay schedule first. After hours are imported it can only change on a future date.';
export const SOURCE_REQUIRED = 'Enter the source system before importing.';
const WINDOW_ID = 'import-window-status';

const HOURS_COLUMNS: KeyColumn[] = [
  { header: 'Employee', value: (d) => d['Employee Email'] ?? '' },
  { header: 'Date', value: (d) => d['Entry Date'] ?? '' },
  { header: 'Charge code', value: (d) => (d['Contract Number'] ? `${d['Contract Number']} · ${d['CLIN Number'] ?? ''}` : d['Indirect Code'] ?? '') },
  { header: 'Hours', value: (d) => d['Hours'] ?? '' },
];
const STATUS_COLUMNS: KeyColumn[] = [
  { header: 'Employee', value: (d) => d['Employee Email'] ?? '' },
  { header: 'Period start', value: (d) => d['Period Start'] ?? '' },
  { header: 'Status', value: (d) => d['Status'] ?? '' },
];

/**
 * Hours and Timesheet status (feature-plan-ux-setup-import.md §4.4): the existing history import in the same pipeline.
 * The check is validateMigration* through runMigrationBatches; Import sends every row (the server re-validates and
 * reports the rows it refused), so the batch file-row numbers stay right. The window and the pay schedule come first.
 */
export function HistoryPipeline({ def, state, dispatch, windowOpen, payConfigSet, onImported }: {
  def: HistoryTypeDef;
  state: PipelineState;
  dispatch: (e: PipelineEvent) => void;
  windowOpen: boolean | null | undefined;
  payConfigSet: boolean;
  onImported: () => void;
}) {
  const busy = useBusy();
  const started = useRef(-1);
  const [sourceSystem, setSourceSystem] = useState('');
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [clickError, setClickError] = useState<string | null>(null);
  const hours = def.key === 'hours';

  useEffect(() => {
    if (state.phase !== 'checking' || started.current === state.token) return;
    started.current = state.token;
    const { token, rows } = state;
    void (async () => {
      const report = hours
        ? await runMigrationBatches(rows.map((r) => hoursPayloadRow(r.data)), (r) => r.employeeEmail, (batch) => validateMigrationData(batch))
        : await runMigrationBatches(rows.map((r) => statusPayloadRow(r.data)), (r) => r.employeeEmail, (batch) => validateMigrationPeriods(batch));
      if (report.stopped) { dispatch({ type: 'checkFailed', token, error: report.stopped.message }); return; }
      const errors = report.completed.flatMap((b) => (b.result as Array<{ rowIndex: number; isValid: boolean; errors: string[] }>)
        .filter((v) => !v.isValid).map((v) => ({ row: toFileRow(b.firstRow, v.rowIndex), message: v.errors.join('; ') })));
      dispatch({ type: 'checkSucceeded', token, checked: mergeCheck(rows, { errors, skippedRows: [] }) });
    })();
  }, [state, hours, dispatch]);

  useEffect(() => {
    if (state.phase !== 'importing' || started.current === state.token) return;
    started.current = state.token;
    const { token, rows, fileName } = state;
    const source = sourceSystem.trim();
    void busy.run('import', async () => {
      const report = hours
        ? await runMigrationBatches(rows.map((r) => hoursPayloadRow(r.data)), (r) => r.employeeEmail,
          (batch) => importMigrationData({ rows: batch, sourceSystem: source, fileName }))
        : await runMigrationBatches(rows.map((r) => statusPayloadRow(r.data)), (r) => r.employeeEmail,
          (batch) => importMigrationPeriods({ rows: batch, sourceSystem: source, fileName }));
      // Refused before any batch committed: nothing was imported (§5: back to the checked rows).
      if (report.stopped && report.completed.length === 0) { dispatch({ type: 'importFailed', token, error: report.stopped.message }); return; }
      const done: DoneResult = {
        created: report.completed.reduce((n, b) => n + (b.result as MigrationResult).imported, 0),
        skipped: report.completed.reduce((n, b) => n + (b.result as MigrationResult).skipped, 0),
        errors: report.completed.flatMap((b) => (b.result as MigrationResult).errors.map((e) => ({ row: toFileRow(b.firstRow, e.row), message: e.message }))),
        stopped: report.stopped
          ? `Batch ${report.stopped.index} (rows ${report.stopped.firstRow}–${report.stopped.lastRow}) was refused: ${report.stopped.message} Rows ${report.stopped.firstRow}–${report.stopped.firstRow + report.stopped.remainingRows - 1} weren't imported.`
          : null,
      };
      dispatch({ type: 'importSucceeded', token, done });
      onImported();
    });
  }, [state, hours, sourceSystem, dispatch, busy, onImported]);

  const ready = counts(state.checked).ready;
  const importing = state.phase === 'importing';
  const closed = windowOpen === false;

  function startImport() {
    if (importing || closed) return;
    const source = sourceSystem.trim();
    if (!source) { setSourceError(SOURCE_REQUIRED); return; }
    if (ready === 0) { setClickError(NOTHING_TO_IMPORT); return; }
    setClickError(null);
    dispatch({ type: 'importStarted' });
  }

  const columns = (
    <>Columns: <span className={classes.mono}>{def.headerColumns.join(', ')}</span>; optional <span className={classes.mono}>{def.optional.join(', ')}</span>. Cells may be blank where a column doesn&apos;t apply.</>
  );

  return (
    <Stack gap="md">
      <Group gap="xs" id={WINDOW_ID} data-testid="import-window">
        {windowOpen === true && <StatusBadge word="Open" tone="ok" />}
        {windowOpen === false && <StatusBadge word="Closed" tone="bad" />}
        <Text size="sm" role="status">Import window: {windowCopy(windowOpen)}</Text>
      </Group>
      {!payConfigSet && (
        <div data-testid="pay-schedule-first">
          <Notice tone="warn" action={{ label: 'Open the Setup checklist', href: SETUP_HREF }}>{PAY_SCHEDULE_FIRST}</Notice>
        </div>
      )}
      <FileStep def={def} columns={columns} state={state} dispatch={dispatch} prepare={(text) => prepareHistoryFile(text, def)}>
        <TextInput
          mt="sm"
          label="Source system"
          description="The timekeeping system this history comes from (shown on every imported row)."
          placeholder="e.g. Deltek Time & Expense"
          value={sourceSystem}
          onChange={(e) => { setSourceSystem(e.currentTarget.value); setSourceError(null); }}
          error={sourceError}
          maxLength={100}
          required
          maw={420}
        />
        <Text size="xs" c="dimmed" mt="xs">
          {hours
            ? 'Imported rows are labelled as imported (source system, import date and the importing admin) everywhere they appear; the original author and dates are kept. A row is refused when the employee already has hours on that CLIN or indirect code that day.'
            : 'An imported approval is shown as "Approved in your previous system" — never as a CadenzPoint approval.'}
        </Text>
      </FileStep>
      <ActionError state={state} dispatch={dispatch} />
      {state.phase === 'checking' && (
        <Text size="sm" c="dimmed" role="status" aria-busy="true" data-testid="checking">Checking {state.rows.length} {state.rows.length === 1 ? 'row' : 'rows'}…</Text>
      )}
      {(state.phase === 'checked' || importing) && (
        <>
          <CheckResults rows={state.checked} headers={state.headers} keyColumns={hours ? HOURS_COLUMNS : STATUS_COLUMNS} fileName={state.fileName} />
          <Group justify="flex-end" gap="sm">
            {clickError && <Text size="sm" c="red" role="alert" id="import-click-error">{clickError}</Text>}
            <WriteButton {...busy.props('import', { blocked: closed })}
              aria-describedby={importing ? BLOCKED_ID : closed ? WINDOW_ID : clickError ? 'import-click-error' : undefined}
              onClick={startImport}>
              Import {ready} {nounFor(def, ready)}
            </WriteButton>
          </Group>
        </>
      )}
      {state.phase === 'done' && state.done && <DoneResults done={state.done} onAgain={() => dispatch({ type: 'reset' })} />}
    </Stack>
  );
}
