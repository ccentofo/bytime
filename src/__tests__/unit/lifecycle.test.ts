import { describe, it, expect } from 'vitest';
import { getTenantAccess, nextLifecycleActions, type LifecycleTenant } from '@/lib/tenant/lifecycle';
import {
  TRIAL_REMINDER_DAYS_BEFORE,
  POST_END_RETENTION_DAYS,
  DELETION_NOTICE_DAYS,
  DELETION_FINAL_REMINDER_DAYS,
  PAYMENT_GRACE_DAYS,
  SUSPENSION_NOTICE_DAYS,
  SUSPENDED_DAYS_UNTIL_TERMINATION,
} from '@/lib/tenant/lifecycle-config';

const DAY = 24 * 60 * 60 * 1000;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

const BASE_TENANT: LifecycleTenant = {
  status: 'active',
  subscriptionStatus: null,
  trialEndsAt: null,
  pastDueSince: null,
  suspendedAt: null,
  subscriptionEndedAt: null,
  deletionScheduledFor: null,
};

const NOW = new Date('2026-06-15T12:00:00Z');

describe('getTenantAccess', () => {
  it('closed: deleting status', () => {
    expect(getTenantAccess({ ...BASE_TENANT, status: 'deleting' }, NOW)).toBe('closed');
  });

  it('closed: deleted status', () => {
    expect(getTenantAccess({ ...BASE_TENANT, status: 'deleted' }, NOW)).toBe('closed');
  });

  it('closed: provisioning status', () => {
    expect(getTenantAccess({ ...BASE_TENANT, status: 'provisioning' }, NOW)).toBe('closed');
  });

  it('closed: past deletion_scheduled_for, even though status is still active', () => {
    const t: LifecycleTenant = { ...BASE_TENANT, deletionScheduledFor: addDays(NOW, -1) };
    expect(getTenantAccess(t, NOW)).toBe('closed');
  });

  it('closed: exactly at deletion_scheduled_for (boundary — inclusive)', () => {
    const t: LifecycleTenant = { ...BASE_TENANT, deletionScheduledFor: NOW };
    expect(getTenantAccess(t, NOW)).toBe('closed');
  });

  it('full: one millisecond before deletion_scheduled_for', () => {
    const t: LifecycleTenant = { ...BASE_TENANT, deletionScheduledFor: new Date(NOW.getTime() + 1) };
    expect(getTenantAccess(t, NOW)).toBe('full');
  });

  it('billing_only: suspended status', () => {
    expect(getTenantAccess({ ...BASE_TENANT, status: 'suspended' }, NOW)).toBe('billing_only');
  });

  it('full: active Stripe subscription, regardless of a long-past trial end', () => {
    const t: LifecycleTenant = {
      ...BASE_TENANT,
      subscriptionStatus: 'active',
      trialEndsAt: addDays(NOW, -365),
    };
    expect(getTenantAccess(t, NOW)).toBe('full');
  });

  it('full: trialing Stripe subscription', () => {
    expect(getTenantAccess({ ...BASE_TENANT, subscriptionStatus: 'trialing' }, NOW)).toBe('full');
  });

  it('full: trial_ends_at unset (never backfilled)', () => {
    expect(getTenantAccess(BASE_TENANT, NOW)).toBe('full');
  });

  it('full: trial not yet ended', () => {
    const t: LifecycleTenant = { ...BASE_TENANT, trialEndsAt: addDays(NOW, 1) };
    expect(getTenantAccess(t, NOW)).toBe('full');
  });

  it('read_only: trial ends exactly now (boundary — inclusive)', () => {
    const t: LifecycleTenant = { ...BASE_TENANT, trialEndsAt: NOW };
    expect(getTenantAccess(t, NOW)).toBe('read_only');
  });

  it('read_only: trial ended in the past, no subscription', () => {
    const t: LifecycleTenant = { ...BASE_TENANT, trialEndsAt: addDays(NOW, -1) };
    expect(getTenantAccess(t, NOW)).toBe('read_only');
  });

  it('read_only: subscription ended, still inside the retention window', () => {
    // Realistic shape: every tenant starts on trial, so a cancelled-after-converting tenant still
    // has its (long-past, no longer relevant) trialEndsAt alongside the newer subscription facts.
    const t: LifecycleTenant = {
      ...BASE_TENANT,
      trialEndsAt: addDays(NOW, -200),
      subscriptionStatus: 'canceled',
      subscriptionEndedAt: addDays(NOW, -1),
      deletionScheduledFor: addDays(NOW, POST_END_RETENTION_DAYS - 1),
    };
    expect(getTenantAccess(t, NOW)).toBe('read_only');
  });

  it('full: active status with no trial/subscription signal at all (fresh provisioning race)', () => {
    expect(getTenantAccess({ ...BASE_TENANT }, NOW)).toBe('full');
  });
});

describe('nextLifecycleActions', () => {
  describe('trial reminders', () => {
    const trialEndsAt = addDays(NOW, 0); // "now" is exactly trial end for this describe block's base

    it('fires each configured reminder at its exact boundary', () => {
      for (const daysBefore of TRIAL_REMINDER_DAYS_BEFORE) {
        const t: LifecycleTenant = { ...BASE_TENANT, trialEndsAt: addDays(NOW, daysBefore) };
        const actions = nextLifecycleActions(t, NOW);
        expect(actions.noticesDue.map((n) => n.kind)).toContain(`trial-reminder-${daysBefore}d`);
      }
    });

    it('does not fire a reminder before its window opens', () => {
      const furthestOut = Math.max(...TRIAL_REMINDER_DAYS_BEFORE);
      const t: LifecycleTenant = { ...BASE_TENANT, trialEndsAt: addDays(NOW, furthestOut + 1) };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.noticesDue).toHaveLength(0);
    });

    it('sends trial-ended and schedules deletion exactly at trial end', () => {
      const t: LifecycleTenant = { ...BASE_TENANT, trialEndsAt };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.noticesDue.map((n) => n.kind)).toContain('trial-ended');
      expect(actions.setDeletionScheduledFor).toEqual(addDays(trialEndsAt, POST_END_RETENTION_DAYS));
    });

    it('does not re-schedule deletion if already scheduled', () => {
      const t: LifecycleTenant = { ...BASE_TENANT, trialEndsAt, deletionScheduledFor: addDays(trialEndsAt, POST_END_RETENTION_DAYS) };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.setDeletionScheduledFor).toBeUndefined();
    });

    it('does not fire trial notices once a subscription is active', () => {
      const t: LifecycleTenant = { ...BASE_TENANT, trialEndsAt: addDays(NOW, -10), subscriptionStatus: 'active' };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.noticesDue).toHaveLength(0);
      expect(actions.setDeletionScheduledFor).toBeUndefined();
    });

    it('one millisecond before the end: not yet trial-ended', () => {
      const t: LifecycleTenant = { ...BASE_TENANT, trialEndsAt: new Date(NOW.getTime() + 1) };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.noticesDue.map((n) => n.kind)).not.toContain('trial-ended');
    });
  });

  describe('payment grace and suspension', () => {
    it('fires suspension-warning at its exact boundary', () => {
      const suspendAt = addDays(NOW, SUSPENSION_NOTICE_DAYS);
      const pastDueSince = addDays(suspendAt, -PAYMENT_GRACE_DAYS);
      const t: LifecycleTenant = { ...BASE_TENANT, pastDueSince };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.noticesDue.map((n) => n.kind)).toContain('suspension-warning');
      expect(actions.suspend).toBe(false);
    });

    it('suspends exactly at the grace boundary and fires the suspended notice', () => {
      const pastDueSince = addDays(NOW, -PAYMENT_GRACE_DAYS);
      const t: LifecycleTenant = { ...BASE_TENANT, pastDueSince };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.suspend).toBe(true);
      expect(actions.noticesDue.map((n) => n.kind)).toContain('suspended');
    });

    it('one day before the grace boundary: no suspension yet', () => {
      const pastDueSince = addDays(NOW, -(PAYMENT_GRACE_DAYS - 1));
      const t: LifecycleTenant = { ...BASE_TENANT, pastDueSince };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.suspend).toBe(false);
    });

    it('no pastDueSince: nothing fires', () => {
      const actions = nextLifecycleActions(BASE_TENANT, NOW);
      expect(actions.suspend).toBe(false);
      expect(actions.noticesDue).toHaveLength(0);
    });
  });

  describe('D9 termination of a long-suspended workspace', () => {
    it('terminates exactly at the boundary', () => {
      const suspendedAt = addDays(NOW, -SUSPENDED_DAYS_UNTIL_TERMINATION);
      const t: LifecycleTenant = { ...BASE_TENANT, status: 'suspended', suspendedAt };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.terminateSubscription).toBe(true);
    });

    it('one day before the boundary: not yet', () => {
      const suspendedAt = addDays(NOW, -(SUSPENDED_DAYS_UNTIL_TERMINATION - 1));
      const t: LifecycleTenant = { ...BASE_TENANT, status: 'suspended', suspendedAt };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.terminateSubscription).toBe(false);
    });

    it('already terminated (subscriptionEndedAt set): does not re-terminate', () => {
      const suspendedAt = addDays(NOW, -SUSPENDED_DAYS_UNTIL_TERMINATION - 10);
      const t: LifecycleTenant = { ...BASE_TENANT, status: 'suspended', suspendedAt, subscriptionEndedAt: addDays(NOW, -5) };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.terminateSubscription).toBe(false);
    });
  });

  describe('deletion notices and readiness', () => {
    it('fires the contractual 14-day notice at its boundary', () => {
      const deletionScheduledFor = addDays(NOW, DELETION_NOTICE_DAYS);
      const t: LifecycleTenant = { ...BASE_TENANT, deletionScheduledFor };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.noticesDue.map((n) => n.kind)).toContain('deletion-notice');
      expect(actions.noticesDue.map((n) => n.kind)).not.toContain('deletion-final-reminder');
    });

    it('fires the 3-day courtesy reminder at its boundary', () => {
      const deletionScheduledFor = addDays(NOW, DELETION_FINAL_REMINDER_DAYS);
      const t: LifecycleTenant = { ...BASE_TENANT, deletionScheduledFor };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.noticesDue.map((n) => n.kind)).toContain('deletion-final-reminder');
    });

    it('flags readyForDeletion exactly at deletion_scheduled_for', () => {
      const t: LifecycleTenant = { ...BASE_TENANT, deletionScheduledFor: NOW };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.readyForDeletion).toBe(true);
    });

    it('not ready one millisecond before deletion_scheduled_for', () => {
      const t: LifecycleTenant = { ...BASE_TENANT, deletionScheduledFor: new Date(NOW.getTime() + 1) };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.readyForDeletion).toBe(false);
    });

    it('no deletion_scheduled_for: no deletion notices, not ready', () => {
      const actions = nextLifecycleActions(BASE_TENANT, NOW);
      expect(actions.noticesDue.filter((n) => n.kind.startsWith('deletion'))).toHaveLength(0);
      expect(actions.readyForDeletion).toBe(false);
    });

    it('still computes deletion notices for a suspended-then-terminated tenant', () => {
      const deletionScheduledFor = addDays(NOW, DELETION_NOTICE_DAYS);
      const t: LifecycleTenant = { ...BASE_TENANT, status: 'suspended', deletionScheduledFor };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.noticesDue.map((n) => n.kind)).toContain('deletion-notice');
    });

    it('does not compute deletion notices once actually deleting', () => {
      const deletionScheduledFor = addDays(NOW, DELETION_NOTICE_DAYS);
      const t: LifecycleTenant = { ...BASE_TENANT, status: 'deleting', deletionScheduledFor };
      const actions = nextLifecycleActions(t, NOW);
      expect(actions.noticesDue).toHaveLength(0);
      expect(actions.readyForDeletion).toBe(false);
    });
  });

  it('is idempotent: calling twice with the same inputs returns the same result', () => {
    const t: LifecycleTenant = {
      ...BASE_TENANT,
      trialEndsAt: addDays(NOW, -1),
      deletionScheduledFor: addDays(NOW, DELETION_NOTICE_DAYS),
    };
    expect(nextLifecycleActions(t, NOW)).toEqual(nextLifecycleActions(t, NOW));
  });
});
