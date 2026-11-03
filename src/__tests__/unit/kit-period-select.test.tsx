// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { useState } from 'react';

/** feature-plan-ux-kit-contracts.md §3.8: PeriodPresetSelect — "Custom dates…" reveals two dates; start > end is inline. */

import { PeriodPresetSelect, periodSelectionError, periodSelectionReady, CUSTOM_PRESET, RANGE_ORDER_ERROR, type PeriodSelection } from '@/components/ui/PeriodPresetSelect';
import { click, installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });

const PRESETS = [{ value: 'last', label: 'Last pay period · Oct 1 – 15, 2026' }, { value: 'this', label: 'This pay period · Oct 16 – 31, 2026' }];

describe('PeriodPresetSelect', () => {
  it('pure rules: custom needs both dates in order; presets are always ready', () => {
    const custom = (start: string | null, end: string | null): PeriodSelection => ({ preset: CUSTOM_PRESET, start: start as never, end: end as never });
    expect(periodSelectionError(custom('2026-02-01', '2026-01-31'))).toBe(RANGE_ORDER_ERROR);
    expect(periodSelectionReady(custom('2026-02-01', '2026-01-31'))).toBe(false);
    expect(periodSelectionReady(custom('2026-01-01', null))).toBe(false);
    expect(periodSelectionReady(custom('2026-01-01', '2026-01-01'))).toBe(true);
    expect(periodSelectionReady({ preset: 'last', start: null, end: null })).toBe(true);
  });

  it('"Custom dates…" reveals the two dates, and an end before the start shows the inline error', async () => {
    let current!: PeriodSelection;
    function Host({ initial }: { initial: PeriodSelection }) {
      const [v, setV] = useState(initial);
      current = v;
      return <PeriodPresetSelect label="Range" presets={PRESETS} value={v} onChange={setV} />;
    }
    m = await mount(<Host initial={{ preset: 'last', start: null, end: null }} />);
    expect(m.container.textContent).not.toContain('Start date');
    const select = [...m.container.querySelectorAll('input')].find((i) => i.getAttribute('aria-haspopup') === 'listbox') as HTMLInputElement;
    await click(select);
    await click([...document.getElementById(select.getAttribute('aria-controls')!)!.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Custom dates…'));
    expect(current.preset).toBe(CUSTOM_PRESET);
    expect(m.container.textContent).toContain('Start date');
    expect(m.container.textContent).toContain('End date');
    unmount(m);
    m = await mount(<Host initial={{ preset: CUSTOM_PRESET, start: '2026-02-01' as never, end: '2026-01-31' as never }} />);
    expect(m.container.textContent).toContain(RANGE_ORDER_ERROR);
  });
});
