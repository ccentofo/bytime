'use client';

import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { cssVariablesResolver, theme } from '@/theme';

/**
 * Client-side providers (UX-1 §4.1.3). The root layout is a Server Component, so it can't pass a function prop
 * (`cssVariablesResolver`) to MantineProvider; this client component does.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MantineProvider defaultColorScheme="auto" theme={theme} cssVariablesResolver={cssVariablesResolver}>
      <Notifications position="top-right" autoClose={4000} />
      {children}
    </MantineProvider>
  );
}
