// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { act, useState } from 'react';
import { readFileSync } from 'node:fs';
import userEvent from '@testing-library/user-event';

/**
 * feature-plan-ux-kit-contracts.md §3.7 / K-8, K-9: MoneyInput (a comma is never a decimal; pastes; a partial "12." is
 * a string; a prop change doesn't call onChange; the max error on blur); parseFlexibleDate and the date theme defaults.
 */

import { MoneyInput } from '@/components/ui/MoneyInput';
import { parseFlexibleDate } from '@/lib/date-utils';
import { theme } from '@/theme';
import { installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });

// ── K-8 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('MoneyInput (K-8)', () => {
  let setExternal!: (v: string) => void;
  function Controlled({ onChange, max }: { onChange: (v: string) => void; max?: number }) {
    const [value, setValue] = useState('');
    setExternal = setValue;
    return <MoneyInput label="Funded" value={value} max={max} onChange={(v) => { setValue(v); onChange(v); }} />;
  }
  const input = () => m!.container.querySelector('input') as HTMLInputElement;
  /** user-event outside Testing Library's render: wrap each interaction in act. */
  const step = (fn: () => Promise<void>) => act(fn);

  it('typing "1,234.5" one key at a time → "1234.5" (the comma is never a decimal)', async () => {
    const onChange = vi.fn();
    m = await mount(<Controlled onChange={onChange} />);
    const user = userEvent.setup();
    await step(() => user.type(input(), '1,234.5'));
    expect(onChange).toHaveBeenLastCalledWith('1234.5');
    expect(input().value).toBe('$1,234.5');
  });

  it('pasting "1,234,567.89" → "1234567.89"; pasting "$1,234.50" → "1234.50"; a third decimal is truncated', async () => {
    const onChange = vi.fn();
    m = await mount(<Controlled onChange={onChange} />);
    const user = userEvent.setup();
    await step(() => user.click(input()));
    await step(() => user.paste('1,234,567.89'));
    expect(onChange).toHaveBeenLastCalledWith('1234567.89');
    await step(() => user.clear(input()));
    await step(() => user.paste('$1,234.50'));
    expect(onChange).toHaveBeenLastCalledWith('1234.50');
    await step(() => user.clear(input()));
    await step(() => user.paste('1234.567'));
    expect(onChange).toHaveBeenLastCalledWith('1234.56');
    expect(input().value).toBe('$1,234.56');
  });

  it('a partial "12." is passed as the string "12."; values are always strings', async () => {
    const onChange = vi.fn();
    m = await mount(<Controlled onChange={onChange} />);
    await step(() => userEvent.setup().type(input(), '12.'));
    expect(onChange).toHaveBeenLastCalledWith('12.');
    for (const [v] of onChange.mock.calls) expect(typeof v).toBe('string');
  });

  it('a prop-sourced change doesn\'t call onChange', async () => {
    const onChange = vi.fn();
    m = await mount(<Controlled onChange={onChange} />);
    await act(async () => { setExternal('2500.00'); });
    expect(input().value).toBe('$2,500.00');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('over max → the inline error on blur (max isn\'t forwarded, so the value isn\'t clamped)', async () => {
    const onChange = vi.fn();
    m = await mount(<Controlled onChange={onChange} max={1000} />);
    const user = userEvent.setup();
    await step(() => user.type(input(), '1500'));
    expect(onChange).toHaveBeenLastCalledWith('1500');
    expect(m.container.textContent).not.toContain('Must be at most');
    await step(() => user.tab());
    expect(m.container.textContent).toContain('Must be at most $1,000.00.');
    expect(input().value).toBe('$1,500');
    expect(input().hasAttribute('max')).toBe(false);
  });
});

// ── K-9 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('dates (K-9)', () => {
  it('the five formats → YYYY-MM-DD', () => {
    expect(parseFlexibleDate('Oct 1, 2026')).toBe('2026-10-01');
    expect(parseFlexibleDate('October 1, 2026')).toBe('2026-10-01');
    expect(parseFlexibleDate('2026-10-01')).toBe('2026-10-01');
    expect(parseFlexibleDate('1/5/2026')).toBe('2026-01-05');
    expect(parseFlexibleDate('01/05/2026')).toBe('2026-01-05');
    expect(parseFlexibleDate('  Oct 1, 2026 ')).toBe('2026-10-01');
  });

  it('UX-4B1-AUDIT M3: any case, optional leading zeros and comma, "Sept", extra spaces → YYYY-MM-DD', () => {
    const cases: Array<[string, string]> = [
      ['oct 1, 2026', '2026-10-01'], ['OCT 1, 2026', '2026-10-01'], ['Oct 01, 2026', '2026-10-01'], ['Oct 1 2026', '2026-10-01'],
      ['1/05/2026', '2026-01-05'], ['01/5/2026', '2026-01-05'], ['2026-1-5', '2026-01-05'], ['Sept 1, 2026', '2026-09-01'],
      ['september 1, 2026', '2026-09-01'], ['  Oct   1,   2026  ', '2026-10-01'], ['OCTOBER 1, 2026', '2026-10-01'],
    ];
    for (const [typed, want] of cases) expect(parseFlexibleDate(typed), typed).toBe(want);
    for (const v of ['Oct 1, 2', 'oct 1, 2', '2026-02-30', '2026-1-', 'Sept 31, 2026', '13/1/2026']) expect(parseFlexibleDate(v), v).toBeNull();
  });

  it('partial or impossible input → null (never a wrong date)', () => {
    for (const v of ['Oct 1, 2', 'Oct 1, 202', '2026-02-30', '2026-13-01', '13/01/2026', 'Oct', '', 'yesterday']) {
      expect(parseFlexibleDate(v), v).toBeNull();
    }
  });

  it('theme defaults: DateInput shows "MMM D, YYYY" and parses with parseFlexibleDate; DatePickerInput shows "MMM D, YYYY"', () => {
    const components = theme.components as Record<string, { defaultProps?: Record<string, unknown> }>;
    expect(components.DateInput.defaultProps).toEqual({ valueFormat: 'MMM D, YYYY', dateParser: parseFlexibleDate });
    expect(components.DatePickerInput.defaultProps).toEqual({ valueFormat: 'MMM D, YYYY' });
  });

  it('no YYYY-MM-DD valueFormat overrides remain', () => {
    for (const f of ['src/app/(app)/admin/labor-categories/RateScheduleModal.tsx', 'src/app/(app)/admin/charge-codes/ChargeCodeCategoryModal.tsx']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/valueFormat=["']YYYY-MM-DD["']/);
    }
  });
});
