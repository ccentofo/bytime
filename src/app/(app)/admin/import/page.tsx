import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { ImportClient } from './ImportClient';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') redirect('/timesheet');

  return <ImportClient />;
}
