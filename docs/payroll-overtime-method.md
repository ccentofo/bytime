# Payroll export — FLSA weekly overtime method

Status: **required before production** (feature-plan-certified-outputs.md C7). It has to be reviewed by a payroll
accountant before payroll export is marketed (CO-D2).

Implementation:
- `src/lib/payroll/flsa.ts`: the calculation (pure).
- `src/server/internal/payroll-data.ts`: which hours feed it.
- `src/lib/integrations/connectors/payroll-export.ts`: the file layouts.

## 1. What the export computes

- **Federal FLSA overtime only.** Overtime is hours worked over **40 in a workweek**, for non-exempt employees
  (29 CFR 778.103–778.105). No state rules apply: no daily overtime, no California-style rules, no seventh-day rules.
  Every file and screen labels it "FLSA weekly overtime".
- **The workweek is fixed.** It is the 7 days starting on the workspace's **workweek start day** (Settings → Workweek;
  0 = Sunday … 6 = Saturday). It has no default, so payroll export (and the Gusto payroll record) refuses to run until
  an admin sets it.
- **Each workweek stands alone.** Hours are never averaged across weeks. A workweek that crosses a pay-period boundary,
  or the edge of the export's date range, is still one week. The export reads up to 6 days before the range start so a
  boundary week's earlier days count toward its 40 hours; those earlier days are never reported twice.
- **Overtime falls on the day it occurs.** Within each workweek, days are walked in date order. The hours beyond the
  40th worked hour are overtime on the day they happen; the rest of that day is regular.
- **Exact arithmetic.** All arithmetic is in integer hundredths of an hour, so a week of exactly 40.00 hours has
  exactly 0 overtime.

## 2. Which hours count

| Hours | Counts toward the 40? | Exported as |
|---|---|---|
| Direct (charge code / CLIN) and non-leave indirect (overhead, G&A, IR&D, B&P, unallowable) | Yes, as hours worked | Regular / Overtime |
| Leave with pay type **PTO** | No (29 CFR 778.218–778.219) | PTO column |
| Leave with pay type **Sick** | No | Sick column |
| Leave with pay type **Holiday** | No | Holiday column |
| Leave with pay type **Unpaid** | No | Never a paid column; shown only in the Daily hours detail and the Custom export |

- **Leave is never Regular.** It goes in its own columns (CO-D11). For example, 40 h worked plus 8 h holiday gives
  0 overtime and 8 holiday hours.
- **Every leave code needs a pay type.** The pay type is set on the Indirect Codes page and is required for any code
  in the Leave category.
  - The built-in codes ship with it pre-set: LV-AL = PTO, LV-SL = Sick, LV-HOL = Holiday, LV-LWOP = Unpaid. Migration
    0014 backfilled these on existing workspaces.
  - Only a pre-existing custom leave code can be missing a pay type. While one has hours in the range, the export
    refuses and lists the codes.
- **Only approved timesheets are reported.** A date is reported only if it is in the range **and** its containing
  pay period is approved. The containing period is the one whose dates cover that day, so a period that started before
  the range still contributes its in-range days.
- **Unapproved days still count toward the 40.** An unapproved day earlier in the same workweek is included in the
  overtime calculation, because the hours were recorded. If a reported day's split relied on such a day, the employee
  is **flagged** ("Overtime uses unapproved days"). Flagged employees are listed on screen before download, and the
  flag is on the Gusto payroll record.

## 3. Exempt employees

- Employees marked FLSA-exempt stay in every export with **0 overtime**.
- Their hours over 40 are reported as **uncompensated overtime**. This appears only in the Custom export and the Daily
  hours detail; vendor files carry no uncompensated-overtime column (CO-D14).
- **Partial-day unpaid leave can risk the exemption.** Deducting partial days of unpaid leave from an exempt
  employee's salary can put the exemption at risk under federal rules. That decision belongs to the payroll accountant
  (CO-D16). The export screen states this in its help text.

## 4. Files

| File | Columns |
|---|---|
| ADP | Regular Hours (worked only), OT Hours, PTO Hours, Sick Hours, Holiday Hours, Total Hours (= Regular + OT + PTO + Sick + Holiday) |
| Paychex | Hours (REG), OT Hours / OT, PTO Hours / PTO, Sick Hours / SICK, Holiday Hours / HOL (earnings code blank when 0) |
| Gusto CSV | regular_hours, overtime_hours, pto_hours, sick_hours, holiday_hours (no `hours` total column — the columns sum to total paid) |
| Gusto payroll record | regular, overtime, PTO, sick, holiday, uncompensated overtime and the flag, per employee. It is recorded in the sync log only; no Gusto API call is made |
| Custom | billable / non-billable, Regular (worked), Overtime, Uncompensated Overtime, PTO, Sick, Holiday, Unpaid Leave, Total Paid, Total Recorded (all hours, paid or not) |
| Daily hours detail | per employee per reported date: worked, regular, overtime, uncompensated overtime, PTO, sick, holiday, unpaid leave, workweek start used |

The vendor column names and earnings codes are a best layout and **have not been verified** against ADP, Paychex or
Gusto import specifications. Verify them in staging before marketing payroll export.

## 5. Limits the payroll accountant should know

- **The workweek setting is a current value**, not effective-dated. FLSA requires a fixed workweek (29 CFR 778.105).
  The Settings page warns before an admin changes it, and every change is recorded in the admin change log (who, when,
  old, new). Exports always use the current setting, including exports of past ranges.
- **`flsa_exempt` is also a current value.** A past range is computed with each employee's exempt status as of today.
- **Corrections show up on re-export.** Each figure uses the latest revision of every entry at export time, so a later
  correction changes a re-export of the same range.
