import { NextRequest } from 'next/server';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { handleApiRequest, apiResponse } from '@/lib/api-auth';

export async function GET(request: NextRequest) {
  return handleApiRequest(request, () => listEmployees(request));
}

async function listEmployees(request: NextRequest): Promise<Response> {
  const db = await getDb();

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
}
