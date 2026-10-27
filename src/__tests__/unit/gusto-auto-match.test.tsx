// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

/**
 * Launch-blockers audit A7: Gusto "Auto-Match by Email" counts only saves that succeeded (failed saves used to be
 * counted as matched, with a success toast), and stops at a refusal that will refuse every remaining save.
 */

const h = vi.hoisted(() => ({
  show: vi.fn(),
  saveMapping: vi.fn(),
  fetchEmployees: vi.fn(),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.show } }));
vi.mock('@/server/actions/integrations', () => ({ saveMapping: h.saveMapping, disconnectIntegration: vi.fn() }));
vi.mock('@/server/actions/gusto', () => ({ fetchGustoEmployeesForMapping: h.fetchEmployees, triggerGustoSync: vi.fn() }));

import { GustoConfigClient } from '@/app/(app)/settings/integrations/gusto/GustoConfigClient';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const employees = [
  { id: 'e1', fullName: 'Ann', email: 'ann@acme.com' },
  { id: 'e2', fullName: 'Bob', email: 'bob@acme.com' },
  { id: 'e3', fullName: 'Cy', email: 'cy@acme.com' },
];
const gusto = employees.map((e, i) => ({ id: `g${i}`, name: e.fullName, email: e.email }));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  window.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} };
});
beforeEach(() => {
  h.show.mockReset();
  h.saveMapping.mockReset();
  h.fetchEmployees.mockReset().mockResolvedValue({ ok: true, data: gusto });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const buttonByText = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function autoMatch() {
  await act(async () => {
    root.render(
      <MantineProvider>
        <GustoConfigClient
          connection={{
            id: 'conn-1', provider: 'gusto', displayName: 'Gusto', externalCompanyName: 'Acme', isActive: true,
            autoSyncOnApproval: false, lastSyncAt: null, lastSyncStatus: null, connectedAt: new Date('2026-10-01T12:00:00Z'),
          }}
          mappings={[]}
          syncLogs={[]}
          bytimeEmployees={employees}
          workspaceTimezone="America/New_York"
        />
      </MantineProvider>,
    );
  });
  await act(async () => { buttonByText('Load Gusto Employees').click(); });
  await settle();
  await act(async () => { buttonByText('Auto-Match by Email').click(); });
  await settle();
}

const autoMatchToasts = () => h.show.mock.calls.map(([n]) => n).filter((n: { title?: string }) => n.title === 'Auto-match complete');

describe('Gusto auto-match', () => {
  it('all saves fail (validation) → no success toast, nothing counted as matched', async () => {
    h.saveMapping.mockResolvedValue({ ok: false, code: 'validation', error: 'Bad mapping.' });
    await autoMatch();
    expect(h.saveMapping).toHaveBeenCalledTimes(3);
    expect(autoMatchToasts()).toEqual([]);
  });

  it('a pause code (read_only) stops the loop after the first refusal', async () => {
    h.saveMapping.mockResolvedValue({ ok: false, code: 'read_only', error: 'This workspace is read-only.' });
    await autoMatch();
    expect(h.saveMapping).toHaveBeenCalledTimes(1);
    expect(autoMatchToasts()).toEqual([]);
  });

  it('mixed outcomes → counts only the successes, in a warning toast', async () => {
    h.saveMapping
      .mockResolvedValueOnce({ ok: true, data: undefined })
      .mockResolvedValueOnce({ ok: false, code: 'validation', error: 'Bad mapping.' })
      .mockResolvedValueOnce({ ok: true, data: undefined });
    await autoMatch();
    expect(autoMatchToasts()).toEqual([expect.objectContaining({ message: expect.stringMatching(/^2 employees matched by email\. 1 could not be saved\./), color: 'warning' })]);
  });
});
