import type { CheckedRow, PreparedRow } from './pipeline';
import { counts } from './pipeline';

/**
 * The import pipeline's states (feature-plan-ux-setup-import.md §5), as a pure reducer. Every request carries the token
 * of the state that started it; a result whose token no longer matches (another file was chosen, the type changed, or
 * the user started over) is dropped. While importing, nothing can change the file or the type — a People import's
 * generated passwords must never be lost.
 */

export type Phase = 'empty' | 'checking' | 'checked' | 'importing' | 'done';

export interface DoneResult {
  created: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
  generatedPasswords?: Array<{ email: string; password: string }>;
  /** Hours / Timesheet status: the batch that was refused, if the import stopped partway. */
  stopped?: string | null;
}

export interface PipelineState {
  phase: Phase;
  token: number;
  fileName: string | null;
  headers: string[];
  /** The chosen file's rows (kept after a failed check, for "Check again"). */
  rows: PreparedRow[];
  checked: CheckedRow[];
  /** A problem with the file itself (parse, columns, limits): shown at the file input. */
  fileError: string | null;
  /** A check or import that failed as a whole (network, guard, seats): shown as an alert. */
  actionError: string | null;
  done: DoneResult | null;
}

export type PipelineEvent =
  | { type: 'fileRejected'; fileName: string | null; error: string }
  | { type: 'fileAccepted'; fileName: string; headers: string[]; rows: PreparedRow[] }
  | { type: 'checkSucceeded'; token: number; checked: CheckedRow[] }
  | { type: 'checkFailed'; token: number; error: string }
  | { type: 'checkAgain' }
  | { type: 'importStarted' }
  | { type: 'importSucceeded'; token: number; done: DoneResult }
  | { type: 'importFailed'; token: number; error: string }
  | { type: 'reset' }
  | { type: 'typeChanged' };

export const initialPipeline: PipelineState = {
  phase: 'empty', token: 0, fileName: null, headers: [], rows: [], checked: [], fileError: null, actionError: null, done: null,
};

const fresh = (s: PipelineState): PipelineState => ({ ...initialPipeline, token: s.token + 1 });

export function pipelineReducer(s: PipelineState, e: PipelineEvent): PipelineState {
  // Importing: only the import's own result moves on.
  if (s.phase === 'importing' && e.type !== 'importSucceeded' && e.type !== 'importFailed') return s;
  switch (e.type) {
    case 'fileRejected':
      return { ...fresh(s), fileName: e.fileName, fileError: e.error };
    case 'fileAccepted':
      return { ...fresh(s), phase: 'checking', fileName: e.fileName, headers: e.headers, rows: e.rows };
    case 'checkSucceeded':
      return s.phase === 'checking' && e.token === s.token ? { ...s, phase: 'checked', checked: e.checked, actionError: null } : s;
    case 'checkFailed':
      // §5: back to empty with the error; the file is kept so it can be checked again.
      return s.phase === 'checking' && e.token === s.token ? { ...s, phase: 'empty', actionError: e.error } : s;
    case 'checkAgain':
      return s.phase === 'empty' && s.rows.length > 0 ? { ...s, phase: 'checking', token: s.token + 1, actionError: null } : s;
    case 'importStarted':
      return s.phase === 'checked' && counts(s.checked).ready > 0 ? { ...s, phase: 'importing', token: s.token + 1, actionError: null } : s;
    case 'importSucceeded':
      return s.phase === 'importing' && e.token === s.token ? { ...s, phase: 'done', done: e.done } : s;
    case 'importFailed':
      // §5: back to the checked rows; nothing is assumed imported.
      return s.phase === 'importing' && e.token === s.token ? { ...s, phase: 'checked', actionError: e.error } : s;
    case 'reset':
    case 'typeChanged':
      return fresh(s);
  }
}

/** The step row (§4.1): which step is current. */
export const STEPS = ['Choose a file', 'Check rows', 'Import', 'Done'] as const;
export function currentStep(phase: Phase): (typeof STEPS)[number] {
  switch (phase) {
    case 'empty': return 'Choose a file';
    case 'checking': case 'checked': return 'Check rows';
    case 'importing': return 'Import';
    case 'done': return 'Done';
  }
}
