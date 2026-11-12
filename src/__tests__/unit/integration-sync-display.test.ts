import { describe, it, expect } from 'vitest';
import {
  STALE_RUNNING_MS, emailSuggestions, parseSyncRecordId, periodCoverage, seeFailuresLabel, syncResultText, type CoverageLog,
} from '@/lib/integrations/sync-display';
import type { CalendarDate } from '@/lib/calendar-date';

/**
 * feature-plan-ux-integrations-billing.md §6 (sync log in words), I6 (duplicate guard), I5 (email suggestions), I7
 * (failure labels). Pure.
 */

const NOW = new Date('2026-11-11T15:00:00Z').getTime();
const d = (s: string) => s as CalendarDate;
const log = (over: Partial<Parameters<typeof syncResultText>[0]>) => ({
  status: 'success', recordsPushed: 0, recordsSkipped: 0, errorSummary: null, startedAt: new Date(NOW - 60_000), createdAt: new Date(NOW - 60_000), ...over,
});
const text = (over: Partial<Parameters<typeof syncResultText>[0]>) => {
  const r = syncResultText(log(over), NOW);
  return r.head + r.rest;
};

describe('IN-10: the sync log in words (§6)', () => {
  it('every row of the §6 table', () => {
    expect(text({ status: 'running' })).toBe('Sending…');
    expect(text({ status: 'running', startedAt: new Date(NOW - STALE_RUNNING_MS), createdAt: new Date(NOW - STALE_RUNNING_MS) })).toBe('Didn’t finish'); // F10: the curly ’ like the rest of the copy
    expect(text({ status: 'success' })).toBe('Nothing to send: no approved hours in this period');
    expect(text({ status: 'success', recordsSkipped: 4 })).toBe('Nothing sent · 4 entries skipped: people not matched');
    expect(text({ status: 'success', recordsPushed: 42 })).toBe('Sent');
    expect(text({ status: 'success', recordsPushed: 42, recordsSkipped: 5 })).toBe('Sent · 5 entries skipped: people not matched');
    expect(text({ status: 'partial', recordsPushed: 30 })).toBe('Partly sent');
    expect(text({ status: 'failed', errorSummary: 'Your QuickBooks connection has expired.' })).toBe('Failed: Your QuickBooks connection has expired.');
  });

  it('tones: a stale running log and a nothing-sent run warn; a failure is bad', () => {
    expect(syncResultText(log({ status: 'running', startedAt: new Date(NOW - STALE_RUNNING_MS) }), NOW).tone).toBe('warn');
    expect(syncResultText(log({ status: 'success', recordsSkipped: 1 }), NOW).tone).toBe('warn');
    expect(syncResultText(log({ status: 'failed' }), NOW).tone).toBe('bad');
  });

  it('"See {n} failures" only when failed records exist', () => {
    expect(seeFailuresLabel(0)).toBeNull();
    expect(seeFailuresLabel(1)).toBe('See 1 failure');
    expect(seeFailuresLabel(2)).toBe('See 2 failures');
  });

  it('failure labels: the fixed-width record id parses; anything else is null (shown raw)', () => {
    const u = '11111111-1111-4111-8111-111111111111';
    const c = '22222222-2222-4222-8222-222222222222';
    expect(parseSyncRecordId(`${u}-${c}-2026-10-15`)).toEqual({ userId: u, codeId: c, date: '2026-10-15' });
    expect(parseSyncRecordId(`${u}--2026-10-15`)).toBeNull();
    expect(parseSyncRecordId('garbage')).toBeNull();
  });
});

describe('IN-9: the duplicate guard (I6)', () => {
  const covering = (over: Partial<CoverageLog>): CoverageLog => ({
    status: 'success', recordsPushed: 10, periodStart: d('2026-10-16'), periodEnd: d('2026-10-31'),
    startedAt: new Date('2026-11-01T14:00:00Z'), createdAt: new Date('2026-11-01T14:00:00Z'), ...over,
  });

  it('an exact log covers the period; a partial with records pushed covers it too', () => {
    expect(periodCoverage([covering({})], d('2026-10-16'), NOW).sentAt).toEqual(new Date('2026-11-01T14:00:00Z'));
    expect(periodCoverage([covering({ status: 'partial' })], d('2026-10-16'), NOW).sentAt).not.toBeNull();
  });

  it('a legacy three-month window covers a period whose start is inside it', () => {
    const legacy = covering({ periodStart: d('2026-08-01'), periodEnd: d('2026-10-31') });
    expect(periodCoverage([legacy], d('2026-10-16'), NOW).sentAt).not.toBeNull();
    expect(periodCoverage([legacy], d('2026-11-01'), NOW).sentAt).toBeNull();
  });

  it('a 0-pushed log and a failed log never warn', () => {
    expect(periodCoverage([covering({ recordsPushed: 0 })], d('2026-10-16'), NOW).sentAt).toBeNull();
    expect(periodCoverage([covering({ status: 'failed' })], d('2026-10-16'), NOW).sentAt).toBeNull();
  });

  it('a stale running log covering the period → "may have been partly sent"; a fresh one doesn’t', () => {
    const stale = covering({ status: 'running', recordsPushed: 0, startedAt: new Date(NOW - STALE_RUNNING_MS - 1) });
    expect(periodCoverage([stale], d('2026-10-16'), NOW)).toEqual({ sentAt: null, partlySentAt: stale.startedAt });
    const fresh = covering({ status: 'running', recordsPushed: 0, startedAt: new Date(NOW - 60_000) });
    expect(periodCoverage([fresh], d('2026-10-16'), NOW).partlySentAt).toBeNull();
  });

  it('the newest covering send is reported', () => {
    const older = covering({ startedAt: new Date('2026-11-01T14:00:00Z') });
    const newer = covering({ startedAt: new Date('2026-11-05T09:00:00Z') });
    expect(periodCoverage([older, newer], d('2026-10-16'), NOW).sentAt).toEqual(new Date('2026-11-05T09:00:00Z'));
  });
});

describe('IN-8: email suggestions (I5)', () => {
  const none = { userIds: new Set<string>(), employeeIds: new Set<string>(), vendorIds: new Set<string>() };
  const people = [{ id: 'u1', email: 'Emily.Davis@Acme.test' }, { id: 'u2', email: 'rob@acme.test' }, { id: 'u3', email: 'jo@acme.test' }];

  it('a unique case-insensitive match is suggested', () => {
    const s = emailSuggestions(people, [{ id: 'e1', name: 'Emily Davis', email: 'emily.davis@acme.test ' }], [], none);
    expect(s.get('u1')).toEqual({ type: 'employee', externalId: 'e1', externalName: 'Emily Davis' });
    expect(s.size).toBe(1);
  });

  it('a QuickBooks email on both an employee and a vendor is ambiguous (no suggestion); so are two employees', () => {
    expect(emailSuggestions(people, [{ id: 'e2', name: 'Rob', email: 'rob@acme.test' }], [{ id: 'v2', name: 'Rob LLC', email: 'ROB@acme.test' }], none).has('u2')).toBe(false);
    expect(emailSuggestions(people, [{ id: 'e3', name: 'Jo', email: 'jo@acme.test' }, { id: 'e4', name: 'Jo 2', email: 'jo@acme.test' }], [], none).has('u3')).toBe(false);
  });

  it('matched people and already-matched QuickBooks records are left out', () => {
    const employees = [{ id: 'e1', name: 'Emily Davis', email: 'emily.davis@acme.test' }];
    expect(emailSuggestions(people, employees, [], { ...none, userIds: new Set(['u1']) }).has('u1')).toBe(false);
    expect(emailSuggestions(people, employees, [], { ...none, employeeIds: new Set(['e1']) }).has('u1')).toBe(false);
    // A record mapped elsewhere no longer makes another record's email ambiguous.
    const vendors = [{ id: 'v9', name: 'Emily LLC', email: 'emily.davis@acme.test' }];
    expect(emailSuggestions(people, employees, vendors, { ...none, vendorIds: new Set(['v9']) }).get('u1')?.externalId).toBe('e1');
  });
});
