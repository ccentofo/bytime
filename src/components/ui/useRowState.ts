'use client';

import { useCallback, useState } from 'react';

/**
 * The last non-null value (UX-1 audit L2). A confirm's target is cleared on close, but the modal keeps rendering while
 * it animates out — titles built from the cleared target would flash "Deactivate ?". Render-time state sync, no effect.
 */
export function useLastTarget<T>(value: T | null): T | null {
  const [last, setLast] = useState<T | null>(value);
  if (value !== null && value !== last) setLast(value);
  return value ?? last;
}

/**
 * Which rows have an action running (UX-1 audit L5): a set, so one row finishing never clears another row's loader.
 */
export function useBusyRows() {
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const start = useCallback((id: string) => setBusy((s) => new Set(s).add(id)), []);
  const done = useCallback((id: string) => setBusy((s) => { const n = new Set(s); n.delete(id); return n; }), []);
  const isBusy = useCallback((id: string) => busy.has(id), [busy]);
  return { start, done, isBusy };
}
