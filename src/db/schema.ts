import { pgTable, uuid, varchar, text, timestamp, boolean, pgEnum, uniqueIndex, integer } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRoleEnum = pgEnum('user_role', ['admin', 'supervisor', 'employee']);
export const statusEnum = pgEnum('record_status', ['active', 'inactive', 'closed']);
export const periodStatusEnum = pgEnum('period_status', ['draft', 'submitted', 'approved', 'rejected']);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  fullName: varchar('full_name', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull().default('employee'),
  isActive: boolean('is_active').notNull().default(true),
  passwordHash: varchar('password_hash', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export const contracts = pgTable('contracts', {
  id: uuid('id').defaultRandom().primaryKey(),
  contractNumber: varchar('contract_number', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  status: statusEnum('status').notNull().default('active'),
  startDate: timestamp('start_date', { withTimezone: true }),
  endDate: timestamp('end_date', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// CLINs (Contract Line Item Numbers)
// ---------------------------------------------------------------------------

export const clins = pgTable('clins', {
  id: uuid('id').defaultRandom().primaryKey(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  clinNumber: varchar('clin_number', { length: 50 }).notNull(),
  description: text('description'),
  status: statusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// User Assignments (DCAA RBAC enforcement)
// ---------------------------------------------------------------------------

export const userAssignments = pgTable('user_assignments', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clinId: uuid('clin_id').notNull().references(() => clins.id, { onDelete: 'cascade' }),
  isActive: boolean('is_active').notNull().default(true),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  assignedBy: uuid('assigned_by').references(() => users.id),
}, (table) => [
  uniqueIndex('user_clin_unique_idx').on(table.userId, table.clinId),
]);

// ---------------------------------------------------------------------------
// Timesheet Entries (DCAA append-only — NEVER update or delete rows)
// ---------------------------------------------------------------------------

export const timesheetEntries = pgTable('timesheet_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  clinId: uuid('clin_id').notNull().references(() => clins.id),
  entryDate: timestamp('entry_date', { withTimezone: true }).notNull(),
  hours: varchar('hours', { length: 10 }).notNull().default('0'), // stored as string to preserve exact decimal input
  revisionNumber: integer('revision_number').notNull().default(1),
  changeReasonCode: varchar('change_reason_code', { length: 50 }),
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => users.id),
});

// ---------------------------------------------------------------------------
// Timesheet Periods (tracks period lifecycle: draft → submitted → approved/rejected)
// ---------------------------------------------------------------------------

export const timesheetPeriods = pgTable('timesheet_periods', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  status: periodStatusEnum('status').notNull().default('draft'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submittedComment: text('submitted_comment'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewComment: text('review_comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('user_period_unique_idx').on(table.userId, table.periodStart),
]);
