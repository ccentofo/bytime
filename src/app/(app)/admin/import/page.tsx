import { requirePageRole } from '@/lib/session';
import { ImportClient } from './ImportClient';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  await requirePageRole('admin');

  return <ImportClient />;
}
