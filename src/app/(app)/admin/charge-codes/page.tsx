import { requirePageRole } from '@/lib/session';
import { listChargeCodes, listCostClasses } from '@/server/actions/charge-codes';
import { getAllLaborCategories } from '@/server/actions/labor-categories';
import { ChargeCodesClient } from './ChargeCodesClient';
import { getDb } from '@/db';
import { contracts, clins } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Charge codes' };

export const dynamic = 'force-dynamic';

export default async function ChargeCodesPage() {
  await requirePageRole('admin');

  const db = await getDb();
  const [codes, costClassList, contractList, laborCats] = await Promise.all([
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
    getAllLaborCategories(), // dated rates D3: the category options (filtered per code by DR-Q2 in the modal)
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
      laborCategories={laborCats.map((lc) => ({ id: lc.id, lcatCode: lc.lcatCode, title: lc.title, clinId: lc.clinId, slinId: lc.slinId, status: lc.status }))}
    />
  );
}
