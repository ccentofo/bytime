// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { readFileSync } from 'fs';
import path from 'path';
import { useBusyRows, useLastTarget } from '@/components/ui/useRowState';
import { installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';

/**
 * UX-1 audit L2 / L5: confirm titles keep their last target while the modal animates closed; the per-row busy set never
 * lets one row's finish clear another row's loader.
 */

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });
const ROOT = path.resolve(__dirname, '../../..');

function LastTarget({ target }: { target: string | null }) {
  const shown = useLastTarget(target);
  return <p data-testid="t">{`Deactivate ${shown ?? ''}?`}</p>;
}

function Busy() {
  const rows = useBusyRows();
  return (
    <>
      <button type="button" onClick={() => { rows.start('a'); rows.start('b'); }}>start both</button>
      <button type="button" onClick={() => rows.done('a')}>done a</button>
      <button type="button" onClick={() => rows.done('b')}>done b</button>
      <p data-testid="b">{['a', 'b'].filter((id) => rows.isBusy(id)).join(',')}</p>
    </>
  );
}
const press = (label: string) => act(async () => { [...document.body.querySelectorAll('button')].find((b) => b.textContent === label)!.click(); });

let root: ReturnType<typeof createRoot>;
describe('useLastTarget (L2)', () => {
  beforeAll(() => { const c = document.createElement('div'); document.body.appendChild(c); root = createRoot(c); });
  afterAll(() => act(() => root.unmount()));

  it('keeps the last non-null target after it is cleared, and follows a new one', async () => {
    const text = () => document.body.querySelector('[data-testid="t"]')!.textContent;
    for (const [target, expected] of [[null, 'Deactivate ?'], ['Pat Doe', 'Deactivate Pat Doe?'], [null, 'Deactivate Pat Doe?'], ['Ann Admin', 'Deactivate Ann Admin?']] as const) {
      // Re-render the same tree with the next prop (closing = null: the title must not flash blank).
      await act(async () => { root.render(<MantineProvider env="test"><LastTarget target={target} /></MantineProvider>); });
      expect(text(), String(target)).toBe(expected);
    }
  });

  it('static: the Users, Indirect codes and CLIN/SLIN confirm titles read the last target', () => {
    const src = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
    expect(src('src/app/(app)/admin/users/UsersClient.tsx')).toContain('title={`Deactivate ${shownDeactivate?.fullName');
    expect(src('src/app/(app)/admin/users/UsersClient.tsx')).toContain('title={shownFlsa ? `Mark ${shownFlsa.fullName}');
    expect(src('src/app/(app)/admin/indirect-codes/IndirectCodesClient.tsx')).toContain('title={`Deactivate ${shownDeactivate?.code');
    expect(src('src/app/(app)/admin/contracts/ContractsClient.tsx')).toContain('title={`Deactivate CLIN ${shownClin?.clinNumber');
    expect(src('src/app/(app)/admin/contracts/ContractsClient.tsx')).toContain('title={`Deactivate SLIN ${shownSlin?.slinNumber');
  });
});

describe('useBusyRows (L5)', () => {
  it('rows are independent: finishing row a leaves row b busy', async () => {
    m = await mount(<Busy />);
    const text = () => m!.container.querySelector('[data-testid="b"]')!.textContent;
    await press('start both');
    expect(text()).toBe('a,b');
    await press('done a');
    expect(text()).toBe('b');
    await press('done b');
    expect(text()).toBe('');
  });

  it('static: no table keeps a single busy-row id any more', () => {
    for (const rel of ['users/UsersClient.tsx', 'indirect-codes/IndirectCodesClient.tsx', 'charge-codes/ChargeCodesClient.tsx', 'labor-categories/LaborCategoriesClient.tsx']) {
      const s = readFileSync(path.join(ROOT, 'src/app/(app)/admin', rel), 'utf8');
      expect(s, rel).toContain('const busyRows = useBusyRows();');
      expect(s, rel).not.toMatch(/setBusyRow|busyRow ===/);
    }
  });
});
