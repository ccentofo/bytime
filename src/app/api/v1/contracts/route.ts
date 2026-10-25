import { NextRequest } from 'next/server';
import { getDb } from '@/db';
import { contracts, clins, slins } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { handleApiRequest, apiResponse } from '@/lib/api-auth';

export async function GET(request: NextRequest) {
  return handleApiRequest(request, () => listContracts(request));
}

async function listContracts(request: NextRequest): Promise<Response> {
  const db = await getDb();

  const allContracts = await db.select().from(contracts).orderBy(contracts.name);

  const result = await Promise.all(
    allContracts.map(async (contract) => {
  const db = await getDb();
      const contractClins = await db
        .select()
        .from(clins)
        .where(eq(clins.contractId, contract.id))
        .orderBy(clins.clinNumber);

      const clinsWithSlins = await Promise.all(
        contractClins.map(async (clin) => {
  const db = await getDb();
          const clinSlins = await db
            .select()
            .from(slins)
            .where(eq(slins.clinId, clin.id))
            .orderBy(slins.slinNumber);

          return { ...clin, slins: clinSlins };
        })
      );

      return { ...contract, clins: clinsWithSlins };
    })
  );

  return apiResponse(result, { total: result.length });
}
