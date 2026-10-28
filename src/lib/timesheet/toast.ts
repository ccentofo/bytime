import { notifications } from '@mantine/notifications';

/**
 * Timesheet toasts never speak (feature-plan-ux-timesheet-ui.md §4.5, trap T-E): the announcer does all speaking.
 * Mantine's Notification renders `role || "alert"`, so `role: undefined` would still be a live alert — it gets
 * role="none" instead. Error toasts stay until dismissed.
 */
export function quietToast(o: { title: string; message: string; color: string; error?: boolean }): void {
  notifications.show({ title: o.title, message: o.message, color: o.color, role: 'none', autoClose: o.error ? false : undefined });
}
