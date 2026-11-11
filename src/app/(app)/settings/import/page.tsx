import { requirePageRole } from '@/lib/session';
import { getSetupPageData } from '@/server/actions/setup';
import { ImportClient } from './ImportClient';
import { importTypeFrom } from './import-types';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Import' };

export const dynamic = 'force-dynamic';

/** feature-plan-ux-setup-import.md P7: one Import page; `?type=` picks the type (unknown → People). */
export default async function ImportPage({ searchParams }: { searchParams: Promise<{ type?: string | string[] }> }) {
  await requirePageRole('admin');
  const { type } = await searchParams;
  const data = await getSetupPageData();
  return <ImportClient initialData={data} initialType={importTypeFrom(Array.isArray(type) ? type[0] : type)} />;
}
