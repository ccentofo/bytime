import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { Icons, ICON_ALIASES } from '@/components/ui/icons';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-ux-foundations.md §4.3 / T13: the icon registry ratchet. Only icons.ts and ICON_IMPORT_ALLOWLIST may
 * import '@tabler/icons-react'; an allowlisted file that no longer imports it fails too, so the list only shrinks.
 * Two registry keys may share a component only through ICON_ALIASES.
 */

const ROOT = path.resolve(__dirname, '../../..');
const REGISTRY = 'src/components/ui/icons.ts';

export const ICON_IMPORT_ALLOWLIST = [
  'src/app/(app)/AppShellWrapper.tsx',
  'src/app/(app)/BillingWall.tsx',
  'src/app/(app)/OnHoldScreen.tsx',
  'src/app/(app)/PolicyHoldScreen.tsx',
  'src/app/(app)/settings/billing/BillingClient.tsx',
  'src/app/(app)/admin/error.tsx',
  'src/app/(app)/settings/import/ImportClient.tsx',
  'src/app/(app)/settings/integrations/IntegrationsClient.tsx',
  'src/app/(app)/settings/integrations/gusto/GustoConfigClient.tsx',
  'src/app/(app)/admin/payroll-export/PayrollExportClient.tsx',
  'src/app/(app)/settings/integrations/quickbooks/QBOConfigClient.tsx',
  'src/app/(app)/settings/migration/MigrationClient.tsx',
  'src/app/(app)/profile/notifications/NotificationsClient.tsx',
  'src/app/(app)/admin/reports/ReportsClient.tsx',
  'src/app/(app)/admin/setup/SetupWizardClient.tsx',
  'src/app/(app)/error.tsx',
  'src/app/(app)/profile/MFASetup.tsx',
  'src/app/(app)/profile/ProfileClient.tsx',
  'src/app/(app)/timesheet/error.tsx',
  'src/app/error.tsx',
  'src/app/forgot-password/ForgotPasswordForm.tsx',
  'src/app/login/LoginForm.tsx',
  'src/app/page.tsx',
  'src/app/privacy/page.tsx',
  'src/app/reset-password/ResetPasswordForm.tsx',
  'src/app/signup/SignupForm.tsx',
  'src/app/terms/page.tsx',
  'src/components/approvals/ApprovalNotices.tsx',
  'src/components/approvals/ReviewDecisionButtons.tsx',
  'src/components/auth/SignOutButton.tsx',
  'src/components/auth/WorkspaceFinder.tsx',
  'src/components/shell/SyncStatusIndicator.tsx',
  'src/components/timesheet/PayPeriodSelector.tsx',
  'src/components/timesheet/SubmitModal.tsx',
  'src/components/timesheet/TimesheetDashboard.tsx',
  'src/components/timesheet/TimesheetToolbar.tsx',
  'src/components/timesheet/cells/HourCell.tsx',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}
/** Any import of tabler: static, deep path, side-effect, dynamic import() or require() (UX-1 audit L4). */
export const importsTabler = (src: string) =>
  /(from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]@tabler\/icons-react(\/[^'"]*)?['"]/.test(stripComments(src));

describe('icon registry ratchet (T13)', () => {
  it('only icons.ts and the allowlist import @tabler/icons-react', () => {
    const allowed = new Set([REGISTRY, ...ICON_IMPORT_ALLOWLIST]);
    const offenders = sourceFiles(path.join(ROOT, 'src')).map((f) => path.relative(ROOT, f))
      .filter((rel) => !allowed.has(rel) && importsTabler(readFileSync(path.join(ROOT, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('every allowlisted file still imports tabler (the list can only shrink)', () => {
    const stale = ICON_IMPORT_ALLOWLIST.filter((rel) => !importsTabler(readFileSync(path.join(ROOT, rel), 'utf8')));
    expect(stale).toEqual([]);
    expect(new Set(ICON_IMPORT_ALLOWLIST).size).toBe(ICON_IMPORT_ALLOWLIST.length);
  });

  it('fixture (L4): static, deep-path, side-effect, dynamic and require imports all count as importing tabler', () => {
    expect(importsTabler("import { IconX } from '@tabler/icons-react';")).toBe(true);
    expect(importsTabler("import IconX from '@tabler/icons-react/dist/esm/icons/IconX';")).toBe(true);
    expect(importsTabler("import '@tabler/icons-react';")).toBe(true);
    expect(importsTabler("const t = await import('@tabler/icons-react');")).toBe(true);
    expect(importsTabler("const t = require('@tabler/icons-react');")).toBe(true);
    expect(importsTabler("import { Icons } from '@/components/ui/icons'; // not @tabler/icons-react")).toBe(false);
  });

  it('two keys share a component only through ICON_ALIASES (each with a reason)', () => {
    const aliased = new Set(ICON_ALIASES.map((a) => [...a.keys].sort().join('|')));
    for (const a of ICON_ALIASES) expect(a.reason.length, a.keys.join('/')).toBeGreaterThan(10);
    const keys = Object.keys(Icons) as Array<keyof typeof Icons>;
    const dupes: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (Icons[keys[i]] === Icons[keys[j]] && !aliased.has([keys[i], keys[j]].sort().join('|'))) dupes.push(`${keys[i]} / ${keys[j]}`);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('the required meanings map to the required icons; banned choices are absent', async () => {
    const t = await import('@tabler/icons-react');
    expect(Icons.edit).toBe(t.IconPencil);
    expect(Icons.reactivate).toBe(t.IconRestore);
    expect(Icons.laborCategory).toBe(t.IconBriefcase);
    expect(Icons.rates).toBe(t.IconCurrencyDollar);
    expect(Icons.moreActions).toBe(t.IconDots);
    expect(Icons.endAssignment).toBe(t.IconCalendarX);
    expect(Icons.revokeKey).toBe(t.IconKeyOff);
    expect(Icons.resetPassword).toBe(t.IconPassword);
    expect(Icons.sync).toBe(t.IconArrowsExchange);
    expect(Icons.automate).toBe(t.IconWand);
    expect(Icons.correction).toBe(t.IconPencilCog); // L11: not a second plain pencil next to edit
    expect(Object.values(Icons)).not.toContain(t.IconEdit);
    expect(Object.values(Icons)).not.toContain(t.IconToggleLeft);
    expect(Icons.laborCategory).not.toBe(t.IconTag);
    expect(Icons.reactivate).not.toBe(t.IconRefresh);
    for (const k of ['create', 'edit', 'delete', 'deactivate', 'reactivate', 'moreActions', 'rates', 'laborCategory', 'history', 'resetPassword', 'unlock', 'flsa', 'manageClins', 'revokeKey', 'endAssignment', 'search', 'download', 'upload', 'view', 'copy', 'approve', 'reject', 'statusError', 'statusWarning', 'statusInfo', 'statusSuccess', 'automate', 'sync', 'refresh']) {
      expect(Icons, k).toHaveProperty(k);
    }
  });
});
