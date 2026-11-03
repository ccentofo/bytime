import { notifications } from '@mantine/notifications';
import type { ReactNode } from 'react';

/**
 * Toasts (feature-plan-ux-kit-contracts.md §3.6). An error stays until it's closed (autoClose: false), so it can't
 * vanish before it's read; Notifications keeps its default limit of 5 and queues the rest. Success uses the default
 * auto-close.
 */
export function toastError({ title, message }: { title: ReactNode; message: ReactNode }): void {
  notifications.show({ title, message, color: 'red', autoClose: false });
}

export function toastSuccess({ title, message, icon }: { title: ReactNode; message: ReactNode; icon?: ReactNode }): void {
  notifications.show({ title, message, color: 'success', ...(icon ? { icon } : {}) });
}
