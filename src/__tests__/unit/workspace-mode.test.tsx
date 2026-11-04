import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import type { ReactElement } from 'react';

/**
 * feature-plan-launch-blockers.md P4 §5 / §9 "Modes": in a read_only workspace, admin write controls and
 * Approve/Reject render disabled (static render). Visibility only — the server write gate is the real control.
 */

vi.mock('@/server/actions/contracts', () => ({ createContract: vi.fn(), updateContract: vi.fn() }));
vi.mock('@/server/actions/clins', () => ({ getClinsByContract: vi.fn(), createClin: vi.fn(), updateClin: vi.fn() }));
vi.mock('@/server/actions/slins', () => ({ getSlinsByClin: vi.fn(), createSlin: vi.fn(), updateSlin: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { WorkspaceModeProvider, WriteButton, READ_ONLY_TOOLTIP } from '@/components/shell/WorkspaceMode';
import { DecisionCard } from '@/components/approvals/DecisionCard';
import { useBusy } from '@/components/ui/useBusy';
import { ContractsClient } from '@/app/(app)/admin/contracts/ContractsClient';

const render = (mode: 'full' | 'read_only', el: ReactElement) =>
  renderToStaticMarkup(<MantineProvider><WorkspaceModeProvider mode={mode}>{el}</WorkspaceModeProvider></MantineProvider>);

/** The <button> elements whose text contains `label`, with whether each is disabled. */
function buttons(html: string, label: string): Array<{ disabled: boolean }> {
  const out: Array<{ disabled: boolean }> = [];
  for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
    if (m[2].replace(/<[^>]+>/g, '').includes(label)) out.push({ disabled: /\sdisabled(=|\s|$)/.test(m[1]) || /data-disabled="true"/.test(m[1]) });
  }
  return out;
}

/** The review's DecisionCard (UX-4b Part 2 §3.3.2: it replaces ReviewDecisionButtons). */
function Card() {
  const busy = useBusy();
  return (
    <DecisionCard isOwnPeriod={false} comment="" onCommentChange={() => {}} commentError={null} error={null} busy={busy}
      onApprove={() => {}} onReturn={() => {}} openNext onOpenNextChange={() => {}} />
  );
}
const decision = () => <Card />;

describe('Approve / Return for corrections (A-12)', () => {
  it('are aria-disabled WriteButtons in a read_only workspace, with the reason — never the disabled attribute', () => {
    const html = render('read_only', decision());
    expect(buttons(html, 'Approve')).toEqual([{ disabled: true }]);
    expect(buttons(html, 'Return for corrections')).toEqual([{ disabled: true }]);
    for (const label of ['Approve', 'Return for corrections']) {
      const tag = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].find((m) => m[2].replace(/<[^>]+>/g, '').includes(label))![1];
      expect(tag, label).toContain('aria-disabled="true"');
      expect(tag, label).toContain('data-read-only="true"');
      expect(tag, label).not.toMatch(/\sdisabled(=|\s|$)/);
      const describedBy = tag.match(/aria-describedby="([^"]+)"/)![1];
      expect(html).toContain(`id="${describedBy}"`);
    }
    expect(html).toContain(READ_ONLY_TOOLTIP);
    expect(html).not.toContain('>Reject<');
  });

  it('are enabled in a full workspace', () => {
    const html = render('full', decision());
    expect(buttons(html, 'Approve')).toEqual([{ disabled: false }]);
    expect(buttons(html, 'Return for corrections')).toEqual([{ disabled: false }]);
  });
});

describe('admin write controls', () => {
  it('WriteButton is disabled in read_only and enabled in full', () => {
    expect(buttons(render('read_only', <WriteButton>Save</WriteButton>), 'Save')).toEqual([{ disabled: true }]);
    expect(buttons(render('full', <WriteButton>Save</WriteButton>), 'Save')).toEqual([{ disabled: false }]);
  });

  it('a read_only WriteButton carries the read-only explanation, and never the disabled attribute (kit §3.5)', () => {
    // Mantine renders the Tooltip label lazily; the read-only marker is on the button and the reason in a hidden span.
    const html = render('read_only', <WriteButton>Save</WriteButton>);
    expect(html).toContain('data-read-only="true"');
    expect(html).toContain(READ_ONLY_TOOLTIP);
    expect(html.match(/<button([^>]*)>/)![1]).not.toMatch(/\sdisabled(=|\s|$)/);
    expect(READ_ONLY_TOOLTIP).toMatch(/read-only/);
  });

  it('ContractsClient: "Add contract" is disabled in read_only, enabled in full', () => {
    expect(buttons(render('read_only', <ContractsClient overview={{ contracts: [], totals: { activeContracts: 0, funded: 0, pricedCost: 0, unpricedHoursAll: 0 } }} />), 'Add contract')).toEqual([{ disabled: true }]);
    expect(buttons(render('full', <ContractsClient overview={{ contracts: [], totals: { activeContracts: 0, funded: 0, pricedCost: 0, unpricedHoursAll: 0 } }} />), 'Add contract')).toEqual([{ disabled: false }]);
  });
});
