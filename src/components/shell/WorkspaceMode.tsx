'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { Button, Tooltip, type ButtonProps } from '@mantine/core';

/**
 * Workspace access mode for the UI (feature-plan-launch-blockers.md P4 §5). The value is a per-render snapshot of the
 * (app) layout's getTenantState(), refreshed on navigation/refresh — not live. VISIBILITY ONLY: the server write gate
 * (getDbForWrite) is the real control; a stale "full" here just means the server refuses with a read_only result.
 */
export type WorkspaceMode = 'full' | 'read_only';

const WorkspaceModeContext = createContext<WorkspaceMode>('full');

export const READ_ONLY_TOOLTIP = 'This workspace is read-only. Subscribe to make changes.';

export function WorkspaceModeProvider({ mode, children }: { mode: WorkspaceMode; children: ReactNode }) {
  return <WorkspaceModeContext.Provider value={mode}>{children}</WorkspaceModeContext.Provider>;
}

export function useWorkspaceMode(): WorkspaceMode {
  return useContext(WorkspaceModeContext);
}

/** True only in `full` mode — gate every control that triggers a business-data write. */
export function useCanWrite(): boolean {
  return useContext(WorkspaceModeContext) === 'full';
}

type WriteButtonProps = ButtonProps & Omit<React.ComponentPropsWithoutRef<'button'>, keyof ButtonProps>;

/**
 * A Button for a write action: disabled, with an explanatory tooltip, when the workspace can't write. (A disabled
 * button fires no mouse events, so the tooltip wraps a span.)
 */
export function WriteButton({ disabled, ...props }: WriteButtonProps) {
  const canWrite = useCanWrite();
  if (canWrite) return <Button disabled={disabled} {...props} />;
  return (
    <Tooltip label={READ_ONLY_TOOLTIP} withArrow>
      <span style={{ display: 'inline-block' }}>
        <Button {...props} disabled data-read-only="true" />
      </span>
    </Tooltip>
  );
}
