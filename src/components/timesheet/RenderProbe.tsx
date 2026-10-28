'use client';

import { createContext } from 'react';

/**
 * Test-only render counter (feature-plan-ux-timesheet-ui.md §9, B-T10). Null in the app; a test provides a function and
 * grid cells call `useContext(RenderProbeContext)?.('cell', key)` while rendering — no global mutation, no refs.
 */
export const RenderProbeContext = createContext<((kind: 'cell', key: string) => void) | null>(null);
