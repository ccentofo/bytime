import { NextRequest } from 'next/server';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { validateApiKey, apiResponse, apiError } from '@/lib/api-auth';

export async function GET(request: NextRequest) {
  const authResult = await validateApiKey(request);
  if (authResult instanceof Response) return authResult;

  try {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        role: users.role,
        isActive: users.isActive,
        flsaExempt: users.flsaExempt,
      })
      .from(users)
      .where(eq(users.isActive, true))
      .orderBy(users.fullName);

    return apiResponse(rows, { total: rows.length });
  } catch (error) {
    return apiError('Internal server error', 500);
  }
}
