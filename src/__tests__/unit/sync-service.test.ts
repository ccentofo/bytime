import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-launch-blockers.md P4 §3 / §5 "Offline sync item" / §9 "Offline sync": a returned failure never
 * deletes queued hours; read_only/forbidden/unauthenticated pause the loop; success removes the items.
 */

type QueueItem = { id: number; entryDate: string; clinId: string; hours: number; isEdit: boolean; isLateEntry: boolean; attempts: number; lastError?: string };

const store = vi.hoisted(() => ({
  queue: [] as QueueItem[],
  entryStatus: new Map<string, { syncStatus: string; serverRevision?: number }>(),
}));

vi.mock('@/lib/offline/db', () => {
  const syncQueue = {
    where: () => ({ below: (n: number) => ({ limit: () => ({ toArray: async () => store.queue.filter((q) => q.attempts < n) }) }) }),
    toArray: async () => store.queue,
    count: async () => store.queue.length,
    bulkDelete: async (ids: number[]) => { store.queue = store.queue.filter((q) => !ids.includes(q.id)); },
    update: async (id: number, patch: Partial<QueueItem>) => { store.queue = store.queue.map((q) => (q.id === id ? { ...q, ...patch } : q)); },
  };
  const entries = {
    where: (k: { clinId: string; entryDate: string }) => ({
      modify: async (patch: { syncStatus: string; serverRevision?: number }) => { store.entryStatus.set(`${k.clinId}|${k.entryDate}`, patch); },
    }),
  };
  return { offlineDb: { syncQueue, entries } };
});

const save = vi.hoisted(() => vi.fn());
vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: save }));

import { triggerSync, getSyncStateForTests, resetSyncStateForTests } from '@/lib/offline/sync-service';

const item = (id: number, day: string): QueueItem => ({ id, entryDate: day, clinId: 'clin-1', hours: 8, isEdit: false, isLateEntry: false, attempts: 0 });

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true });
  store.queue = [item(1, '2026-01-05'), item(2, '2026-01-06')];
  store.entryStatus = new Map();
  save.mockReset();
  resetSyncStateForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('offline sync', () => {
  it('success removes the queued items and marks the local entries synced', async () => {
    save.mockResolvedValue({ ok: true, data: { revisions: { 'clin-1-4': 1, 'clin-1-5': 1 }, noteRevisions: {} } });
    await triggerSync();
    expect(store.queue).toHaveLength(0);
    expect(store.entryStatus.get('clin-1|2026-01-05')?.syncStatus).toBe('synced');
  });

  it('{ ok: false, conflict } keeps the queue items, counts the attempt with the message, and flags the entries', async () => {
    save.mockResolvedValue({ ok: false, code: 'conflict', error: 'Someone else changed this.' });
    await triggerSync();
    expect(store.queue).toHaveLength(2); // never deleted
    expect(store.queue.every((q) => q.attempts === 1 && q.lastError === 'Someone else changed this.')).toBe(true);
    expect(store.entryStatus.get('clin-1|2026-01-05')?.syncStatus).toBe('error');
    expect(getSyncStateForTests().paused).toBe(false); // the user resolves; the loop keeps running
  });

  it.each(['read_only', 'forbidden', 'unauthenticated'])('{ ok: false, %s } pauses the loop and keeps the items untouched', async (code) => {
    save.mockResolvedValue({ ok: false, code, error: 'This workspace is read-only.' });
    await triggerSync();
    expect(store.queue).toHaveLength(2);
    expect(store.queue.every((q) => q.attempts === 0)).toBe(true);
    expect(getSyncStateForTests().paused).toBe(true);
    // Paused until the next app load: a further sync doesn't call the server again.
    await triggerSync();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('a network failure (the action rejects) keeps the items queued for the existing retry', async () => {
    save.mockRejectedValue(new TypeError('Failed to fetch'));
    await triggerSync();
    expect(store.queue).toHaveLength(2);
    expect(store.queue.every((q) => q.attempts === 1)).toBe(true);
  });
});
