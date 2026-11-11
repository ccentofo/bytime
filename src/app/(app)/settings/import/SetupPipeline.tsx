'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Group, Stack, Text } from '@mantine/core';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { useBusy } from '@/components/ui/useBusy';
import { runAction } from '@/lib/run-action';
import type { ActionResult } from '@/lib/action-result';
import type { SetupImportType } from '@/lib/import/limits';
import {
  bulkImportAssignments, bulkImportChargeCodeAccess, bulkImportChargeCodes, bulkImportClins, bulkImportContracts, bulkImportEmployees,
  bulkImportLaborCategories, type ImportOptions, type ImportResult,
} from '@/server/actions/import';
import { nounFor, type SetupTypeDef } from './import-types';
import { counts, mergeCheck, NOTHING_TO_IMPORT, prepareSetupFile, setupPayloadRow } from './pipeline';
import type { PipelineEvent, PipelineState } from './pipeline-state';
import { ActionError, BLOCKED_ID, CheckResults, DoneResults, FileStep, PasswordsModal } from './ImportParts';
import classes from './Import.module.css';

type SetupAction = (rows: never[], options: ImportOptions) => Promise<ActionResult<ImportResult>>;
function actionFor(key: SetupImportType): SetupAction {
  switch (key) {
    case 'people': return bulkImportEmployees as SetupAction;
    case 'contracts': return bulkImportContracts as SetupAction;
    case 'clins': return bulkImportClins as SetupAction;
    case 'laborCategories': return bulkImportLaborCategories as SetupAction;
    case 'chargeCodes': return bulkImportChargeCodes as SetupAction;
    case 'chargeCodeAccess': return bulkImportChargeCodeAccess as SetupAction;
    case 'approvalScope': return bulkImportAssignments as SetupAction;
  }
}

/**
 * A setup type's pipeline (feature-plan-ux-setup-import.md §4.2): a file is checked by the server automatically (the
 * real import, rolled back — P9), then Import sends only the ready rows. Rows a browser check refused are shown with
 * their problem and never sent.
 */
export function SetupPipeline({ def, state, dispatch, onImported }: {
  def: SetupTypeDef;
  state: PipelineState;
  dispatch: (e: PipelineEvent) => void;
  onImported: () => void;
}) {
  const busy = useBusy();
  const started = useRef(-1);
  const [clickError, setClickError] = useState<string | null>(null);
  const [passwordsOpen, setPasswordsOpen] = useState(false);
  const action = actionFor(def.key);

  // Step 2: the check runs once per new file (or "Check again"), tagged with the state's token.
  useEffect(() => {
    if (state.phase !== 'checking' || started.current === state.token) return;
    started.current = state.token;
    const { token, rows } = state;
    const payload = rows.filter((r) => r.clientError === null).map((r) => setupPayloadRow(def, r));
    void (async () => {
      if (payload.length === 0) { dispatch({ type: 'checkSucceeded', token, checked: mergeCheck(rows, { errors: [], skippedRows: [] }) }); return; }
      const res = await runAction(action(payload as never[], { dryRun: true }), { silent: true });
      dispatch(res.ok ? { type: 'checkSucceeded', token, checked: mergeCheck(rows, res.data) } : { type: 'checkFailed', token, error: res.error });
    })();
  }, [state, def, action, dispatch]);

  // Step 3: the import sends the ready rows only.
  useEffect(() => {
    if (state.phase !== 'importing' || started.current === state.token) return;
    started.current = state.token;
    const token = state.token;
    const ready = state.checked.filter((r) => r.outcome.kind === 'ready').map((r) => setupPayloadRow(def, r));
    void busy.run('import', async () => {
      const res = await runAction(action(ready as never[], {}), { silent: true });
      if (!res.ok) { dispatch({ type: 'importFailed', token, error: res.error }); return; }
      dispatch({ type: 'importSucceeded', token, done: res.data });
      if ((res.data.generatedPasswords?.length ?? 0) > 0) setPasswordsOpen(true);
      onImported();
    });
  }, [state, def, action, dispatch, busy, onImported]);

  const ready = counts(state.checked).ready;
  const importing = state.phase === 'importing';

  function startImport() {
    if (importing) return;
    if (ready === 0) { setClickError(NOTHING_TO_IMPORT); return; }
    setClickError(null);
    dispatch({ type: 'importStarted' });
  }

  const columns = (
    <>Columns: <span className={classes.mono}>{def.required.map((c) => c.header).join(', ')}</span>
      {def.optional.length > 0 && <>; optional <span className={classes.mono}>{def.optional.map((c) => c.header).join(', ')}</span></>}.</>
  );

  return (
    <Stack gap="md">
      <FileStep def={def} columns={columns} state={state} dispatch={dispatch} prepare={(text) => prepareSetupFile(text, def)} />
      <ActionError state={state} dispatch={dispatch} />
      {state.phase === 'checking' && (
        <Text size="sm" c="dimmed" role="status" aria-busy="true" data-testid="checking">Checking {state.rows.length} {state.rows.length === 1 ? 'row' : 'rows'}…</Text>
      )}
      {(state.phase === 'checked' || importing) && (
        <>
          <CheckResults rows={state.checked} headers={state.headers} keyColumns={def.keyColumns} fileName={state.fileName} />
          <Group justify="flex-end" gap="sm">
            {clickError && <Text size="sm" c="red" role="alert" id="import-click-error">{clickError}</Text>}
            <WriteButton {...busy.props('import')} aria-describedby={importing ? BLOCKED_ID : clickError ? 'import-click-error' : undefined}
              onClick={startImport}>
              Import {ready} {nounFor(def, ready)}
            </WriteButton>
          </Group>
        </>
      )}
      {state.phase === 'done' && state.done && (
        <DoneResults
          done={state.done}
          onAgain={() => { setPasswordsOpen(false); dispatch({ type: 'reset' }); }}
          extra={(state.done.generatedPasswords?.length ?? 0) > 0
            ? <Button variant="light" onClick={() => setPasswordsOpen(true)}>View generated passwords</Button>
            : null}
        />
      )}
      <PasswordsModal opened={passwordsOpen} onClose={() => setPasswordsOpen(false)} importResult={state.done} />
    </Stack>
  );
}
