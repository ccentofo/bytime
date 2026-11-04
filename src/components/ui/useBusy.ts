'use client';

import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader } from '@mantine/core';

export interface BusyOptions {
  /**
   * A set of buttons that block each other while one runs (a Downloads row's Excel and CSV). Without it only the same
   * key blocks — so two table rows (`row:A`, `row:B`) never wait on each other (UX-4B1-AUDIT M4).
   */
  group?: string;
}

/**
 * Per-action busy state (feature-plan-ux-kit-contracts.md §3.5), replacing a page-wide `isPending` for buttons:
 *
 *   const busy = useBusy();
 *   <Button {...busy.props('costs:excel', { icon, group: 'costs' })} onClick={() => busy.run('costs:excel', download, { group: 'costs' })} />
 *
 * - `run(key, fn, { group })` ignores a call while that key — or, with a group, any key of that group — is running (a
 *   ref, written only here, guards re-entry before the re-render).
 * - `is` / `any` read STATE, never the ref.
 * - `props(key, { group, blocked })` is aria-disabled + data-disabled + aria-busy while the key (or its group) is busy
 *   or `blocked` (an incomplete form — pair it with aria-describedby naming why), with a Loader on the busy button
 *   only — never `disabled` (focus would drop) and never Mantine `loading` (it sets `disabled`).
 * - No setState after unmount.
 */
export function useBusy() {
  const [busyKeys, setBusyKeys] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const inFlight = useRef(new Map<string, string | null>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async <R>(key: string, fn: () => Promise<R>, opts: BusyOptions = {}): Promise<R | undefined> => {
    const group = opts.group ?? null;
    if (inFlight.current.has(key) || (group !== null && [...inFlight.current.values()].includes(group))) return undefined;
    inFlight.current.set(key, group);
    setBusyKeys((prev) => new Map(prev).set(key, group));
    try {
      return await fn();
    } finally {
      inFlight.current.delete(key);
      if (mounted.current) setBusyKeys((prev) => { const next = new Map(prev); next.delete(key); return next; });
    }
  }, []);

  const is = (key: string) => busyKeys.has(key);
  const any = () => busyKeys.size > 0;
  const props = (key: string, opts: BusyOptions & { icon?: ReactNode; blocked?: boolean } = {}) => {
    const group = opts.group ?? null;
    const off = busyKeys.has(key) || (group !== null && [...busyKeys.values()].includes(group)) || !!opts.blocked;
    return {
      'aria-disabled': off || undefined,
      'data-disabled': off || undefined,
      'aria-busy': busyKeys.has(key) || undefined,
      leftSection: busyKeys.has(key) ? createElement(Loader, { size: 'xs', 'aria-hidden': true }) : opts.icon,
    };
  };
  return { run, is, any, props };
}
