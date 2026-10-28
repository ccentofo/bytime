'use client';

import styles from './Timesheet.module.css';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * The timesheet's only voice (feature-plan-ux-timesheet-ui.md §4.5): a polite `role="status"` region and an assertive
 * `role="alert"` region, both EMPTY at mount. `announce()` clears the region, then sets the text ~50 ms later so the
 * same message twice is read twice. Call it only from event handlers and effects — never during render.
 */

export type AnnounceLevel = 'polite' | 'assertive';
export type Announce = (message: string, level?: AnnounceLevel) => void;

const AnnounceContext = createContext<Announce>(() => {});

export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<Record<AnnounceLevel, string>>({ polite: '', assertive: '' });
  // Timer handles, written only inside announce() (a handler) and the unmount cleanup.
  const timers = useRef<Partial<Record<AnnounceLevel, ReturnType<typeof setTimeout>>>>({});

  const announce = useCallback<Announce>((message, level = 'polite') => {
    setMessages((m) => ({ ...m, [level]: '' }));
    clearTimeout(timers.current[level]);
    timers.current[level] = setTimeout(() => setMessages((m) => ({ ...m, [level]: message })), 50);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => { clearTimeout(pending.polite); clearTimeout(pending.assertive); };
  }, []);

  const value = useMemo(() => announce, [announce]);
  return (
    <AnnounceContext.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" aria-atomic="true" className={styles.srOnly} data-testid="ts-announce-polite">{messages.polite}</div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className={styles.srOnly} data-testid="ts-announce-assertive">{messages.assertive}</div>
    </AnnounceContext.Provider>
  );
}
