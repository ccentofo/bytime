import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';

vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

import { AppHeader } from '@/components/shell/AppHeader';

// F1 (feature-plan-terms-compliance-fixes.md §0/§4.2): lifecycle-exempt (demo/internal) workspaces are always
// visibly marked, never hidden. (Static render: no DOM needed.)
const user = { fullName: 'Ada Admin', email: 'ada@test.dev', role: 'admin' };
const html = (isDemo?: boolean) => renderToStaticMarkup(<MantineProvider><AppHeader user={user} isDemo={isDemo} /></MantineProvider>);

describe('Demo marker (F1)', () => {
  it('is shown for an exempt workspace', () => {
    expect(html(true)).toMatch(/>Demo</);
  });
  it('is absent for a normal workspace', () => {
    expect(html(false)).not.toMatch(/>Demo</);
  });
});
