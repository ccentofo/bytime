# Blueprint: Accounting System API — REST Endpoints for External Integration

## 1. Architectural Overview

### The Problem

The application has no programmatic interface for external systems. Government contractors typically use separate accounting/ERP systems (QuickBooks, Deltek CostPoint, SAP, Unanet) for invoicing, payroll, and financial reporting. Currently, the only way to get data out of ByTime is through the Reports admin page (CSV/Excel downloads), which requires manual download and import.

### The Solution

Create a set of **authenticated REST API endpoints** that external systems can call to pull timesheet data, cost data, and employee information. This enables:

1. **Payroll integration** — Pull approved timesheet hours per employee per period
2. **Invoicing** — Pull billable hours × rates by contract/CLIN for invoice generation
3. **Financial reporting** — Pull cost data for incurred cost submissions
4. **Employee sync** — Pull/push employee data between systems
5. **Contract sync** — Pull contract/CLIN structure

### Authentication Strategy

API endpoints use **API key authentication** (not JWT sessions). API keys are:
- Stored in the `apiKeys` table with a hashed key value
- Associated with a specific user (for audit trail — who authorized the integration)
- Scoped with permissions (read-only vs. read-write)
- Revocable by admins
- Rate-limited (separate from UI rate limits)

### API Design

RESTful JSON API at `/api/v1/`:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/timesheets` | List timesheet entries with filters |
| `GET` | `/api/v1/timesheets/approved` | Get approved hours by period |
| `GET` | `/api/v1/employees` | List employees |
| `GET` | `/api/v1/contracts` | List contracts with CLINs |
| `GET` | `/api/v1/costs` | Cost report data (hours × rates) |
| `GET` | `/api/v1/periods` | List timesheet periods with status |

All responses follow a consistent envelope:
```json
{
  "data": [...],
  "meta": {
    "total": 100,
    "page": 1,
    "pageSize": 50,
    "timestamp": "2026-05-24T18:00:00Z"
  }
}
```

---

## 2. File Topology

```
Files to CREATE:
├── src/server/actions/api-keys.ts                    ← Server Actions: API key CRUD
├── src/lib/api-auth.ts                               ← API key validation middleware
├── src/app/api/v1/
│   ├── timesheets/route.ts                           ← GET /api/v1/timesheets
│   ├── timesheets/approved/route.ts                  ← GET /api/v1/timesheets/approved
│   ├── employees/route.ts                            ← GET /api/v1/employees
│   ├── contracts/route.ts                            ← GET /api/v1/contracts
│   ├── costs/route.ts                                ← GET /api/v1/costs
│   └── periods/route.ts                              ← GET /api/v1/periods
├── src/app/(app)/admin/api-keys/
│   ├── page.tsx                                      ← Server Component: API key management
│   ├── ApiKeysClient.tsx                             ← Client Component: key management UI
│   └── ApiKeys.module.css                            ← Module CSS

Files to MODIFY:
├── src/db/schema.ts                                  ← Add apiKeys table
├── src/components/shell/AppNavbar.tsx                ← Add "API Keys" nav link
├── package.json                                      ← No new dependencies needed

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/auth.ts                                       ← ❌ DO NOT MODIFY
├── src/middleware.ts                                 ← ❌ DO NOT MODIFY
├── src/components/timesheet/**                       ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                   ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                     ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                   ← ❌ DO NOT MODIFY
├── src/server/actions/users.ts                       ← ❌ DO NOT MODIFY
├── src/server/actions/reports.ts                     ← ❌ DO NOT MODIFY
├── src/server/actions/dashboard.ts                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/**                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/users/**                       ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/approvals/**                   ← ❌ DO NOT MODIFY
├── src/app/(app)/timesheet/**                         ← ❌ DO NOT MODIFY
├── src/lib/session.ts                                ← ❌ DO NOT MODIFY
├── src/lib/offline/**                                ← ❌ DO NOT MODIFY
├── src/lib/email/**                                  ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** search inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify files in the "NOT TOUCHED" list.
> - All API endpoints must validate the API key before processing.
> - All API responses must use the consistent envelope format.
> - API keys must be **hashed** in the database (never stored in plaintext).
> - Use `crypto.randomBytes` for key generation and `crypto.createHash('sha256')` for hashing.
> - **After each phase, run `npm run build` to verify zero errors.**
> - Rate limit: 100 requests/minute per API key.

---

### Phase A: Schema — API Keys Table (A1)

#### A1. Modify `src/db/schema.ts` — Add `apiKeys` table

Add at the END of the file:

```typescript
// ---------------------------------------------------------------------------
// API Keys (for external system integration)
// ---------------------------------------------------------------------------

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),               // "QuickBooks Integration", "Deltek Sync"
  keyHash: varchar('key_hash', { length: 64 }).notNull().unique(), // SHA-256 hash of the API key
  keyPrefix: varchar('key_prefix', { length: 8 }).notNull(),       // First 8 chars for identification (e.g., "byt_a1b2")
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  permissions: varchar('permissions', { length: 50 }).notNull().default('read'), // 'read' or 'read-write'
  isActive: boolean('is_active').notNull().default(true),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),        // nullable — null means no expiry
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Push the schema:

```bash
npx drizzle-kit push
```

---

### Phase B: API Key Management (B1–B2)

#### B1. Create `src/server/actions/api-keys.ts`

```typescript
'use server';

import { db } from '@/db';
import { apiKeys } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';
import crypto from 'crypto';

/**
 * Generate a new API key. Returns the full key ONCE (it's not stored).
 * The hash is stored for later validation.
 */
export async function createApiKey(data: {
  name: string;
  createdByUserId: string;
  permissions?: 'read' | 'read-write';
  expiresAt?: Date;
}): Promise<{ id: string; key: string; prefix: string }> {
  await requireAdmin();

  // Generate a random API key: "byt_" + 32 random hex chars
  const randomBytes = crypto.randomBytes(24);
  const keyBody = randomBytes.toString('hex');
  const fullKey = `byt_${keyBody}`;
  const prefix = fullKey.substring(0, 8);

  // Hash the key for storage
  const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');

  const rows = await db.insert(apiKeys).values({
    name: data.name,
    keyHash,
    keyPrefix: prefix,
    createdByUserId: data.createdByUserId,
    permissions: data.permissions ?? 'read',
    expiresAt: data.expiresAt ?? null,
  }).returning();

  return {
    id: rows[0].id,
    key: fullKey, // Only returned once — user must copy it
    prefix,
  };
}

/**
 * Get all API keys (without the actual key — only prefix shown).
 */
export async function getApiKeys() {
  await requireAdmin();
  return db.select({
    id: apiKeys.id,
    name: apiKeys.name,
    keyPrefix: apiKeys.keyPrefix,
    permissions: apiKeys.permissions,
    isActive: apiKeys.isActive,
    lastUsedAt: apiKeys.lastUsedAt,
    expiresAt: apiKeys.expiresAt,
    createdAt: apiKeys.createdAt,
  }).from(apiKeys).orderBy(apiKeys.createdAt);
}

/**
 * Revoke (deactivate) an API key.
 */
export async function revokeApiKey(id: string): Promise<void> {
  await requireAdmin();
  await db.update(apiKeys)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(apiKeys.id, id));
}

/**
 * Delete an API key permanently.
 */
export async function deleteApiKey(id: string): Promise<void> {
  await requireAdmin();
  await db.delete(apiKeys).where(eq(apiKeys.id, id));
}
```

#### B2. Create `src/lib/api-auth.ts` — API key validation

```typescript
import { db } from '@/db';
import { apiKeys } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import crypto from 'crypto';
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit';

const API_RATE_LIMIT = 100;          // requests per minute per key
const API_RATE_WINDOW = 60 * 1000;   // 1 minute

export interface ApiKeyInfo {
  id: string;
  name: string;
  permissions: string;
  createdByUserId: string;
}

/**
 * Validate an API key from the request Authorization header.
 * Returns the key info if valid, or a Response object if invalid.
 */
export async function validateApiKey(request: Request): Promise<ApiKeyInfo | Response> {
  // Check rate limit first (by IP)
  const ip = getClientIp(request);
  const rateResult = checkRateLimit(`api:${ip}`, API_RATE_LIMIT, API_RATE_WINDOW);
  if (!rateResult.allowed) {
    return rateLimitResponse(rateResult.retryAfterMs);
  }

  // Extract API key from Authorization header
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    return new Response(
      JSON.stringify({ error: 'Missing Authorization header. Use: Authorization: Bearer byt_...' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return new Response(
      JSON.stringify({ error: 'Invalid Authorization format. Use: Authorization: Bearer byt_...' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const apiKey = parts[1];
  if (!apiKey.startsWith('byt_')) {
    return new Response(
      JSON.stringify({ error: 'Invalid API key format.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Hash the provided key and look it up
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      permissions: apiKeys.permissions,
      createdByUserId: apiKeys.createdByUserId,
      isActive: apiKeys.isActive,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);

  if (rows.length === 0) {
    return new Response(
      JSON.stringify({ error: 'Invalid API key.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const key = rows[0];

  if (!key.isActive) {
    return new Response(
      JSON.stringify({ error: 'API key has been revoked.' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
    return new Response(
      JSON.stringify({ error: 'API key has expired.' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Update lastUsedAt (fire-and-forget)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id))
    .then(() => {})
    .catch(() => {});

  // Also rate limit per API key (not just IP)
  const keyRateResult = checkRateLimit(`apikey:${key.id}`, API_RATE_LIMIT, API_RATE_WINDOW);
  if (!keyRateResult.allowed) {
    return rateLimitResponse(keyRateResult.retryAfterMs);
  }

  return {
    id: key.id,
    name: key.name,
    permissions: key.permissions,
    createdByUserId: key.createdByUserId,
  };
}

/**
 * Create a JSON API response with the standard envelope format.
 */
export function apiResponse(data: unknown, meta?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      data,
      meta: {
        timestamp: new Date().toISOString(),
        ...meta,
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

/**
 * Create a JSON API error response.
 */
export function apiError(message: string, status: number = 400): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}
```

---

### Phase C: API Endpoints (C1–C6)

#### C1. Create `src/app/api/v1/employees/route.ts`

```typescript
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
```

#### C2. Create `src/app/api/v1/contracts/route.ts`

```typescript
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
```

#### C3. Create `src/app/api/v1/timesheets/route.ts`

```typescript
import { NextRequest } from 'next/server';
import { db } from '@/db';
import { timesheetEntries, users, clins, contracts, indirectChargeCodes } from '@/db/schema';
import { eq, and, gte, lt, desc, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import { validateApiKey, apiResponse, apiError } from '@/lib/api-auth';

export async function GET(request: NextRequest) {
  const authResult = await validateApiKey(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const userId = searchParams.get('userId');
  const page = parseInt(searchParams.get('page') ?? '1');
  const pageSize = Math.min(parseInt(searchParams.get('pageSize') ?? '100'), 500);

  if (!startDate || !endDate) {
    return apiError('startDate and endDate query parameters are required (YYYY-MM-DD format).');
  }

  try {
    const start = new Date(startDate);
    const end = dayjs(endDate).add(1, 'day').toDate();

    const conditions = [
      gte(timesheetEntries.entryDate, start),
      lt(timesheetEntries.entryDate, end),
      eq(
        timesheetEntries.revisionNumber,
        sql`(
          SELECT MAX(te2.revision_number)
          FROM timesheet_entries te2
          WHERE te2.user_id = ${timesheetEntries.userId}
            AND COALESCE(te2.clin_id, te2.indirect_code_id) = COALESCE(${timesheetEntries.clinId}, ${timesheetEntries.indirectCodeId})
            AND te2.entry_date = ${timesheetEntries.entryDate}
        )`
      ),
    ];

    if (userId) {
      conditions.push(eq(timesheetEntries.userId, userId));
    }

    const rows = await db
      .select({
        id: timesheetEntries.id,
        userId: timesheetEntries.userId,
        employeeName: users.fullName,
        employeeEmail: users.email,
        clinId: timesheetEntries.clinId,
        clinNumber: clins.clinNumber,
        contractName: contracts.name,
        contractNumber: contracts.contractNumber,
        indirectCodeId: timesheetEntries.indirectCodeId,
        indirectCode: indirectChargeCodes.code,
        indirectCategory: indirectChargeCodes.category,
        entryDate: timesheetEntries.entryDate,
        hours: timesheetEntries.hours,
        revisionNumber: timesheetEntries.revisionNumber,
        createdAt: timesheetEntries.createdAt,
      })
      .from(timesheetEntries)
      .innerJoin(users, eq(timesheetEntries.userId, users.id))
      .leftJoin(clins, eq(timesheetEntries.clinId, clins.id))
      .leftJoin(contracts, eq(clins.contractId, contracts.id))
      .leftJoin(indirectChargeCodes, eq(timesheetEntries.indirectCodeId, indirectChargeCodes.id))
      .where(and(...conditions))
      .orderBy(users.fullName, timesheetEntries.entryDate)
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return apiResponse(rows, { total: rows.length, page, pageSize });
  } catch (error) {
    return apiError('Internal server error', 500);
  }
}
```

#### C4. Create `src/app/api/v1/timesheets/approved/route.ts`

```typescript
import { NextRequest } from 'next/server';
import { db } from '@/db';
import { timesheetEntries, timesheetPeriods, users, clins, contracts, indirectChargeCodes } from '@/db/schema';
import { eq, and, gte, lt, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import { validateApiKey, apiResponse, apiError } from '@/lib/api-auth';

export async function GET(request: NextRequest) {
  const authResult = await validateApiKey(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');

  if (!startDate || !endDate) {
    return apiError('startDate and endDate are required.');
  }

  try {
    const start = new Date(startDate);
    const end = dayjs(endDate).add(1, 'day').toDate();

    // Get approved periods in the date range
    const approvedPeriods = await db
      .select({
        userId: timesheetPeriods.userId,
        periodStart: timesheetPeriods.periodStart,
        approvedAt: timesheetPeriods.reviewedAt,
      })
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.status, 'approved'),
          gte(timesheetPeriods.periodStart, start),
          lt(timesheetPeriods.periodStart, end),
        )
      );

    // For each approved period, get the latest-revision entries
    const results = [];
    for (const period of approvedPeriods) {
      const entries = await db
        .select({
          userId: timesheetEntries.userId,
          employeeName: users.fullName,
          clinNumber: clins.clinNumber,
          contractNumber: contracts.contractNumber,
          indirectCode: indirectChargeCodes.code,
          entryDate: timesheetEntries.entryDate,
          hours: timesheetEntries.hours,
        })
        .from(timesheetEntries)
        .innerJoin(users, eq(timesheetEntries.userId, users.id))
        .leftJoin(clins, eq(timesheetEntries.clinId, clins.id))
        .leftJoin(contracts, eq(clins.contractId, contracts.id))
        .leftJoin(indirectChargeCodes, eq(timesheetEntries.indirectCodeId, indirectChargeCodes.id))
        .where(
          and(
            eq(timesheetEntries.userId, period.userId),
            gte(timesheetEntries.entryDate, period.periodStart),
            eq(
              timesheetEntries.revisionNumber,
              sql`(
                SELECT MAX(te2.revision_number)
                FROM timesheet_entries te2
                WHERE te2.user_id = ${timesheetEntries.userId}
                  AND COALESCE(te2.clin_id, te2.indirect_code_id) = COALESCE(${timesheetEntries.clinId}, ${timesheetEntries.indirectCodeId})
                  AND te2.entry_date = ${timesheetEntries.entryDate}
              )`
            ),
          )
        );

      results.push({
        periodStart: period.periodStart,
        approvedAt: period.approvedAt,
        entries,
      });
    }

    return apiResponse(results, { total: results.length });
  } catch (error) {
    return apiError('Internal server error', 500);
  }
}
```

#### C5. Create `src/app/api/v1/costs/route.ts`

```typescript
import { NextRequest } from 'next/server';
import { validateApiKey, apiResponse, apiError } from '@/lib/api-auth';
import { getDetailedCostReport } from '@/server/actions/reports';

export async function GET(request: NextRequest) {
  const authResult = await validateApiKey(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const contractId = searchParams.get('contractId');

  if (!startDate || !endDate) {
    return apiError('startDate and endDate are required.');
  }

  try {
    const data = await getDetailedCostReport(
      new Date(startDate),
      new Date(endDate),
      contractId ?? undefined
    );

    return apiResponse(data, { total: data.length });
  } catch (error) {
    return apiError('Internal server error', 500);
  }
}
```

#### C6. Create `src/app/api/v1/periods/route.ts`

```typescript
import { NextRequest } from 'next/server';
import { db } from '@/db';
import { timesheetPeriods, users } from '@/db/schema';
import { eq, and, gte, lt } from 'drizzle-orm';
import dayjs from 'dayjs';
import { validateApiKey, apiResponse, apiError } from '@/lib/api-auth';

export async function GET(request: NextRequest) {
  const authResult = await validateApiKey(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const status = searchParams.get('status');

  try {
    const conditions = [];

    if (startDate) {
      conditions.push(gte(timesheetPeriods.periodStart, new Date(startDate)));
    }
    if (endDate) {
      conditions.push(lt(timesheetPeriods.periodStart, dayjs(endDate).add(1, 'day').toDate()));
    }
    if (status) {
      conditions.push(eq(timesheetPeriods.status, status as any));
    }

    const rows = await db
      .select({
        id: timesheetPeriods.id,
        userId: timesheetPeriods.userId,
        employeeName: users.fullName,
        employeeEmail: users.email,
        periodStart: timesheetPeriods.periodStart,
        status: timesheetPeriods.status,
        submittedAt: timesheetPeriods.submittedAt,
        reviewedAt: timesheetPeriods.reviewedAt,
        reviewedBy: timesheetPeriods.reviewedBy,
      })
      .from(timesheetPeriods)
      .innerJoin(users, eq(timesheetPeriods.userId, users.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(timesheetPeriods.periodStart);

    return apiResponse(rows, { total: rows.length });
  } catch (error) {
    return apiError('Internal server error', 500);
  }
}
```

---

### Phase D: API Key Admin Page (D1–D3)

#### D1–D3. Create the admin page for API key management

Follow the same pattern as other admin pages. The page shows:
- MRT table listing all API keys: Name, Prefix (`byt_a1b2...`), Permissions, Active, Last Used, Expires, Created
- "Create API Key" button → Modal with name, permissions select, optional expiry date
- **Important:** When a key is created, show the full key in a one-time-only modal with a copy button. The key is NEVER shown again.
- Row actions: Revoke (deactivate), Delete
- Add "API Keys" nav link to `AppNavbar.tsx`

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

### 4b. API Checks

```bash
# Create an API key via the admin UI, then test:

# List employees
curl -H "Authorization: Bearer byt_<your-key>" http://localhost:3000/api/v1/employees

# List contracts
curl -H "Authorization: Bearer byt_<your-key>" http://localhost:3000/api/v1/contracts

# Get timesheet entries
curl -H "Authorization: Bearer byt_<your-key>" "http://localhost:3000/api/v1/timesheets?startDate=2026-05-01&endDate=2026-05-31"

# Get approved timesheets
curl -H "Authorization: Bearer byt_<your-key>" "http://localhost:3000/api/v1/timesheets/approved?startDate=2026-05-01&endDate=2026-05-31"

# Get cost report
curl -H "Authorization: Bearer byt_<your-key>" "http://localhost:3000/api/v1/costs?startDate=2026-05-01&endDate=2026-05-31"
```

### 4c. Security Checks

| Check | Expected Result |
|---|---|
| No Authorization header | 401: "Missing Authorization header" |
| Invalid API key | 401: "Invalid API key" |
| Revoked API key | 403: "API key has been revoked" |
| Expired API key | 403: "API key has expired" |
| Rate limit exceeded | 429 with Retry-After header |
| Valid key — employees endpoint | 200 with employee data |
| lastUsedAt updates | After API call, lastUsedAt reflects current time |

### 4d. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `crypto` not available | Edge runtime | These routes use Node.js runtime (default). Verify no `export const runtime = 'edge'` |
| API key hash mismatch | Hashing algorithm inconsistent | Always use SHA-256: `crypto.createHash('sha256').update(key).digest('hex')` |
| `apiKeys` table not found | Schema not pushed | Run `npx drizzle-kit push` |
| Slow API responses | N+1 queries in contracts endpoint | Acceptable for MVP; optimize with single query + grouping if needed |
| Key shown after page refresh | Key stored in state | Key is only shown once in the creation modal; state clears on close |
