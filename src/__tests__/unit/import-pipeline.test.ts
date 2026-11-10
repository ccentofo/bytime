import { describe, it, expect } from 'vitest';
import {
  checkSummary, counts, mergeCheck, prepareHistoryFile, prepareSetupFile, problemsCsv, setupPayloadRow, tableRows, type CheckedRow, type PreparedRow,
} from '@/app/(app)/settings/import/pipeline';
import { currentStep, initialPipeline, pipelineReducer, type PipelineEvent, type PipelineState } from '@/app/(app)/settings/import/pipeline-state';
import { importTypeFrom, typeDef, type HistoryTypeDef, type SetupTypeDef } from '@/app/(app)/settings/import/import-types';

/**
 * feature-plan-ux-setup-import.md §4.2, §4.4, §5 — the Import page's pure pipeline (no rendering):
 * IM-4  (browser) spreadsheet row numbers, kept after the browser's own skips; refused rows are never sent.
 * IM-9  (browser) over 1,000 rows refused before anything is sent; IM-18 (browser) Approval scope over 500.
 * IM-10 "Download rows with problems": the original columns + Problem, formula-guarded.
 * IM-11 the pipeline states per §5, including "change type drops a late result" and "nothing changes while importing".
 * IM-13 (part) `?type=`: a known type, else People.
 * IM-16 (browser) skipped rows are listed with their reason and never counted as ready.
 * IM-20 Hours: a missing header is refused in the browser; rows with a blank optional cell are kept and numbered.
 */

const people = typeDef('people') as SetupTypeDef;
const scope = typeDef('approvalScope') as SetupTypeDef;
const contracts = typeDef('contracts') as SetupTypeDef;
const hours = typeDef('hours') as HistoryTypeDef;
const csv = (header: string, rows: string[]) => `${header}\n${rows.join('\n')}\n`;
const ok = (f: ReturnType<typeof prepareSetupFile>) => { if (!f.ok) throw new Error(f.error); return f; };

describe('IM-4 / IM-9 / IM-18: preparing a setup file', () => {
  it('IM-4: rows are spreadsheet rows (header = 1); a refused row keeps its number and is not in the payload', () => {
    const f = ok(prepareSetupFile(csv('Name,Email,Role,FLSA Exempt', ['Ann,ann@x.test,Employee,No', 'Bob,,Employee,No', 'Cat,cat@x.test,Admin,Yes']), people));
    expect(f.rows.map((r) => [r.row, r.clientError])).toEqual([[2, null], [3, 'Email is required'], [4, null]]);
    const payload = f.rows.filter((r) => r.clientError === null).map((r) => setupPayloadRow(people, r));
    expect(payload).toEqual([
      { row: 2, name: 'Ann', email: 'ann@x.test', role: 'Employee', flsaExempt: 'No' },
      { row: 4, name: 'Cat', email: 'cat@x.test', role: 'Admin', flsaExempt: 'Yes' },
    ]);
  });

  it('a control character refuses the row in the browser with the server\'s message', () => {
    const f = ok(prepareSetupFile(csv('Name,Email,Role,FLSA Exempt', ['Ann,ann@x.test,Employee,No', 'Nul,n\u0000@x.test,Employee,No']), people));
    expect(f.rows[1].clientError).toBe('Row 3 contains an invalid character.');
  });

  it('optional columns may be missing or blank (P12): only the required ones are checked', () => {
    const f = ok(prepareSetupFile(csv('Contract Number,Name', ['K-1,One']), contracts));
    expect(f.rows[0].clientError).toBeNull();
    expect(setupPayloadRow(contracts, f.rows[0])).toEqual({ row: 2, contractNumber: 'K-1', name: 'One', type: '', fundedValue: '', ceilingValue: '', startDate: '', endDate: '' });
  });

  it('IM-9: 1,001 rows are refused before anything is sent; 1,000 are accepted', () => {
    const many = (n: number) => csv('Contract Number,Name', Array.from({ length: n }, (_, i) => `K-${i},Name`));
    expect(prepareSetupFile(many(1001), contracts)).toEqual({ ok: false, error: 'This file has 1001 rows. Split it into files of 1000 rows or fewer.' });
    expect(prepareSetupFile(many(1000), contracts).ok).toBe(true);
  });

  it('IM-18: an Approval scope file of 501 rows is refused; 500 is accepted', () => {
    const many = (n: number) => csv('Email,Contract Number,CLIN Number', Array.from({ length: n }, (_, i) => `s${i}@x.test,K,0001`));
    expect(prepareSetupFile(many(501), scope)).toEqual({ ok: false, error: 'This file has 501 rows. Split it into files of 500 rows or fewer.' });
    expect(prepareSetupFile(many(500), scope).ok).toBe(true);
  });

  it('P13: a payload over 800 KB is refused even under the row limit', () => {
    const name = 'N'.repeat(1000);
    const f = prepareSetupFile(csv('Contract Number,Name', Array.from({ length: 900 }, (_, i) => `K-${i},${name}`)), contracts);
    expect(f).toEqual({ ok: false, error: 'This file is too large to send in one go. Split it into smaller files.' });
  });

  it('missing required columns and an empty file are refused', () => {
    expect(prepareSetupFile('Name,Email\nAnn,a@x.test\n', people)).toEqual({ ok: false, error: 'This file is missing required columns: Role, FLSA Exempt.' });
    expect(prepareSetupFile('Name,Email,Role,FLSA Exempt\n', people)).toEqual({ ok: false, error: 'This file has no rows under the header.' });
  });
});

describe('IM-16 / IM-10: the check result', () => {
  const rows: PreparedRow[] = [2, 3, 4, 5].map((row) => ({ row, data: { Name: `P${row}`, Email: `p${row}@x.test`, Role: 'Employee', 'FLSA Exempt': 'No' }, clientError: row === 5 ? 'Email is required' : null }));
  const checked = mergeCheck(rows, { errors: [{ row: 3, message: 'Role must be Employee, Supervisor or Admin.' }], skippedRows: [{ row: 4, reason: 'Already a user' }] });

  it('IM-16: each row\'s outcome; skipped rows are not ready', () => {
    expect(checked.map((r) => [r.row, r.outcome])).toEqual([
      [2, { kind: 'ready' }],
      [3, { kind: 'problem', message: 'Role must be Employee, Supervisor or Admin.' }],
      [4, { kind: 'skip', reason: 'Already a user' }],
      [5, { kind: 'problem', message: 'Email is required' }],
    ]);
    expect(counts(checked)).toEqual({ ready: 1, problems: 2, skipped: 1 });
    expect(checkSummary(checked)).toEqual({
      text: "1 row is ready. 2 rows have problems and won't be imported unless you fix them in the file and choose it again. 1 row will be skipped because it already exists.",
      warn: true,
    });
  });

  it('the table: problems first, then skips, then the first 50 ready rows ("Show all" shows the rest)', () => {
    const many: CheckedRow[] = Array.from({ length: 60 }, (_, i) => ({ row: i + 2, data: {}, clientError: null, outcome: { kind: 'ready' } }));
    many[30] = { ...many[30], outcome: { kind: 'problem', message: 'x' } };
    many[10] = { ...many[10], outcome: { kind: 'skip', reason: 'y' } };
    const { visible, hiddenReady } = tableRows(many, false);
    expect(visible.slice(0, 2).map((r) => r.row)).toEqual([32, 12]);
    expect([visible.length, hiddenReady]).toEqual([52, 8]);
    expect(tableRows(many, true)).toMatchObject({ hiddenReady: 0 });
    expect(checkSummary(many.filter((r) => r.outcome.kind === 'ready'))).toEqual({ text: 'All 58 rows are ready.', warn: false });
  });

  it('IM-10: rows with problems keep their original columns plus Problem; a formula is never left live', () => {
    const withFormula = mergeCheck([
      { row: 2, data: { Name: '=HYPERLINK("http://x")', Email: 'a@x.test', Extra: 'kept' }, clientError: null },
      { row: 3, data: { Name: 'Fine', Email: 'b@x.test', Extra: '' }, clientError: null },
    ], { errors: [{ row: 2, message: 'Email "a,b" is odd' }], skippedRows: [] });
    const text = problemsCsv(withFormula, ['Name', 'Email', 'Extra']);
    const [header, ...lines] = text.split('\n');
    expect(header).toBe('Name,Email,Extra,Problem');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/^"?=/);                      // the formula guard prefixes the cell
    expect(lines[0]).toContain('kept');
    expect(lines[0]).toContain('"Email ""a,b"" is odd"');      // RFC 4180 quoting
  });
});

describe('IM-20: Hours files', () => {
  it('a missing header is refused in the browser; blank optional cells are kept, every row numbered from 1', () => {
    expect(prepareHistoryFile('Employee Email,Entry Date,Contract Number,CLIN Number,Hours\na@x.test,2025-01-06,K,0001,8\n', hours))
      .toEqual({ ok: false, error: 'This file is missing required columns: Indirect Code.' });
    const f = prepareHistoryFile(csv('Employee Email,Entry Date,Contract Number,CLIN Number,Indirect Code,Hours', ['a@x.test,2025-01-06,K,0001,,8', 'a@x.test,2025-01-06,,,OH-001,1', ',,,,,']), hours);
    expect(f.ok && f.rows.map((r) => [r.row, r.data['Indirect Code'], r.clientError])).toEqual([[1, '', null], [2, 'OH-001', null], [3, '', null]]);
  });
});

describe('IM-11: the pipeline states (§5)', () => {
  const rows: PreparedRow[] = [{ row: 2, data: {}, clientError: null }];
  const readyRows: CheckedRow[] = [{ ...rows[0], outcome: { kind: 'ready' } }];
  const run = (events: PipelineEvent[], from: PipelineState = initialPipeline) => events.reduce(pipelineReducer, from);
  const accepted: PipelineEvent = { type: 'fileAccepted', fileName: 'a.csv', headers: ['Name'], rows };

  it('empty → checking → checked → importing → done → empty, with the step row following', () => {
    let s = run([accepted]);
    expect([s.phase, currentStep(s.phase)]).toEqual(['checking', 'Check rows']);
    s = run([{ type: 'checkSucceeded', token: s.token, checked: readyRows }], s);
    expect(s.phase).toBe('checked');
    s = run([{ type: 'importStarted' }], s);
    expect([s.phase, currentStep(s.phase)]).toEqual(['importing', 'Import']);
    s = run([{ type: 'importSucceeded', token: s.token, done: { created: 1, skipped: 0, errors: [] } }], s);
    expect([s.phase, currentStep(s.phase), s.done?.created]).toEqual(['done', 'Done', 1]);
    expect(run([{ type: 'reset' }], s)).toMatchObject({ phase: 'empty', rows: [], done: null });
  });

  it('a rejected file stays empty with its error; a failed check goes back to empty with the file kept ("Check again")', () => {
    expect(run([{ type: 'fileRejected', fileName: 'b.csv', error: 'missing' }])).toMatchObject({ phase: 'empty', fileError: 'missing', fileName: 'b.csv' });
    let s = run([accepted]);
    s = run([{ type: 'checkFailed', token: s.token, error: 'offline' }], s);
    expect(s).toMatchObject({ phase: 'empty', actionError: 'offline', rows });
    s = run([{ type: 'checkAgain' }], s);
    expect(s).toMatchObject({ phase: 'checking', actionError: null });
  });

  it('change type (or a new file) while checking drops the late result', () => {
    const checking = run([accepted]);
    const moved = run([{ type: 'typeChanged' }], checking);
    expect(run([{ type: 'checkSucceeded', token: checking.token, checked: readyRows }], moved)).toMatchObject({ phase: 'empty', checked: [] });
    const other = run([{ type: 'reset' }, accepted], checking);
    expect(run([{ type: 'checkSucceeded', token: checking.token, checked: readyRows }], other).phase).toBe('checking');
  });

  it('while importing nothing changes the file or the type; a failed import goes back to checked', () => {
    let s = run([accepted]);
    s = run([{ type: 'checkSucceeded', token: s.token, checked: readyRows }, { type: 'importStarted' }], s);
    for (const e of [{ type: 'typeChanged' }, { type: 'reset' }, accepted, { type: 'fileRejected', fileName: 'x', error: 'x' }] as PipelineEvent[]) {
      expect(run([e], s)).toBe(s);
    }
    expect(run([{ type: 'importFailed', token: s.token, error: 'seats' }], s)).toMatchObject({ phase: 'checked', actionError: 'seats', checked: readyRows });
  });

  it('Import needs a ready row', () => {
    let s = run([accepted]);
    s = run([{ type: 'checkSucceeded', token: s.token, checked: [{ ...rows[0], outcome: { kind: 'problem', message: 'x' } }] }], s);
    expect(run([{ type: 'importStarted' }], s).phase).toBe('checked');
  });

  it('IM-13 (part): ?type= picks a known type, else People', () => {
    expect([importTypeFrom('hours'), importTypeFrom('chargeCodeAccess'), importTypeFrom('nope'), importTypeFrom(null)]).toEqual(['hours', 'chargeCodeAccess', 'people', 'people']);
  });
});
