# Blueprint: Input Validation & Sanitization — Server-Side Data Integrity Guards

## 1. Architectural Overview

### The Problem

Server actions currently accept user input and pass it directly to Drizzle ORM for database operations. While Drizzle provides SQL injection protection via parameterized queries, there is no **business logic validation** on input values. Examples of unguarded inputs:

- Contract numbers could be empty strings or contain SQL-like patterns
- Hours values could be negative, NaN, Infinity, or strings like "abc"
- Email addresses aren't validated beyond HTML `type="email"` (client-side only)
- Rate values could be negative or unreasonably large
- UUID parameters aren't validated for format
- Text fields have no max-length enforcement beyond DB column limits

### Design: Validation Layer

Create a shared validation utility (`src/lib/validation.ts`) with reusable validators, then apply them at the top of each server action's mutation functions. Validation errors return structured error messages — they do NOT throw (to avoid exposing server internals).

### Key Principle

**Validate at the boundary, trust internally.** Server actions are the boundary between client and server. Once data passes validation, internal functions can trust it.

---

## 2. File Topology

```
Files to CREATE:
├── src/lib/validation.ts                            ← Shared validation functions

Files to MODIFY:
├── src/server/actions/contracts.ts                   ← Validate contract number, name, dates, values
├── src/server/actions/clins.ts                       ← Validate CLIN number, funded amount
├── src/server/actions/slins.ts                       ← Validate SLIN number, funded amount
├── src/server/actions/users.ts                       ← Validate email, name, role
├── src/server/actions/labor-categories.ts            ← Validate LCAT code, title, rates
├── src/server/actions/timesheet.ts                   ← Validate hours range, date bounds
├── src/server/actions/indirect-codes.ts              ← Validate code, name, category
├── src/server/actions/password.ts                    ← Validate password (already has this — verify only)

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                                  ← ❌ DO NOT MODIFY
├── src/auth.ts                                       ← ❌ DO NOT MODIFY
├── src/middleware.ts                                 ← ❌ DO NOT MODIFY
├── src/components/**                                 ← ❌ DO NOT MODIFY
├── src/app/**                                        ← ❌ DO NOT MODIFY
├── src/lib/session.ts                                ← ❌ DO NOT MODIFY
├── src/lib/date-utils.ts                             ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                     ← ❌ DO NOT MODIFY (already validates)
├── src/server/actions/dashboard.ts                   ← ❌ DO NOT MODIFY (read-only)
├── src/server/actions/audit.ts                       ← ❌ DO NOT MODIFY (read-only)
├── src/server/actions/reports.ts                     ← ❌ DO NOT MODIFY (read-only)
├── src/server/actions/notifications.ts               ← ❌ DO NOT MODIFY
├── src/server/actions/supervisor-scope.ts             ← ❌ DO NOT MODIFY (read-only)
├── src/server/actions/login-attempts.ts               ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** search inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify files in the "NOT TOUCHED" list.
> - Validation functions must be **pure** (no DB calls, no side effects).
> - Validation errors should **throw** with descriptive messages (consistent with existing pattern in `periods.ts`).
> - **After each phase, run `npm run build` to verify zero errors.**

---

### Phase A: Create Validation Utility (A1)

#### A1. Create `src/lib/validation.ts`

```typescript
/**
 * Shared input validation utilities.
 * All validators throw on invalid input with descriptive error messages.
 * Used as guards at the top of server action mutation functions.
 */

// ---------------------------------------------------------------------------
// String Validators
// ---------------------------------------------------------------------------

export function validateRequired(value: unknown, fieldName: string): string {
  if (value === null || value === undefined) {
    throw new Error(`${fieldName} is required.`);
  }
  const str = String(value).trim();
  if (str.length === 0) {
    throw new Error(`${fieldName} cannot be empty.`);
  }
  return str;
}

export function validateStringLength(value: string, fieldName: string, min: number, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new Error(`${fieldName} must be at least ${min} characters.`);
  }
  if (trimmed.length > max) {
    throw new Error(`${fieldName} must not exceed ${max} characters.`);
  }
  return trimmed;
}

export function validateOptionalString(value: unknown, fieldName: string, maxLength: number): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const str = String(value).trim();
  if (str.length > maxLength) {
    throw new Error(`${fieldName} must not exceed ${maxLength} characters.`);
  }
  return str;
}

// ---------------------------------------------------------------------------
// Email Validator
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(value: unknown, fieldName: string = 'Email'): string {
  const str = validateRequired(value, fieldName).toLowerCase().trim();
  if (!EMAIL_REGEX.test(str)) {
    throw new Error(`${fieldName} is not a valid email address.`);
  }
  if (str.length > 255) {
    throw new Error(`${fieldName} must not exceed 255 characters.`);
  }
  return str;
}

// ---------------------------------------------------------------------------
// Numeric Validators
// ---------------------------------------------------------------------------

export function validateHours(value: unknown, fieldName: string = 'Hours'): number {
  const num = Number(value);
  if (isNaN(num) || !isFinite(num)) {
    throw new Error(`${fieldName} must be a valid number.`);
  }
  if (num < 0) {
    throw new Error(`${fieldName} cannot be negative.`);
  }
  if (num > 24) {
    throw new Error(`${fieldName} cannot exceed 24 hours per day.`);
  }
  return Math.round(num * 100) / 100; // 2 decimal places
}

export function validateMonetaryValue(value: unknown, fieldName: string): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const str = String(value).trim();
  const num = parseFloat(str);
  if (isNaN(num) || !isFinite(num)) {
    throw new Error(`${fieldName} must be a valid number.`);
  }
  if (num < 0) {
    throw new Error(`${fieldName} cannot be negative.`);
  }
  if (num > 999999999.99) {
    throw new Error(`${fieldName} exceeds maximum allowed value.`);
  }
  return num.toFixed(2);
}

export function validateRate(value: unknown, fieldName: string): string {
  const str = validateRequired(value, fieldName);
  const num = parseFloat(str);
  if (isNaN(num) || !isFinite(num)) {
    throw new Error(`${fieldName} must be a valid number.`);
  }
  if (num < 0) {
    throw new Error(`${fieldName} cannot be negative.`);
  }
  if (num > 9999.99) {
    throw new Error(`${fieldName} exceeds maximum allowed rate ($9,999.99/hr).`);
  }
  return num.toFixed(2);
}

// ---------------------------------------------------------------------------
// UUID Validator
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUUID(value: unknown, fieldName: string): string {
  const str = validateRequired(value, fieldName);
  if (!UUID_REGEX.test(str)) {
    throw new Error(`${fieldName} is not a valid identifier.`);
  }
  return str;
}

// ---------------------------------------------------------------------------
// Enum Validator
// ---------------------------------------------------------------------------

export function validateEnum<T extends string>(value: unknown, fieldName: string, allowed: readonly T[]): T {
  const str = validateRequired(value, fieldName);
  if (!allowed.includes(str as T)) {
    throw new Error(`${fieldName} must be one of: ${allowed.join(', ')}.`);
  }
  return str as T;
}

// ---------------------------------------------------------------------------
// Date Validator
// ---------------------------------------------------------------------------

export function validateOptionalDate(value: unknown, fieldName: string): Date | undefined {
  if (value === null || value === undefined) return undefined;
  const date = new Date(value as string | number | Date);
  if (isNaN(date.getTime())) {
    throw new Error(`${fieldName} is not a valid date.`);
  }
  return date;
}

// ---------------------------------------------------------------------------
// Contract Number Validator (specific format)
// ---------------------------------------------------------------------------

export function validateContractNumber(value: unknown): string {
  const str = validateRequired(value, 'Contract number');
  return validateStringLength(str, 'Contract number', 1, 50);
}

export function validateClinNumber(value: unknown): string {
  const str = validateRequired(value, 'CLIN number');
  return validateStringLength(str, 'CLIN number', 1, 50);
}

export function validateSlinNumber(value: unknown): string {
  const str = validateRequired(value, 'SLIN number');
  return validateStringLength(str, 'SLIN number', 1, 50);
}
```

---

### Phase B: Apply Validation to Server Actions (B1–B7)

Apply validators to the **mutation functions only** (not reads). Add validation calls as the first lines inside each function, AFTER the `requireAdmin()` call (if present).

#### B1. `src/server/actions/contracts.ts` — `createContract`, `updateContract`

In `createContract`, add after `await requireAdmin();`:
```typescript
import { validateContractNumber, validateRequired, validateStringLength, validateOptionalString, validateOptionalDate, validateMonetaryValue } from '@/lib/validation';

// Inside createContract:
const validatedData = {
  contractNumber: validateContractNumber(data.contractNumber),
  name: validateStringLength(validateRequired(data.name, 'Contract name'), 'Contract name', 1, 255),
  description: validateOptionalString(data.description, 'Description', 2000),
  contractType: data.contractType ?? 'prime',
  startDate: validateOptionalDate(data.startDate, 'Start date'),
  endDate: validateOptionalDate(data.endDate, 'End date'),
  fundedValue: validateMonetaryValue(data.fundedValue, 'Funded value'),
  ceilingValue: validateMonetaryValue(data.ceilingValue, 'Ceiling value'),
};
```

Use `validatedData` instead of `data` in the insert.

Apply the same pattern to `updateContract` (only validate fields that are provided).

#### B2–B7. Apply similar validation to clins, slins, users, labor-categories, timesheet, indirect-codes

Each file gets the appropriate validators for its data types. The pattern is the same: validate at the top, use validated data in the query.

**For `timesheet.ts` specifically:**
- In `saveTimesheetBatch`, validate each cell's `hours` field with `validateHours()`
- Validate `userId` with `validateUUID()`
- Validate `clinId`/`indirectCodeId` with `validateUUID()` when present

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

### 4b. Validation Checks

| Check | Expected Result |
|---|---|
| Create contract with empty name | Error: "Contract name cannot be empty." |
| Create contract with 300-char name | Error: "Contract name must not exceed 255 characters." |
| Save hours = -1 | Error: "Hours cannot be negative." |
| Save hours = 25 | Error: "Hours cannot exceed 24 hours per day." |
| Save hours = NaN | Error: "Hours must be a valid number." |
| Create user with invalid email | Error: "Email is not a valid email address." |
| Create LCAT with rate = -50 | Error: "Hourly rate cannot be negative." |
| Normal operations | No change in behavior — validation passes silently |

### 4c. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| Validation throws for valid data | Validator too strict | Check edge cases (empty strings vs. undefined, 0 vs. null) |
| `validateRequired` breaks optional fields | Applied to optional field | Use `validateOptionalString` for optional fields |
| Build error on import | Wrong import path | Verify `@/lib/validation` path |
