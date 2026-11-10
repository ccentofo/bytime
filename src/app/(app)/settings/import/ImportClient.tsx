'use client';

import { useCallback, useEffect, useReducer, useState } from 'react';
import { Container } from '@mantine/core';
import { PageHeader } from '@/components/ui/PageHeader';
import { formatCount } from '@/lib/format';
import { getSetupPageData } from '@/server/actions/setup';
import { getImportWindowStatus } from '@/server/actions/migration';
import type { SetupPageData } from '@/server/internal/setup';
import { existingCount, HISTORY_TYPES, isNewType, SETUP_TYPES, typeDef, type ImportTypeDef, type ImportTypeKey } from './import-types';
import { initialPipeline, pipelineReducer } from './pipeline-state';
import { BLOCKED_ID, BLOCKED_REASON, StepRow } from './ImportParts';
import { SetupPipeline } from './SetupPipeline';
import { HistoryPipeline } from './HistoryPipeline';
import classes from './Import.module.css';

/**
 * The Import page (feature-plan-ux-setup-import.md P7, P8, §4): the nine types on the left (the setup types in order,
 * then past timesheets), the selected type's pipeline on the right. `?type=` follows the selection (replaceState). While
 * an import runs, the type can't change (§5) — the list is aria-disabled with the reason.
 */
export function ImportClient({ initialData, initialType }: { initialData: SetupPageData; initialType: ImportTypeKey }) {
  const [data, setData] = useState(initialData);
  const [type, setType] = useState<ImportTypeKey>(initialType);
  const [state, dispatch] = useReducer(pipelineReducer, initialPipeline);
  const [windowOpen, setWindowOpen] = useState<boolean | null | undefined>(undefined);
  const def = typeDef(type);
  const importing = state.phase === 'importing';

  // P14: read the window once, when a past-timesheets type is first shown.
  const needsWindow = def.kind === 'history' && windowOpen === undefined;
  useEffect(() => {
    if (!needsWindow) return;
    let live = true;
    getImportWindowStatus().then((s) => { if (live) setWindowOpen(s.open); }).catch(() => { if (live) setWindowOpen(null); });
    return () => { live = false; };
  }, [needsWindow]);

  function choose(key: ImportTypeKey) {
    if (importing || key === type) return;
    dispatch({ type: 'typeChanged' });
    setType(key);
    const url = new URL(window.location.href);
    url.searchParams.set('type', key);
    window.history.replaceState(window.history.state, '', url);
  }

  // After an import, the type list's counts (and the pay schedule flag) are refreshed.
  const refresh = useCallback(() => {
    getSetupPageData().then(setData).catch(() => { /* the counts stay as they were */ });
  }, []);

  const item = (t: ImportTypeDef) => {
    const n = existingCount(t.key, data);
    return (
      <li key={t.key}>
        <button type="button" className={classes.type} data-type={t.key} aria-current={t.key === type ? 'true' : undefined}
          aria-disabled={importing || undefined} aria-describedby={importing ? BLOCKED_ID : undefined} onClick={() => choose(t.key)}>
          <span className={classes.n} aria-hidden="true">{t.n}</span>
          <span>{t.label}</span>
          {n !== null && n > 0
            ? <span className={classes.meta}><span aria-hidden="true">✓ </span>{formatCount(n)}<span className={classes.srOnly}> already</span></span>
            : isNewType(t.key) ? <span className={classes.new}>New</span> : <span />}
        </button>
      </li>
    );
  };

  return (
    <Container size="lg" py="xl">
      <PageHeader title="Import" description="Bring in people, contracts and past timesheets from a spreadsheet. Every file is checked before anything is saved." />
      <div className={classes.layout}>
        <nav aria-label="Import types" className={classes.types} data-testid="import-types">
          <h2 className={classes.group}>Set up, in this order</h2>
          <ol className={classes.typeList}>{SETUP_TYPES.map(item)}</ol>
          <h2 className={classes.group}>Past timesheets</h2>
          <ol className={classes.typeList} start={8}>{HISTORY_TYPES.map(item)}</ol>
          {importing && <p className={classes.blocked} id={BLOCKED_ID}>{BLOCKED_REASON}</p>}
        </nav>
        <section aria-labelledby="import-type-title">
          <StepRow phase={state.phase} />
          {def.kind === 'setup'
            ? <SetupPipeline key={def.key} def={def} state={state} dispatch={dispatch} onImported={refresh} />
            : <HistoryPipeline key={def.key} def={def} state={state} dispatch={dispatch} windowOpen={windowOpen} payConfigSet={data.status.payConfigSet} onImported={refresh} />}
        </section>
      </div>
    </Container>
  );
}
