/**
 * Home's data shape and "Needs your attention" items (feature-plan-ux-navigation-home.md §4.5). Pure and client-safe:
 * the server builds HomeView (src/server/internal/home.ts), the page renders it, and the items are derived here so the
 * rules are unit-testable.
 */
import { formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { UNPRICED_REPORT_HREF } from '@/lib/cost-labels';
import { BURN_TIER_LABEL, NEEDS_A_LOOK, burnPercent, burnTier, type BurnTier } from '@/lib/ui/burn';

export type TeamBucket = 'submitted' | 'returned' | 'inProgress' | 'notStarted';
export type TeamStatus = Record<TeamBucket, { count: number; names: string[] }>;

export interface HomeContract {
  contractId: string;
  contractName: string;
  status: string;
  fundedValue: string | null;
  pricedCost: number;
  unpricedHours: number;
}

export interface HomeSetupStep { key: string; done: boolean; required: boolean }

export interface HomeView {
  userId: string;
  role: 'admin' | 'supervisor';
  today: string;
  waiting: { count: number; people: number; names: string[]; oldestPeriodLabel: string | null };
  myPeriod: {
    periodStart: string; periodEnd: string; periodLabel: string; status: string; submissionDeadline: string;
    totalHoursEntered: number; expectedWorkdays: number; workdaysFilled: number; dailyHours: Record<string, number>;
  };
  team: TeamStatus;
  lastTeam: TeamStatus;
  lastPeriodLabel: string;
  admin: null | {
    notices: { selfApprovalBackOn: { logId: string } | null; recommendDesignee: boolean };
    contracts: HomeContract[];
    unpricedTotal: number;
    workweekSet: boolean;
    pendingConfig: { effectiveFrom: string } | null;
    overlaps: number;
    setup: { isComplete: boolean; done: number; total: number; steps: HomeSetupStep[] };
  };
}

export interface AttentionItem {
  key: string;
  title: string;
  sentence?: string;
  action?: { label: string; href: string };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** One-liners for the next missing setup step (Home item 5). */
export const SETUP_STEP_HINT: Record<string, string> = {
  indirectCodes: 'Add indirect codes for leave, overhead and G&A.',
  contracts: 'Create your first contract.',
  clins: 'Add CLINs to your contracts.',
  chargeCodes: 'Create charge codes — they are what employees log time against.',
  laborCategories: 'Add labor categories so hours have rates.',
  employees: 'Add the people who will record time.',
  chargeCodeAccess: 'Give each employee the charge codes they may use.',
};

/** A contract's tier on Home (from funded value, priced cost and the remaining amount). */
export function contractTier(c: HomeContract): { pct: number; tier: BurnTier } {
  const funded = c.fundedValue === null ? null : Number(c.fundedValue);
  const pct = burnPercent(c.pricedCost, funded);
  return { pct, tier: burnTier(pct, funded, (funded ?? 0) - c.pricedCost) };
}

/** Active contracts with a funded value, highest burn first (the Contracts card shows the top 5). */
export function burnCard(contracts: HomeContract[]): Array<HomeContract & { pct: number; tier: BurnTier }> {
  return contracts
    .filter((c) => c.status === 'active')
    .map((c) => ({ ...c, ...contractTier(c) }))
    .filter((c) => c.tier !== 'noFunding')
    .sort((a, b) => b.pct - a.pct);
}

/**
 * The view with the admin notices this browser has dismissed removed (L10: the same localStorage dismissals as
 * ApprovalNotices — a dismissed "back on" notice or designee recommendation doesn't come back as a Home item).
 */
export function withDismissedNotices(v: HomeView, dismissed: { backOn: boolean; recommend: boolean }): HomeView {
  if (!v.admin) return v;
  const { selfApprovalBackOn, recommendDesignee } = v.admin.notices;
  return {
    ...v,
    admin: {
      ...v.admin,
      notices: { selfApprovalBackOn: dismissed.backOn ? null : selfApprovalBackOn, recommendDesignee: recommendDesignee && !dismissed.recommend },
    },
  };
}

/** "Needs your attention", in order (§4.5 table). */
export function attentionItems(v: HomeView): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (v.waiting.count > 0) {
    const shown = v.waiting.names.join(', ');
    const more = v.waiting.people - v.waiting.names.length;
    const who = more > 0 ? `${shown} and ${more} more` : shown;
    items.push({
      key: 'waiting',
      title: `${plural(v.waiting.count, 'timesheet', 'timesheets')} waiting for your approval`,
      sentence: `${who}.${v.waiting.oldestPeriodLabel ? ` Oldest: ${v.waiting.oldestPeriodLabel}.` : ''}`,
      action: { label: 'Review', href: '/admin/approvals' },
    });
  }

  const stragglers = [...v.lastTeam.notStarted.names, ...v.lastTeam.inProgress.names, ...v.lastTeam.returned.names].sort((a, b) => a.localeCompare(b));
  if (stragglers.length > 0) {
    const more = stragglers.length - 5;
    items.push({
      key: 'last-period',
      title: `${plural(stragglers.length, 'person hasn’t', 'people haven’t')} submitted ${v.lastPeriodLabel}`,
      sentence: `${stragglers.slice(0, 5).join(', ')}${more > 0 ? ` and ${more} more` : ''}.`,
    });
  }

  const a = v.admin;
  if (a) {
    if (a.unpricedTotal > 0) {
      items.push({
        key: 'unpriced',
        title: `${round2(a.unpricedTotal)} hours have no labor-category rate`,
        sentence: 'None is set, or the assignments overlap, so contract costs leave them out.',
        action: { label: 'Fix pricing', href: UNPRICED_REPORT_HREF },
      });
    }
    if (a.notices.recommendDesignee || a.notices.selfApprovalBackOn) {
      items.push({
        key: 'self-approval',
        title: 'You approve your own timesheets',
        sentence: a.notices.selfApprovalBackOn
          ? 'Self-approval is back on: you’re now the only active admin and have no designated approver.'
          : 'Auditors prefer an independent reviewer. Designate another officer or your bookkeeper (supervisor role) to approve your timesheets.',
        action: { label: 'Choose a reviewer', href: '/admin/users' },
      });
    }
    if (!a.setup.isComplete) {
      const next = a.setup.steps.find((s) => s.required && !s.done) ?? a.setup.steps.find((s) => !s.done);
      items.push({
        key: 'setup',
        title: `Finish setting up: ${a.setup.done} of ${a.setup.total} done`,
        sentence: next ? SETUP_STEP_HINT[next.key] : undefined,
        action: { label: 'Continue', href: '/admin/setup' },
      });
    }
    if (!a.workweekSet) {
      items.push({
        key: 'workweek',
        title: 'Payroll workweek isn’t set',
        sentence: 'Payroll export stays off until you set it.',
        action: { label: 'Set workweek', href: '/settings/workspace' },
      });
    }
    if (a.pendingConfig) {
      items.push({
        key: 'pay-schedule',
        title: `Pay schedule changes on ${formatCalendarDate(a.pendingConfig.effectiveFrom as CalendarDate, 'MMM D, YYYY')}`,
        action: { label: 'View', href: '/settings/pay-schedule' },
      });
    }
    const flagged = burnCard(a.contracts).filter((c) => NEEDS_A_LOOK.has(c.tier));
    if (flagged.length > 0) {
      items.push({
        key: 'contracts',
        title: `${plural(flagged.length, 'contract needs', 'contracts need')} a look`,
        sentence: flagged.map((c) => `${c.contractName} (${BURN_TIER_LABEL[c.tier]})`).join(', '),
        action: { label: 'Open overview', href: '/admin/dashboard' },
      });
    }
    if (a.overlaps > 0) {
      items.push({
        key: 'overlaps',
        title: `${plural(a.overlaps, 'overlapping labor-category assignment', 'overlapping labor-category assignments')}`,
        action: { label: 'Review', href: '/admin/labor-categories' },
      });
    }
  }
  return items;
}
