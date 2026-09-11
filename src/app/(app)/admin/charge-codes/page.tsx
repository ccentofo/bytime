import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { listChargeCodes, listCostClasses } from '@/server/actions/charge-codes';
import { ChargeCodesClient } from './ChargeCodesClient';
import { getDb } from '@/db';
import { contracts, clins } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export default async function ChargeCodesPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = (session.user as any).role;
  if (role !== 'admin') redirect('/timesheet');

  const db = await getDb();
  const [codes, costClassList, contractList] = await Promise.all([
    listChargeCodes(),
    listCostClasses(),
    db.select({
      id: contracts.id,
      name: contracts.name,
      contractNumber: contracts.contractNumber,
      clins: clins.id,
      clinNumber: clins.clinNumber,
      clinDescription: clins.description,
    })
      .from(contracts)
      .innerJoin(clins, eq(clins.contractId, contracts.id))
      .where(and(eq(contracts.status, 'active'), eq(clins.status, 'active')))
      .orderBy(contracts.name, clins.clinNumber),
  ]);

  // Group CLINs by contract for the picker
  const contractMap = new Map<string, { id: string; name: string; contractNumber: string; clins: Array<{ id: string; clinNumber: string; description: string | null }> }>();
  for (const row of contractList) {
    if (!contractMap.has(row.id)) {
      contractMap.set(row.id, { id: row.id, name: row.name, contractNumber: row.contractNumber, clins: [] });
    }
    contractMap.get(row.id)!.clins.push({ id: row.clins, clinNumber: row.clinNumber, description: row.clinDescription ?? null });
  }

  return (
    <ChargeCodesClient
      initialCodes={codes}
      costClasses={costClassList}
      contracts={Array.from(contractMap.values())}
    />
  );
}
