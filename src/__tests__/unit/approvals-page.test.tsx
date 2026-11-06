import { describe, it, expect, vi } from 'vitest';

/**
 * feature-plan-ux-approvals-payroll.md §3.1.7 (UX-4B2-AUDIT.md L8): the Approvals page reads `?review=` — the first
 * value when repeated, and only a UUID (anything else is ignored, so nothing opens).
 */

vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({ requirePageRole: vi.fn(async () => ({ id: 'sup-1', role: 'supervisor' })) }));
vi.mock('@/server/actions/periods', () => ({ getScopedPeriods: async () => [], getMyScopeInfo: async () => null }));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceTimezone: async () => 'America/New_York' }));
vi.mock('@/server/actions/users', () => ({ getApprovalNotices: async () => null }));
vi.mock('@/components/approvals/ApprovalNotices', () => ({ ApprovalNotices: () => null }));
vi.mock('@/app/(app)/admin/approvals/ApprovalsClient', () => ({ ApprovalsClient: () => null }));

import ApprovalsPage from '@/app/(app)/admin/approvals/page';

const ID1 = '3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f';
const ID2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const reviewIdFor = async (review: string | string[] | undefined) =>
  ((await ApprovalsPage({ searchParams: Promise.resolve(review === undefined ? {} : { review }) })) as { props: { initialReviewId: string | null } }).props.initialReviewId;

describe('Approvals page ?review= (L8)', () => {
  it('a UUID is passed on; a repeated param uses the first value', async () => {
    expect(await reviewIdFor(ID1)).toBe(ID1);
    expect(await reviewIdFor([ID2, ID1])).toBe(ID2);
  });

  it('an invalid or missing value is ignored (null)', async () => {
    expect(await reviewIdFor('not-a-uuid')).toBeNull();
    expect(await reviewIdFor('1; DROP TABLE')).toBeNull();
    expect(await reviewIdFor(['nope', ID1])).toBeNull();
    expect(await reviewIdFor(undefined)).toBeNull();
    expect(await reviewIdFor('')).toBeNull();
  });
});
