/**
 * The unsaved-changes guard (feature-plan-ux-timesheet-ui.md §4.9). The timesheet provider registers itself while
 * mounted; anything that leaves the page (a period change, an in-app link, sign-out) awaits `confirmLeave()` first.
 * Client-side module state, never touched during render.
 */

export type LeaveChoice = 'save' | 'discard' | 'cancel';

export interface UnsavedGuardRegistration {
  token: symbol;
  getCount(): number;
  /** Save everything; true when nothing is left unsaved. */
  requestSave(): Promise<boolean>;
  /** Discard everything (synchronously committed). */
  discard(): void;
  /** Show "You have {n} unsaved changes"; resolves with the choice once the confirm has closed. */
  openConfirm(n: number): Promise<LeaveChoice>;
}

let registration: UnsavedGuardRegistration | null = null;
let pending: { token: symbol; promise: Promise<boolean>; settle: (ok: boolean) => void } | null = null;

/**
 * Register the guard. The returned unregister is token-checked (a stale cleanup can't remove a newer registration); it
 * settles a pending confirm with false and clears the shared promise, so nothing waits on an unmounted timesheet.
 */
export function registerUnsavedGuard(r: UnsavedGuardRegistration): () => void {
  registration = r;
  return () => {
    if (registration?.token !== r.token) return;
    registration = null;
    if (pending?.token === r.token) {
      const { settle } = pending;
      pending = null;
      settle(false);
    }
  };
}

/**
 * True when it's fine to leave: nothing registered, nothing unsaved, "Save and continue" saved everything, or "Discard
 * and continue". False on Cancel (button, Esc, overlay), a cancelled ReasonModal or a failed save. Concurrent calls share
 * one confirm.
 */
export function confirmLeave(): Promise<boolean> {
  const r = registration;
  if (!r || r.getCount() === 0) return Promise.resolve(true);
  if (pending?.token === r.token) return pending.promise;

  let settle!: (ok: boolean) => void;
  const promise = new Promise<boolean>((resolve) => { settle = resolve; });
  const entry = { token: r.token, promise, settle };
  pending = entry;
  const finish = (ok: boolean) => {
    if (pending === entry) pending = null;
    settle(ok);
  };

  void (async () => {
    try {
      const choice = await r.openConfirm(r.getCount());
      if (pending !== entry) return; // already settled by unregister
      if (choice === 'save') finish(await r.requestSave());
      else if (choice === 'discard') { r.discard(); finish(true); }
      else finish(false);
    } catch {
      finish(false);
    }
  })();
  return promise;
}
