import { requirePageRole } from '@/lib/session';
import { listChargeCodes, listCostClasses } from '@/server/actions/charge-codes';
import { getAllLaborCategories } from '@/server/actions/labor-categories';
import { getIndirectChargeCodes } from '@/server/actions/indirect-codes';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import { ChargeCodesClient } from './ChargeCodesClient';
import { getDb } from '@/db';
import { contracts, clins, slins } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { firstParam } from '@/lib/assignments-params';
import { parseCodesTab } from '@/lib/charge-codes-tab';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Charge codes' };

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Charge codes, with Direct and Indirect as tabs (feature-plan-ux-people-codes.md R1, §3). The server reads `tab` for
 * the first render only (the client follows the URL); `?code={id}` still opens that code's category dialog.
 */
export default async function ChargeCodesPage({ searchParams }: { searchParams: Promise<{ code?: string | string[]; tab?: string | string[] }> }) {
  await requirePageRole('admin');
  const sp = await searchParams;
  const initialTab = parseCodesTab(firstParam(sp.tab));
  // feature-plan-ux-kit-contracts.md §4.4.7: ?code={id} (from the Unpriced report) opens that code's category dialog.
  const code = firstParam(sp.code);
  const openCategoryForId = code && UUID.test(code) ? code : undefined;

  const db = await getDb();
  const [codes, costClassList, contractList, laborCats, slinList, indirectCodes, workspaceToday] = await Promise.all([
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
    // §3.4: the form's SLIN options (active SLINs; an edited code's own inactive SLIN is added from its row).
    db.select({ id: slins.id, clinId: slins.clinId, slinNumber: slins.slinNumber, description: slins.description })
      .from(slins).where(eq(slins.status, 'active')).orderBy(slins.slinNumber),
    getIndirectChargeCodes(),
    getWorkspaceToday(),
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
      initialTab={initialTab}
      initialCodes={codes}
      costClasses={costClassList}
      contracts={Array.from(contractMap.values())}
      slins={slinList}
      laborCategories={laborCats.map((lc) => ({ id: lc.id, lcatCode: lc.lcatCode, title: lc.title, clinId: lc.clinId, slinId: lc.slinId, status: lc.status }))}
      indirectCodes={indirectCodes}
      workspaceToday={workspaceToday}
      openCategoryForId={openCategoryForId}
    />
  );
}
