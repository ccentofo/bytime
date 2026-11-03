'use client';

import { createContext, useContext, useId, type ReactNode } from 'react';
import { Button, Tooltip, VisuallyHidden, type ButtonProps } from '@mantine/core';

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
 * A Button for a write action. When the workspace can't write (feature-plan-ux-kit-contracts.md §3.5): aria-disabled +
 * data-disabled, never `disabled` (focus would drop) and never Mantine `loading` (the caller's `disabled` / `loading`
 * are dropped); a click does nothing; the reason is a visually hidden span named by aria-describedby (the Tooltip's
 * label renders lazily, so it can't be the description). Outside read-only mode it's a plain Button, unchanged.
 */
export function WriteButton({ disabled, loading, onClick, ...props }: WriteButtonProps) {
  const canWrite = useCanWrite();
  const reasonId = useId();
  if (canWrite) return <Button disabled={disabled} loading={loading} onClick={onClick} {...props} />;
  const readOnly = {
    ...props,
    'aria-disabled': true,
    'data-disabled': true,
    'data-read-only': 'true',
    'aria-describedby': [props['aria-describedby'], reasonId].filter(Boolean).join(' '),
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => { e.preventDefault(); e.stopPropagation(); },
  } as WriteButtonProps;
  return (
    <>
      <Tooltip label={READ_ONLY_TOOLTIP} withArrow>
        <Button {...readOnly} />
      </Tooltip>
      <VisuallyHidden id={reasonId}>{READ_ONLY_TOOLTIP}</VisuallyHidden>
    </>
  );
}
