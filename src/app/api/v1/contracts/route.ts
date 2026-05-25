import { NextRequest } from 'next/server';
import { db } from '@/db';
import { contracts, clins, slins } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { validateApiKey, apiResponse, apiError } from '@/lib/api-auth';

export async function GET(request: NextRequest) {
  const authResult = await validateApiKey(request);
  if (authResult instanceof Response) return authResult;

  try {
    const allContracts = await db.select().from(contracts).orderBy(contracts.name);

    const result = await Promise.all(
      allContracts.map(async (contract) => {
        const contractClins = await db
          .select()
          .from(clins)
          .where(eq(clins.contractId, contract.id))
          .orderBy(clins.clinNumber);

        const clinsWithSlins = await Promise.all(
          contractClins.map(async (clin) => {
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
  } catch (error) {
    return apiError('Internal server error', 500);
  }
}
