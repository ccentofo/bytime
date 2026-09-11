# Blueprint: QuickBooks Online Charge-Code Import & Dimensioned Push

> **Role for the executing developer: Integrations engineer.** Let admins **generate charge codes in
> QuickBooks and import them into CadenzPoint**, and make the timesheet push send the full QBO
> dimension set (Customer:Job + Service Item + Class). This is the CEO's actual workflow.
>
> **Prerequisite: `feature-plan-charge-codes.md` must be done first** — `charge_codes` and
> `cost_classes` tables and the charge-code timesheet model must already exist.

## 1. Overview & Current State

The CEO generates charge codes in QuickBooks (as **Service Items**), under **Customer:Jobs**, tagged
with a **Class**, and imports them into his timekeeping tool. CadenzPoint must do the same.

**What already exists (good news):** `src/lib/integrations/connectors/qbo-api.ts` already implements
`fetchQBOCustomers` (`SELECT * FROM Customer`), `fetchQBOServiceItems`
(`SELECT * FROM Item WHERE Type='Service'`), and `pushTimeActivities` (sends `CustomerRef` + `ItemRef`).
The connector (`quickbooks-online.ts`) declares `pull_customers` + `pull_service_items` and the generic
`integration_entity_mappings` table stores `bytimeEntityId ↔ externalEntityId` per `entityType`.

**What's missing:**
1. **No QBO Class** support (no `fetchQBOClasses`, no `ClassRef` on push).
2. **Mapping only matches existing entities** — there is no flow that **creates `charge_codes` (and
   `cost_classes`) from QBO** Service Items/Classes. That import is the core of this blueprint.
3. **Push uses CLIN-era assumptions** — it must send the charge code's Service Item as `ItemRef` and
   its Class as `ClassRef`.

## 2. Mapping Model
```
QBO Customer:Job   →  contract           (entity_mappings: entityType 'contract')
QBO Service Item   →  charge_code        (entity_mappings: entityType 'charge_code')   ← NEW
QBO Class          →  cost_class         (entity_mappings: entityType 'class')         ← NEW
On push (TimeActivity):  CustomerRef = contract's customer · ItemRef = charge code's service item ·
                         ClassRef = charge code's class
```

## 3. File Topology
```
CONNECTOR / API:
├── src/lib/integrations/connectors/qbo-api.ts          ← add fetchQBOClasses + QBOClass; add ClassRef to TimeActivityInput + pushTimeActivities
├── src/lib/integrations/connectors/quickbooks-online.ts← add fetchExternalClasses; 'pull_classes' capability; wire ItemRef=charge code mapping, ClassRef=class mapping in pushTimesheetEntries
├── src/lib/integrations/types.ts                        ← EntityMappingType += 'charge_code'|'class'; ConnectorCapability += 'pull_classes'; add fetchExternalClasses?; extend TimesheetSyncEntry (serviceItem/class refs)
└── src/lib/integrations/sync-engine.ts                  ← build TimesheetSyncEntry with chargeCode→serviceItem + class mappings

IMPORT FLOW:
├── src/server/actions/integrations.ts (or qbo.ts)      ← importQboCustomers/ServiceItems/Classes → create contracts?/charge_codes/cost_classes + write mappings
└── src/app/(app)/admin/integrations/quickbooks/QBOConfigClient.tsx ← "Import from QuickBooks" UI (pull → select → create + map)

DO NOT MODIFY:
├── charge-code core model (done in the prior blueprint) — reuse its actions
├── the append-only timesheet model
└── OAuth/token logic in qbo-api.ts (already works)
```

## 4. Step-by-Step

> **⚠️ GUARDRAILS:**
> - Read the QBO API docs section in `node_modules`/existing `qbo-api.ts` patterns before adding queries.
> - Card data / tokens stay encrypted; never log access tokens.
> - Import must be **idempotent**: re-running updates existing mappings, doesn't duplicate charge codes
>   (match on the QBO external id via `integration_entity_mappings`).
> - A charge code still **requires a CLIN** (from blueprint 1). Import must resolve a CLIN for each
>   created code — via the Customer:Job→contract mapping (then a CLIN under it) or an admin choice.
>   Never create an orphan charge code.
> - `npm run build`, `npm run test`, `npm run lint` pass.

**Step 1 — QBO Class fetch** (`qbo-api.ts`). Add, mirroring `fetchQBOServiceItems`:
```ts
export interface QBOClass { Id: string; Name: string; FullyQualifiedName?: string; Active?: boolean; }

export async function fetchQBOClasses(accessToken: string, realmId: string): Promise<QBOClass[]> {
  return qboQuery<QBOClass>(accessToken, realmId, "SELECT * FROM Class WHERE Active = true MAXRESULTS 1000");
}
```
Add `ClassRef?: { value: string }` to `TimeActivityInput` and set it in `pushTimeActivities` when present
(alongside the existing `CustomerRef`/`ItemRef`).

**Step 2 — Connector + types.**
- `types.ts`: `EntityMappingType` → add `'charge_code'` and `'class'`; `ConnectorCapability` → add
  `'pull_classes'`; add optional `fetchExternalClasses?(accessToken, companyId)` to the interface;
  extend `TimesheetSyncEntry` with `serviceItemExternalId?` and `classExternalId?` (or resolve at push
  time from mappings — see Step 5).
- `quickbooks-online.ts`: add `fetchExternalClasses` → `fetchQBOClasses`; add `'pull_classes'` to
  `capabilities`.

**Step 3 — Import server actions** (`integrations.ts`/`qbo.ts`), `requireAdmin`:
- `fetchQboImportCandidates(connectionId)` → returns QBO Customers, Service Items, Classes (for the UI),
  each annotated with whether it's already mapped.
- `importQboClasses(connectionId, selected)` → upsert `cost_classes` (create via the charge-code
  blueprint's `createCostClass`) and write `integration_entity_mappings` rows (`entityType: 'class'`).
- `importQboChargeCodes(connectionId, items)` where each item carries the chosen `clinId` (and resolved
  contract) + optional `classId` + `workLocation`: create `charge_codes` (reuse `createChargeCode`) and
  write `entityType: 'charge_code'` mappings (bytimeEntityId = charge code id, externalEntityId = QBO
  Item id). Idempotent: if a mapping for that QBO item exists, update the code instead of creating.
- Reuse the existing contract↔customer mapping path for Customer:Job. (Optionally
  `importQboCustomersAsContracts` if the admin wants to create contracts from Customer:Jobs — keep
  optional; the CEO's flow is mainly Service Items → charge codes against existing contracts/CLINs.)

**Step 4 — Import UI** (`QBOConfigClient.tsx`). Add an **"Import from QuickBooks"** section:
1. Button: *Fetch from QuickBooks* → calls `fetchQboImportCandidates`.
2. Three lists (Customers, Service Items, Classes) with "already imported" badges.
3. **Classes:** multi-select → *Import classes* (`importQboClasses`).
4. **Service Items → charge codes:** for each selected Service Item, pick the **Contract→CLIN** it
   rolls up to (default-resolved from its Customer:Job mapping if available), optional Class (from the
   imported list), optional Work Location, then *Import as charge codes* (`importQboChargeCodes`).
5. Show a result summary (created / updated / skipped). Use Mantine table + the existing
   `Table.ScrollContainer` responsive pattern.

**Step 5 — Dimensioned push** (`quickbooks-online.ts` `pushTimesheetEntries` + `sync-engine.ts`). For
each approved direct entry being pushed:
- `CustomerRef` = the entry's contract → QBO Customer (existing contract mapping).
- `ItemRef` = the entry's **charge code → QBO Service Item** (`entityType: 'charge_code'` mapping).
- `ClassRef` = the charge code's **class → QBO Class** (`entityType: 'class'` mapping), when set.
Update the `SyncContext.mappings` build and the `TimesheetSyncEntry` assembly in `sync-engine.ts` to
include the charge-code and class external ids. Indirect entries push as today (no charge code).

## 5. Verification

### 5a. Build/tests/lint
```bash
npm run build && npm run test && npm run lint
```

### 5b. Import (QBO sandbox)
| Check | Expected |
|---|---|
| Fetch from QuickBooks | Customers, Service Items, Classes list; already-mapped flagged |
| Import classes | `cost_classes` created; `class` mappings written; re-run doesn't duplicate |
| Import service items → charge codes (pick CLIN + class) | `charge_codes` created under the chosen CLIN with class set; `charge_code` mappings written |
| Re-run import | idempotent — updates, no duplicates |
| Charge code requires CLIN | import refuses/forces a CLIN choice; no orphan codes |

### 5c. Push (QBO sandbox)
| Check | Expected |
|---|---|
| Approve + push a direct entry | TimeActivity has CustomerRef (contract), ItemRef (service item), ClassRef (class) |
| Entry whose charge code has no class | pushes without ClassRef (no error) |
| Indirect entry | pushes as before |
| Sync logs | per-record success/failure captured (existing sync log tables) |

### 5d. Common errors
| Symptom | Cause | Fix |
|---|---|---|
| Import creates orphan/duplicate codes | not checking existing `charge_code` mapping | match on QBO external id; upsert |
| Push missing ItemRef | charge code not mapped to a Service Item | surface unmapped codes in the UI before push |
| Class not applied in QBO | ClassRef not set or class unmapped | ensure `class` mapping exists; set ClassRef |
| Token/401 on fetch | token refresh | reuse `ensureValidToken` (already in qbo-api.ts) |

## 6. Definition of Done
An admin can pull QuickBooks Customers, Service Items, and Classes, **create CadenzPoint charge codes
(and cost classes) from them** (idempotently, each rolled up to a CLIN), and approved time pushes back
to QBO as `TimeActivity` carrying Customer:Job + Service Item + Class — matching the CEO's HourTimesheet
workflow.
```
