/**
 * `npm run provision:tenant` arguments (launch-blockers audit §5): a founder-provisioned workspace must carry the
 * Terms record from the customer's signed agreement — the tenant row is the proof of contract (LB-D5). Without
 * `--terms-version <v> --terms-accepted-at <ISO>` the command refuses, unless `--no-terms-record` is passed (then the
 * workspace's audit trail says it was provisioned without one). Pure, so it is unit-testable.
 */

export interface ProvisionArgs {
  slug: string;
  name: string;
  adminEmail: string;
  adminName: string;
  terms: { version: string; acceptedAt: Date } | 'none';
}

export const PROVISION_USAGE =
  'Usage: npm run provision:tenant -- <slug> <name> <admin-email> <admin-name> '
  + '(--terms-version <version> --terms-accepted-at <ISO date-time> | --no-terms-record)';

const VALUE_FLAGS = new Set(['--terms-version', '--terms-accepted-at']);

export function parseProvisionArgs(argv: string[]): ProvisionArgs | { error: string } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let noTermsRecord = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-terms-record') { noTermsRecord = true; continue; }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value.\n${PROVISION_USAGE}` };
      flags.set(a, v);
      i++;
      continue;
    }
    if (a.startsWith('--')) return { error: `Unknown option ${a}.\n${PROVISION_USAGE}` };
    positional.push(a);
  }
  const [slug, name, adminEmail, adminName] = positional;
  if (!slug || !name || !adminEmail || !adminName || positional.length > 4) return { error: PROVISION_USAGE };

  const version = flags.get('--terms-version')?.trim();
  const acceptedRaw = flags.get('--terms-accepted-at')?.trim();
  if (noTermsRecord) {
    if (version || acceptedRaw) return { error: 'Pass either the Terms record or --no-terms-record, not both.' };
    return { slug, name, adminEmail, adminName, terms: 'none' };
  }
  if (!version || !acceptedRaw) {
    return {
      error: 'Refusing: a founder-provisioned workspace needs the Terms record from the customer\'s signed agreement '
        + '(--terms-version <version> --terms-accepted-at <ISO date-time>). If there is genuinely none, pass '
        + '--no-terms-record (recorded on the workspace\'s audit trail).',
    };
  }
  if (version.length > 40) return { error: '--terms-version must be at most 40 characters.' };
  // An ISO 8601 date-time with an explicit offset or Z, so the acceptance instant is unambiguous.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(acceptedRaw) || Number.isNaN(Date.parse(acceptedRaw))) {
    return { error: `--terms-accepted-at must be an ISO date-time with a time zone, e.g. 2026-10-23T14:00:00Z (got "${acceptedRaw}").` };
  }
  // Date.parse rolls impossible days over (2026-02-30 → March 2); the calendar date itself must exist.
  const [y, m, d] = acceptedRaw.slice(0, 10).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) {
    return { error: `--terms-accepted-at is not a real date (got "${acceptedRaw}").` };
  }
  const acceptedAt = new Date(acceptedRaw);
  if (acceptedAt.getTime() > Date.now() + 5 * 60_000) return { error: '--terms-accepted-at is in the future.' };
  return { slug, name, adminEmail, adminName, terms: { version, acceptedAt } };
}
