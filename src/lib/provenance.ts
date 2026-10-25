/**
 * How an imported row is labelled wherever it is shown or exported (feature-plan-certified-outputs.md C1 "Display",
 * CO-D1: never displayed as if the employee typed it). Pure — used by the grid, review, audit trail, revision history,
 * PDF, workspace export and v1 API.
 */

export interface ProvenanceInput {
  source: string | null | undefined;
  changeReasonCode?: string | null;
  importSourceSystem?: string | null;
  importedAt?: Date | string | null;
  importedByName?: string | null;
  originalMetadata?: unknown;
}

export type ProvenanceKind = 'app' | 'migration' | 'legacy-import';

const day = (d: Date | string | null | undefined): string => {
  if (!d) return 'an unknown date';
  const s = typeof d === 'string' ? d : d.toISOString();
  return s.slice(0, 10);
};

function metadata(input: ProvenanceInput): { enteredBy: string | null; enteredAt: string | null } {
  const m = (input.originalMetadata && typeof input.originalMetadata === 'object' ? input.originalMetadata : {}) as Record<string, unknown>;
  return {
    enteredBy: typeof m.enteredBy === 'string' && m.enteredBy.trim() ? m.enteredBy : null,
    enteredAt: typeof m.enteredAt === 'string' && m.enteredAt.trim() ? m.enteredAt : null,
  };
}

/**
 * 'migration' = imported by this feature; 'legacy-import' = a row from the OLD importer (source defaulted to 'app',
 * author = the employee, reason MIGRATION) — labelled by reason code, never rewritten; otherwise 'app'.
 */
export function provenanceKind(input: ProvenanceInput): ProvenanceKind {
  if (input.source === 'migration') return 'migration';
  if (input.changeReasonCode === 'MIGRATION') return 'legacy-import';
  return 'app';
}

/** The label lines, or null for an app-recorded row. */
export function provenanceLines(input: ProvenanceInput): string[] | null {
  const kind = provenanceKind(input);
  if (kind === 'app') return null;
  if (kind === 'legacy-import') return ['Legacy import — details not recorded'];
  const { enteredBy, enteredAt } = metadata(input);
  return [
    `Imported from ${input.importSourceSystem ?? 'another system'} on ${day(input.importedAt)} by ${input.importedByName ?? 'an admin'}`,
    `originally entered by ${enteredBy ?? 'author not recorded'}${enteredAt ? ` on ${enteredAt}` : ''}`,
  ];
}

export function provenanceText(input: ProvenanceInput): string | null {
  return provenanceLines(input)?.join(' — ') ?? null;
}
