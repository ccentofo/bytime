import { requirePageRole } from '@/lib/session';
import { PayrollExportClient } from './PayrollExportClient';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Payroll export' };

export const dynamic = 'force-dynamic';

export default async function PayrollExportPage() {
  await requirePageRole('admin');

  return <PayrollExportClient today={await getWorkspaceToday()} />;
}
