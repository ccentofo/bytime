import 'server-only';
import { and, desc, eq, gte, inArray, lt, type SQL } from 'drizzle-orm';
import type { DbTx, ReadDb } from '@/db';
import { chargeCodes, clins, contracts, indirectChargeCodes, slins, timesheetEntries, timesheetNotes, userChargeCodes } from '@/db/schema';
import { addDays, diffDays, formatCalendarDate, isAfter, type CalendarDate } from '@/lib/calendar-date';
import { ConflictError, UserFacingError } from '@/lib/errors';
import { isUniqueViolation } from '@/lib/db-errors';
import { validateUUID } from '@/lib/validation';
import { CHARGEABLE_CODE } from './chargeable';

/**
 * Timesheet notes (feature-plan-ux-timesheet.md A4.1–A4.3, UX3-D1): one note per cell, append-only revisions, saved in
 * saveTimesheetBatch's transaction and locked with the period. INTERNAL, no guard: the save authorizes (requireSession;
 * own data only) and holds the employee lock; the readers serve the session user's own timesheet or a review that
 * already passed assertCanAccessEmployee.
 */

export const NOTE_MAX_LENGTH = 1000;
export const NOTE_TOO_LONG = `A note can be at most ${NOTE_MAX_LENGTH} characters.`;
export const NOTE_FUTURE_DATE = 'Notes can\'t be added to future dates.';
export const NOTE_ROW_NOT_ELIGIBLE = 'You can only add notes to rows on your timesheet.';

/** A note as the client sends it: the same cell reference as a save cell, plus the revision it last read (0 = none). */
export interface NoteInput {
  chargeCodeId?: string;
  indirectCodeId?: string;
  clinId?: string;
  dayIndex: number;
  body: string;
  expectedRevision: number;
}

type Kind = 'charge' | 'indirect' | 'clin';
export interface ValidNote { kind: Kind; codeId: string; dayIndex: number; entryDate: CalendarDate; body: string; expectedRevision: number; key: string }
type Reader = Pick<ReadDb, 'select'>;

/** The note's map key, the same as the client's cell key: `{rowId}-{dayIndex}`. */
export const noteKey = (rowId: string, dayIndex: number) => `${rowId}-${dayIndex}`;

/**
 * Shape checks BEFORE the transaction (A4.2): dayIndex inside the period, exactly one code reference (a UUID), the body
 * a string — trimmed, at most 1000 characters — no future dates, a whole-number expectedRevision, each cell once.
 */
export function validateNotes(notes: unknown, start: CalendarDate, numDays: number, today: CalendarDate): ValidNote[] {
  if (notes === undefined) return [];
  if (!Array.isArray(notes)) throw new UserFacingError('Notes must be a list.');
  const seen = new Set<string>();
  return notes.map((raw): ValidNote => {
    const n = (raw ?? {}) as Partial<NoteInput>;
    if (!Number.isInteger(n.dayIndex) || n.dayIndex! < 0 || n.dayIndex! >= numDays) {
      throw new UserFacingError(`Invalid day index ${String(n.dayIndex)} for this pay period.`);
    }
    const refs = ([['charge', n.chargeCodeId], ['indirect', n.indirectCodeId], ['clin', n.clinId]] as const).filter(([, id]) => Boolean(id));
    if (refs.length !== 1) throw new UserFacingError('Each note must reference exactly one charge code, CLIN, or indirect code.');
    const [kind, codeId] = refs[0] as [Kind, string];
    validateUUID(codeId, 'Code ID');
    if (typeof n.body !== 'string') throw new UserFacingError('A note must be text.');
    const body = n.body.trim();
    if (body.length > NOTE_MAX_LENGTH) throw new UserFacingError(NOTE_TOO_LONG);
    if (!Number.isInteger(n.expectedRevision) || n.expectedRevision! < 0) throw new UserFacingError('Invalid note revision.');
    const entryDate = addDays(start, n.dayIndex!);
    if (isAfter(entryDate, today)) throw new UserFacingError(NOTE_FUTURE_DATE);
    const key = noteKey(codeId, n.dayIndex!);
    if (seen.has(key)) throw new UserFacingError('Each note can appear only once in a save.');
    seen.add(key);
    return { kind, codeId, dayIndex: n.dayIndex!, entryDate, body, expectedRevision: n.expectedRevision!, key };
  });
}

/** One note cell: the column for its kind (the CHECK guarantees the other two are null). */
function noteCellWhere(userId: string, kind: Kind, codeId: string, entryDate: CalendarDate): SQL {
  const column = kind === 'charge' ? timesheetNotes.chargeCodeId : kind === 'indirect' ? timesheetNotes.indirectCodeId : timesheetNotes.clinId;
  return and(eq(timesheetNotes.userId, userId), eq(timesheetNotes.entryDate, entryDate), eq(column, codeId))!;
}

/**
 * Write the batch's notes INSIDE saveTimesheetBatch's transaction (after the lock and the period-lock check, which
 * includes the note dates). Eligibility is read through `tx` — never getPeriodCodesForEmployee (a second connection
 * while holding the lock). Per note: optimistic check against `expectedRevision` (unless skipConflictCheck), a no-op
 * when the latest body is unchanged, else insert latest + 1. Returns key → new revision for every note written.
 */
export async function writeNotes(
  tx: DbTx,
  o: { userId: string; actorId: string; start: CalendarDate; numDays: number; notes: ValidNote[]; skipConflictCheck?: boolean },
): Promise<Record<string, number>> {
  const written: Record<string, number> = {};
  if (o.notes.length === 0) return written;
  await assertNotesEligible(tx, o.userId, o.start, o.numDays, o.notes);

  for (const note of o.notes) {
    const where = noteCellWhere(o.userId, note.kind, note.codeId, note.entryDate);
    const [latest] = await tx.select({ revision: timesheetNotes.revisionNumber, body: timesheetNotes.body })
      .from(timesheetNotes).where(where).orderBy(desc(timesheetNotes.revisionNumber)).limit(1);
    const latestRevision = latest?.revision ?? 0;
    if (!o.skipConflictCheck && latestRevision !== note.expectedRevision) {
      throw new ConflictError(
        `Conflict detected: the note for ${formatCalendarDate(note.entryDate, 'MMM D, YYYY')} was changed in another session (expected revision ${note.expectedRevision}, but the server has revision ${latestRevision}). Please refresh your timesheet and re-enter your changes.`,
      );
    }
    if ((latest?.body ?? '') === note.body) continue; // unchanged (incl. clearing a note that doesn't exist): no-op
    try {
      await tx.insert(timesheetNotes).values({
        userId: o.userId,
        entryDate: note.entryDate,
        chargeCodeId: note.kind === 'charge' ? note.codeId : null,
        indirectCodeId: note.kind === 'indirect' ? note.codeId : null,
        clinId: note.kind === 'clin' ? note.codeId : null,
        body: note.body,
        revisionNumber: latestRevision + 1,
        createdBy: o.actorId,
      });
    } catch (err) {
      if (isUniqueViolation(err, 'timesheet_notes_cell_rev_unique_idx')) {
        throw new ConflictError(`Conflict detected: the note for ${formatCalendarDate(note.entryDate, 'MMM D, YYYY')} was changed in another session. Please refresh your timesheet and re-enter your changes.`);
      }
      throw err;
    }
    written[note.key] = latestRevision + 1;
  }
  return written;
}

/**
 * A note may go on a row the employee's timesheet shows for this period (A4.2): a charge code they're actively assigned
 * to that passes CHARGEABLE_CODE, an active available-to-all indirect code, or any code (incl. a legacy CLIN) with an
 * entry or a note in the period. Four reads, whatever the batch size.
 */
async function assertNotesEligible(tx: DbTx, userId: string, start: CalendarDate, numDays: number, notes: ValidNote[]): Promise<void> {
  const ids = (kind: Kind) => [...new Set(notes.filter((n) => n.kind === kind).map((n) => n.codeId))];
  const chargeIds = ids('charge');
  const indirectIds = ids('indirect');
  const inPeriod = (col: typeof timesheetEntries.entryDate | typeof timesheetNotes.entryDate) => and(gte(col, start), lt(col, addDays(start, numDays)));

  const [assignable, available, entryRows, noteRows] = await Promise.all([
    chargeIds.length === 0 ? [] : tx.select({ id: chargeCodes.id }).from(userChargeCodes)
      .innerJoin(chargeCodes, eq(userChargeCodes.chargeCodeId, chargeCodes.id))
      .innerJoin(clins, eq(chargeCodes.clinId, clins.id))
      .innerJoin(contracts, eq(clins.contractId, contracts.id))
      .leftJoin(slins, eq(chargeCodes.slinId, slins.id))
      .where(and(eq(userChargeCodes.userId, userId), eq(userChargeCodes.isActive, true), inArray(chargeCodes.id, chargeIds), CHARGEABLE_CODE)),
    indirectIds.length === 0 ? [] : tx.select({ id: indirectChargeCodes.id }).from(indirectChargeCodes)
      .where(and(inArray(indirectChargeCodes.id, indirectIds), eq(indirectChargeCodes.isActive, true), eq(indirectChargeCodes.availableToAll, true))),
    tx.selectDistinct({ chargeCodeId: timesheetEntries.chargeCodeId, indirectCodeId: timesheetEntries.indirectCodeId, clinId: timesheetEntries.clinId })
      .from(timesheetEntries).where(and(eq(timesheetEntries.userId, userId), inPeriod(timesheetEntries.entryDate))),
    tx.selectDistinct({ chargeCodeId: timesheetNotes.chargeCodeId, indirectCodeId: timesheetNotes.indirectCodeId, clinId: timesheetNotes.clinId })
      .from(timesheetNotes).where(and(eq(timesheetNotes.userId, userId), inPeriod(timesheetNotes.entryDate))),
  ]);

  const ok = new Set<string>([...assignable.map((r) => `charge:${r.id}`), ...available.map((r) => `indirect:${r.id}`)]);
  for (const r of [...entryRows, ...noteRows]) ok.add(rowRef(r));
  for (const n of notes) if (!ok.has(`${n.kind}:${n.codeId}`)) throw new UserFacingError(NOTE_ROW_NOT_ELIGIBLE);
}

/** The row a stored entry/note belongs to: its charge code, else its indirect code, else its (legacy) CLIN. */
function rowRef(r: { chargeCodeId: string | null; indirectCodeId: string | null; clinId: string | null }): string {
  if (r.chargeCodeId) return `charge:${r.chargeCodeId}`;
  if (r.indirectCodeId) return `indirect:${r.indirectCodeId}`;
  return `clin:${r.clinId}`;
}

export type LatestNote = { chargeCodeId: string | null; indirectCodeId: string | null; clinId: string | null; dayIndex: number; body: string; revision: number };

/** The latest revision of every note cell in the period, cleared ('') bodies included. */
export async function latestNotesInPeriod(db: Reader, userId: string, start: CalendarDate, numDays: number): Promise<LatestNote[]> {
  const rows = await db
    .select({
      chargeCodeId: timesheetNotes.chargeCodeId, indirectCodeId: timesheetNotes.indirectCodeId, clinId: timesheetNotes.clinId,
      entryDate: timesheetNotes.entryDate, body: timesheetNotes.body, revision: timesheetNotes.revisionNumber,
    })
    .from(timesheetNotes)
    .where(and(eq(timesheetNotes.userId, userId), gte(timesheetNotes.entryDate, start), lt(timesheetNotes.entryDate, addDays(start, numDays))))
    .orderBy(desc(timesheetNotes.revisionNumber));
  const latest = new Map<string, LatestNote>();
  for (const r of rows) {
    const dayIndex = diffDays(start, r.entryDate as CalendarDate);
    const key = `${rowRef(r)}-${dayIndex}`;
    if (!latest.has(key)) latest.set(key, { chargeCodeId: r.chargeCodeId, indirectCodeId: r.indirectCodeId, clinId: r.clinId, dayIndex, body: r.body, revision: r.revision });
  }
  return [...latest.values()];
}

/** `getTimesheetPeriod` / `getTimesheetForReview`'s `notes` (A4.3): `{rowId}-{dayIndex}` → latest body and revision. */
export function notesMap(latest: LatestNote[]): Record<string, { body: string; revision: number }> {
  const out: Record<string, { body: string; revision: number }> = {};
  for (const n of latest) out[noteKey((n.chargeCodeId ?? n.indirectCodeId ?? n.clinId)!, n.dayIndex)] = { body: n.body, revision: n.revision };
  return out;
}

/** Code references whose latest note in the period is non-empty — they keep their row visible (A4.3). */
export function notedCodes(latest: LatestNote[]): Array<{ chargeCodeId: string | null; indirectCodeId: string | null; clinId: string | null }> {
  return latest.filter((n) => n.body !== '').map(({ chargeCodeId, indirectCodeId, clinId }) => ({ chargeCodeId, indirectCodeId, clinId }));
}
