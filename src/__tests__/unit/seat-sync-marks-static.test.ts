import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { parseExportedFunctions, stripComments } from '../helpers/source-scanner';

/**
 * U8 (feature-plan-per-user-billing.md §6.5): the three actions that change the billable count mark the seat sync due
 * AFTER their tenant transaction (never inside it: a user change never fails or rolls back because of billing);
 * setUserApprover (no billable change) doesn't.
 */
const ROOT = path.resolve(__dirname, '../../..');
const body = (file: string, name: string) => {
  const fn = parseExportedFunctions(stripComments(readFileSync(path.join(ROOT, file), 'utf8'))).find((f) => f.name === name);
  if (!fn) throw new Error(`${name} not found in ${file}`);
  return fn.bodyText;
};

/** The source of the `db.transaction(` call (its full argument list), by paren matching. */
function transactionCall(text: string): { start: number; end: number } {
  const start = text.indexOf('db.transaction(');
  if (start === -1) throw new Error('no db.transaction( call');
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 'db.transaction'.length; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return { start, end: i };
  }
  throw new Error('unbalanced db.transaction(');
}

function marksAfterTransaction(text: string): boolean {
  const tx = transactionCall(text);
  const marks = [...text.matchAll(/\bmarkSeatSyncDue\s*\(/g)].map((m) => m.index!);
  return marks.length > 0 && marks.every((i) => i > tx.end);
}

describe('U8: seat-sync marks follow the user transaction', () => {
  it.each([
    ['src/server/actions/users.ts', 'updateUser'],
    ['src/server/actions/users.ts', 'createUserWithPassword'],
    ['src/server/actions/import.ts', 'bulkImportEmployees'],
  ])('%s %s calls markSeatSyncDue after its transaction', (file, name) => {
    expect(marksAfterTransaction(body(file, name))).toBe(true);
  });

  it('setUserApprover never marks (no billable change)', () => {
    expect(body('src/server/actions/users.ts', 'setUserApprover')).not.toMatch(/\bmarkSeatSyncDue\s*\(/);
  });

  it('fixture: a mark inside the transaction callback, or no mark, is caught', () => {
    expect(marksAfterTransaction('await db.transaction(async (tx) => { await markSeatSyncDue(id); }); x();')).toBe(false);
    expect(marksAfterTransaction('await db.transaction(async (tx) => { y(); });')).toBe(false);
    expect(marksAfterTransaction('await db.transaction(async (tx) => { y(")"); }); await markSeatSyncDue(id);')).toBe(true);
  });
});
