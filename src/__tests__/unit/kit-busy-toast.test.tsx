// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { Button } from '@mantine/core';

/**
 * feature-plan-ux-kit-contracts.md §3.5, §3.6 / K-6, K-7, K-11: useBusy (re-entry ignored; composite keys; never
 * `disabled`); toastError and runAction (errors stay until closed); no direct red toasts in the Part 1 files; the
 * read-only WriteButton (no `disabled`, aria-disabled, the reason via aria-describedby, a click does nothing, a caller's
 * `loading` ignored).
 */

const notify = vi.hoisted(() => vi.fn());
vi.mock('@mantine/notifications', () => ({ notifications: { show: notify } }));

import { useBusy } from '@/components/ui/useBusy';
import { toastError, toastSuccess } from '@/lib/toast';
import { runAction } from '@/lib/run-action';
import { WriteButton, READ_ONLY_TOOLTIP } from '@/components/shell/WorkspaceMode';
import { installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
beforeEach(() => notify.mockReset());
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

// ── K-6 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('useBusy (K-6)', () => {
  let busy: ReturnType<typeof useBusy>;
  function Probe() {
    busy = useBusy();
    return (
      <>
        <Button {...busy.props('costs:excel', { icon: <span data-testid="icon-excel" /> })}>Excel</Button>
        <Button {...busy.props('costs:csv')}>CSV</Button>
        <Button {...busy.props('pdf')}>PDF</Button>
      </>
    );
  }
  const btn = (t: string) => [...m!.container.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement;

  it('re-entry on the same key (or its group) is ignored until the first run ends', async () => {
    m = await mount(<Probe />);
    const d = deferred();
    const fn = vi.fn(() => d.promise);
    let first!: Promise<unknown>;
    await act(async () => { first = busy.run('costs:excel', fn); });
    await act(async () => { void busy.run('costs:excel', fn); void busy.run('costs:csv', fn); });
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => { d.resolve(); await first; });
    await act(async () => { await busy.run('costs:csv', async () => {}); });
    expect(busy.any()).toBe(false);
  });

  it('a composite key shows its own Loader; its group is aria-disabled; other groups are free; never `disabled`', async () => {
    m = await mount(<Probe />);
    const d = deferred();
    await act(async () => { void busy.run('costs:excel', () => d.promise); });
    expect(busy.is('costs:excel')).toBe(true);
    expect(btn('Excel').querySelector('.mantine-Loader-root')).not.toBeNull();
    expect(btn('Excel').getAttribute('aria-busy')).toBe('true');
    expect(btn('CSV').querySelector('.mantine-Loader-root')).toBeNull();
    expect(btn('CSV').getAttribute('aria-disabled')).toBe('true');
    expect(btn('PDF').getAttribute('aria-disabled')).toBeNull();
    for (const b of ['Excel', 'CSV', 'PDF']) expect(btn(b).hasAttribute('disabled')).toBe(false);
    await act(async () => { d.resolve(); });
    expect(btn('Excel').querySelector('[data-testid="icon-excel"]')).not.toBeNull();
    expect(btn('Excel').getAttribute('aria-disabled')).toBeNull();
  });

  it('props never include `disabled` or Mantine `loading`', async () => {
    m = await mount(<Probe />);
    const keys = Object.keys(busy.props('x'));
    expect(keys).not.toContain('disabled');
    expect(keys).not.toContain('loading');
  });

  it('a run that ends after unmount doesn\'t throw or log', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    m = await mount(<Probe />);
    const d = deferred();
    let p!: Promise<unknown>;
    await act(async () => { p = busy.run('pdf', () => d.promise); });
    unmount(m); m = undefined;
    d.resolve();
    await expect(p).resolves.toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

// ── K-7 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The Part 1 pages' files: their errors go through toastError / runAction, never a direct red toast. */
export const PART1_FILES = [
  'src/app/(app)/admin/contracts/ContractsClient.tsx',
  'src/app/(app)/admin/labor-categories/LaborCategoriesClient.tsx',
  'src/app/(app)/admin/labor-categories/RateScheduleModal.tsx',
  'src/app/(app)/admin/reports/ReportsClient.tsx',
  'src/app/(app)/admin/assignments/AssignmentsClient.tsx',
  'src/app/(app)/admin/reports/unpriced/UnpricedClient.tsx',
];

describe('error toasts (K-7)', () => {
  it('toastError stays until closed; toastSuccess auto-closes', () => {
    toastError({ title: 'T', message: 'M' });
    expect(notify).toHaveBeenLastCalledWith({ title: 'T', message: 'M', color: 'red', autoClose: false });
    toastSuccess({ title: 'Ok', message: 'Done' });
    expect(notify.mock.calls[1][0]).not.toHaveProperty('autoClose');
  });

  it('runAction shows a failure through toastError (autoClose: false)', async () => {
    await runAction(Promise.resolve({ ok: false, code: 'validation', error: 'No.' } as const), { errorTitle: 'Couldn’t save' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Couldn’t save', message: 'No.', color: 'red', autoClose: false }));
    await runAction(Promise.reject(new Error('boom')));
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ autoClose: false }));
  });

  it('static: no direct red toast in the Part 1 files', () => {
    const offenders = PART1_FILES.filter((f) => existsSync(f))
      .filter((f) => /notifications\.show\(\{[^}]*color:\s*'red'/.test(readFileSync(f, 'utf8').replace(/\s+/g, ' ')));
    expect(offenders).toEqual([]);
  });
});

// ── K-11 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('read-only WriteButton (K-11)', () => {
  it('no disabled attribute; aria-disabled; the reason via aria-describedby; a click does nothing; loading ignored', async () => {
    const onClick = vi.fn();
    m = await mount(<WriteButton onClick={onClick} loading disabled aria-describedby="own-hint">Save</WriteButton>, 'read_only');
    const b = [...m.container.querySelectorAll('button')].find((x) => x.textContent?.includes('Save')) as HTMLButtonElement;
    expect(b.hasAttribute('disabled')).toBe(false);
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.getAttribute('data-loading')).toBeNull();
    expect(b.querySelector('.mantine-Loader-root')).toBeNull();
    const ids = b.getAttribute('aria-describedby')!.split(' ');
    expect(ids[0]).toBe('own-hint');
    expect(document.getElementById(ids[1])!.textContent).toBe(READ_ONLY_TOOLTIP);
    expect(b.textContent).toBe('Save');                                  // the reason isn't part of its name
    await act(async () => { b.click(); });
    expect(onClick).not.toHaveBeenCalled();
    b.focus();
    expect(document.activeElement).toBe(b);
  });

  it('full mode is unchanged: onClick runs, and a caller\'s loading still applies', async () => {
    const onClick = vi.fn();
    m = await mount(<WriteButton onClick={onClick}>Save</WriteButton>);
    await act(async () => { (m!.container.querySelector('button') as HTMLButtonElement).click(); });
    expect(onClick).toHaveBeenCalledTimes(1);
    unmount(m);
    m = await mount(<WriteButton loading>Save</WriteButton>);
    expect(m.container.querySelector('button')!.getAttribute('data-loading')).toBe('true');
  });
});
