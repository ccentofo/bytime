// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * feature-plan-ux-kit-contracts.md §3.1, §3.2 / K-1: the status map and StatusBadge (words, tones, unknown values,
 * "Returned" in the warning tone, no -filled colours); Notice (role="note", the action); PageHeader (breadcrumb, a
 * ReactNode description in a div, notices after the title row).
 */

import { STATUS, statusWord, statusTone } from '@/lib/ui/status';
import { STATUS_WORD } from '@/lib/timesheet/labels';
import { PERIOD_STATUS_COLOR } from '@/lib/ui/status-colors';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });

describe('status map (K-1)', () => {
  it('words and tones; rejected is "Returned" in the warning tone', () => {
    expect(STATUS.rejected).toEqual({ word: 'Returned', tone: 'warn' });
    expect(STATUS.approved).toEqual({ word: 'Approved', tone: 'ok' });
    expect(STATUS.submitted).toEqual({ word: 'Submitted', tone: 'info' });
    expect(STATUS.closed).toEqual({ word: 'Closed', tone: 'dim' });
    expect(STATUS.notSubmitted.word).toBe('Not submitted');
  });

  it('an unknown value → sentence case with "_" as a space, and the dim tone', () => {
    expect(statusWord('on_hold')).toBe('On hold');
    expect(statusWord('PENDING_REVIEW')).toBe('Pending review');
    expect(statusTone('on_hold')).toBe('dim');
  });

  it('the timesheet STATUS_WORD derives from it; Returned is amber in the colour map', () => {
    expect(STATUS_WORD).toEqual({ draft: 'Draft', submitted: 'Submitted', approved: 'Approved', rejected: 'Returned' });
    expect(PERIOD_STATUS_COLOR.rejected).toBe('warning');
  });
});

describe('StatusBadge (K-1)', () => {
  it('renders the word with its tone; rejected → Returned / warn; an override word and tone', async () => {
    m = await mount(<><StatusBadge status="rejected" /><StatusBadge status="active" /><StatusBadge status="weird_state" /><StatusBadge word="No category" tone="warn" /></>);
    const badges = [...m.container.querySelectorAll('span[data-tone]')].map((b) => [b.textContent, b.getAttribute('data-tone')]);
    expect(badges).toEqual([['Returned', 'warn'], ['Active', 'ok'], ['Weird state', 'dim'], ['No category', 'warn']]);
  });

  it('its CSS uses -text colours, never -filled; a dot drawn in currentColor', () => {
    const css = readFileSync('src/components/ui/StatusBadge.module.css', 'utf8');
    expect(css).not.toMatch(/-filled/);
    expect(css).toMatch(/::before[\s\S]*background: currentColor/);
    for (const v of ['success-text', 'warning-text', 'red-text', 'signal-text', 'dimmed']) expect(css).toContain(`--mantine-color-${v}`);
  });
});

describe('Notice and PageHeader (§3.2)', () => {
  it('Notice: role="note", the message, an href action and an onClick action', async () => {
    let clicked = 0;
    m = await mount(<>
      <Notice action={{ label: 'Fix pricing', href: '/admin/reports/unpriced' }}><b>3 hours</b> have no rate.</Notice>
      <Notice tone="info" action={{ label: 'Do it', onClick: () => { clicked++; } }}>Info.</Notice>
    </>);
    const [warn, info] = [...m.container.querySelectorAll('[role="note"]')] as HTMLElement[];
    expect(warn.getAttribute('data-tone')).toBe('warn');
    expect(warn.textContent).toContain('3 hours have no rate.');
    expect(warn.querySelector('a')!.getAttribute('href')).toBe('/admin/reports/unpriced');
    expect(warn.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(info.getAttribute('data-tone')).toBe('info');
    (info.querySelector('button') as HTMLButtonElement).click();
    expect(clicked).toBe(1);
  });

  it('PageHeader: breadcrumb above the h1; a ReactNode description in a div (no <p>); notices after the title row', async () => {
    m = await mount(<PageHeader title="Unpriced hours" breadcrumb={<span>Downloads › Unpriced hours</span>}
      description={<><span>Hours with no rate.</span><div>Costs use the rate in effect.</div></>}
      notices={<Notice>Heads up.</Notice>} actions={<button type="button">Download Excel</button>} />);
    const crumb = m.container.querySelector('[data-testid="page-breadcrumb"]')!;
    expect(crumb.textContent).toBe('Downloads › Unpriced hours');
    const h1 = m.container.querySelector('h1')!;
    expect(crumb.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const desc = m.container.querySelector('[data-testid="page-description"]')!;
    expect(desc.tagName).toBe('DIV');
    expect(desc.closest('p')).toBeNull();
    const note = m.container.querySelector('[role="note"]')!;
    expect(h1.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(m.container.querySelector('button')!.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
