import { requirePageRole } from '@/lib/session';
import { MigrationClient } from './MigrationClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Timesheet history import' };

export const dynamic = 'force-dynamic';

export default async function MigrationPage() {
  await requirePageRole('admin');

  return <MigrationClient />;
}
