// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

/**
 * UX-4A-AUDIT.md L10: a row's errors are keyed by position, not text — two identical messages both render without a
 * duplicate-key warning. Its own file: React logs a given key warning once per process.
 */

vi.mock('@/server/actions/import', () => ({}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { RowStatus } from '@/app/(app)/settings/import/ImportClient';
import { installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; vi.restoreAllMocks(); });

describe('RowStatus keys (L10)', () => {
  it('two identical errors both render, with no "same key" warning', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    m = await mount(<RowStatus row={{ rowIndex: 3, data: {}, errors: ['Date is invalid', 'Date is invalid'], isValid: false }} />);
    expect(m.container.textContent!.match(/Date is invalid/g)).toHaveLength(2);
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
  });
});
