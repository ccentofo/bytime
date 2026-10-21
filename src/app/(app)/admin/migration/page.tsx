import { requirePageRole } from '@/lib/session';
import { MigrationClient } from './MigrationClient';

export const dynamic = 'force-dynamic';

export default async function MigrationPage() {
  await requirePageRole('admin');

  return <MigrationClient />;
}
