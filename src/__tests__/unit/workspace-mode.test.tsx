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

import { WorkspaceModeProvider, WriteButton, READ_ONLY_TOOLTIP } from '@/components/shell/WorkspaceMode';
import { ReviewDecisionButtons } from '@/components/approvals/ReviewDecisionButtons';
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

const decision = () => (
  <ReviewDecisionButtons isOwnPeriod={false} canReject pending={false} onApprove={() => {}} onReject={() => {}} />
);

describe('Approve / Reject', () => {
  it('are disabled in a read_only workspace', () => {
    const html = render('read_only', decision());
    expect(buttons(html, 'Approve')).toEqual([{ disabled: true }]);
    expect(buttons(html, 'Reject')).toEqual([{ disabled: true }]);
  });

  it('are enabled in a full workspace', () => {
    const html = render('full', decision());
    expect(buttons(html, 'Approve')).toEqual([{ disabled: false }]);
    expect(buttons(html, 'Reject')).toEqual([{ disabled: false }]);
  });
});

describe('admin write controls', () => {
  it('WriteButton is disabled in read_only and enabled in full', () => {
    expect(buttons(render('read_only', <WriteButton>Save</WriteButton>), 'Save')).toEqual([{ disabled: true }]);
    expect(buttons(render('full', <WriteButton>Save</WriteButton>), 'Save')).toEqual([{ disabled: false }]);
  });

  it('a read_only WriteButton carries the read-only explanation', () => {
    // Mantine renders the Tooltip label lazily; the read-only marker is on the button itself.
    expect(render('read_only', <WriteButton>Save</WriteButton>)).toContain('data-read-only="true"');
    expect(READ_ONLY_TOOLTIP).toMatch(/read-only/);
  });

  it('ContractsClient: "Add Contract" is disabled in read_only, enabled in full', () => {
    expect(buttons(render('read_only', <ContractsClient initialContracts={[]} />), 'Add Contract')).toEqual([{ disabled: true }]);
    expect(buttons(render('full', <ContractsClient initialContracts={[]} />), 'Add Contract')).toEqual([{ disabled: false }]);
  });
});
