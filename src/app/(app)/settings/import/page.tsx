import { requirePageRole } from '@/lib/session';
import { ImportClient } from './ImportClient';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Data import' };

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  await requirePageRole('admin');

  return <ImportClient />;
}
