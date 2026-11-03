'use client';

import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader } from '@mantine/core';

/** The group of a composite key: 'costs:excel' → 'costs'; a plain key is its own group. */
const groupOf = (key: string) => key.split(':')[0];

/**
 * Per-action busy state (feature-plan-ux-kit-contracts.md §3.5), replacing a page-wide `isPending` for buttons:
 *
 *   const busy = useBusy();
 *   <Button {...busy.props('costs:excel', { icon })} onClick={() => busy.run('costs:excel', download)} />
 *
 * - `run(key, fn)` ignores a call while that key — or another key in its group ('costs:csv') — is running (a ref,
 *   written only here, guards re-entry before the re-render).
 * - `is` / `any` read STATE, never the ref.
 * - `props(key)` is aria-disabled + data-disabled + aria-busy while its group is busy, with a Loader on the busy
 *   button only — never `disabled` (focus would drop) and never Mantine `loading` (it sets `disabled`).
 * - No setState after unmount.
 */
export function useBusy() {
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async <R>(key: string, fn: () => Promise<R>): Promise<R | undefined> => {
    if ([...inFlight.current].some((k) => groupOf(k) === groupOf(key))) return undefined;
    inFlight.current.add(key);
    setBusyKeys((prev) => new Set(prev).add(key));
    try {
      return await fn();
    } finally {
      inFlight.current.delete(key);
      if (mounted.current) setBusyKeys((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
  }, []);

  const is = (key: string) => busyKeys.has(key);
  const any = () => busyKeys.size > 0;
  const groupBusy = (key: string) => [...busyKeys].some((k) => groupOf(k) === groupOf(key));
  const props = (key: string, opts: { icon?: ReactNode } = {}) => {
    const blocked = groupBusy(key);
    return {
      'aria-disabled': blocked || undefined,
      'data-disabled': blocked || undefined,
      'aria-busy': busyKeys.has(key) || undefined,
      leftSection: busyKeys.has(key) ? createElement(Loader, { size: 'xs', 'aria-hidden': true }) : opts.icon,
    };
  };
  return { run, is, any, props };
}
