import { requirePageRole } from '@/lib/session';
import { PayrollExportClient } from './PayrollExportClient';

export const dynamic = 'force-dynamic';

export default async function PayrollExportPage() {
  await requirePageRole('admin');

  return <PayrollExportClient />;
}
