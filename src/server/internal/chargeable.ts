import 'server-only';
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import { chargeCodes, clins, contracts, slins } from '@/db/schema';

/**
 * "Chargeable" charge code: the ONE rule for which direct codes take new hours (feature-plan-ux-navigation-home.md
 * §4.7, §4.8; UX-AUDIT B1, B5). A where-fragment over the already-joined `charge_codes`, `clins`, `contracts` and the
 * LEFT-joined `slins`: the code is active, its CLIN and contract are active, and its SLIN (if it has one) is active.
 * Used by timesheet row sourcing and the Setup counts. The save path applies the same facts per cell through
 * `newCellRefusal` (codeActive / clinActive / slinActive / contractActive).
 */
export const CHARGEABLE_CODE: SQL = and(
  eq(chargeCodes.isActive, true),
  eq(clins.status, 'active'),
  eq(contracts.status, 'active'),
  or(isNull(chargeCodes.slinId), eq(slins.status, 'active')),
)!;
