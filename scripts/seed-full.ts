/**
 * Comprehensive database seed — 6 months of realistic GovCon timesheet data.
 * Run with: npm run db:seed:full
 *
 * Creates: 8 users, 3 contracts, 8 CLINs, 4 SLINs, 10 LCATs, 15 assignments,
 * 9 indirect codes, ~2400 timesheet entries, 72 period records, notification prefs,
 * login attempts, and 1 API key.
 *
 * Safe to re-run: clears existing data first, then re-seeds.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import dayjs from 'dayjs';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime';
const client = postgres(connectionString, { max: 1 });
const db = drizzle(client);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid() { return crypto.randomUUID(); }

function getNumDays(periodStart: Date): number {
  const d = dayjs(periodStart);
  return d.date() === 1 ? 15 : d.daysInMonth() - 15;
}

function isWeekday(date: dayjs.Dayjs): boolean {
  const dow = date.day();
  return dow >= 1 && dow <= 5;
}

// ---------------------------------------------------------------------------
// Main Seed
// ---------------------------------------------------------------------------

async function seed() {
  console.log('🌱 Starting comprehensive database seed...\n');

  // ── Clear existing data (reverse FK order) ──
  console.log('  Clearing existing data...');
  await db.delete(schema.timesheetEntries);
  await db.delete(schema.timesheetPeriods);
  await db.delete(schema.userLaborCategories);
  await db.delete(schema.userAssignments);
  await db.delete(schema.laborCategories);
  await db.delete(schema.slins);
  await db.delete(schema.clins);
  await db.delete(schema.contracts);
  await db.delete(schema.indirectChargeCodes);
  await db.delete(schema.loginAttempts);
  await db.delete(schema.notificationPreferences);
  await db.delete(schema.apiKeys);
  await db.delete(schema.users);

  // ── 1. Users ──
  console.log('  Creating users...');
  const hash = await bcrypt.hash('Password123!', 4); // Low cost for speed

  const userIds = {
    admin: uuid(), sarah: uuid(), mike: uuid(),
    jane: uuid(), john: uuid(), emily: uuid(), robert: uuid(), lisa: uuid(),
  };

  await db.insert(schema.users).values([
    { id: userIds.admin, email: 'admin@bytime.dev', fullName: 'Admin User', role: 'admin', passwordHash: hash, isActive: true, flsaExempt: false },
    { id: userIds.sarah, email: 'sarah.wilson@bytime.dev', fullName: 'Sarah Wilson', role: 'supervisor', passwordHash: hash, isActive: true, flsaExempt: true },
    { id: userIds.mike, email: 'mike.chen@bytime.dev', fullName: 'Mike Chen', role: 'supervisor', passwordHash: hash, isActive: true, flsaExempt: true },
    { id: userIds.jane, email: 'jane.smith@bytime.dev', fullName: 'Jane Smith', role: 'employee', passwordHash: hash, isActive: true, flsaExempt: true },
    { id: userIds.john, email: 'john.doe@bytime.dev', fullName: 'John Doe', role: 'employee', passwordHash: hash, isActive: true, flsaExempt: false },
    { id: userIds.emily, email: 'emily.davis@bytime.dev', fullName: 'Emily Davis', role: 'employee', passwordHash: hash, isActive: true, flsaExempt: true },
    { id: userIds.robert, email: 'robert.taylor@bytime.dev', fullName: 'Robert Taylor', role: 'employee', passwordHash: hash, isActive: true, flsaExempt: false },
    { id: userIds.lisa, email: 'lisa.anderson@bytime.dev', fullName: 'Lisa Anderson', role: 'employee', passwordHash: hash, isActive: false, flsaExempt: true },
  ]);
  console.log('    ✓ 8 users created');

  // ── 2. Contracts ──
  console.log('  Creating contracts...');
  const contractIds = { navair: uuid(), disa: uuid(), army: uuid() };

  await db.insert(schema.contracts).values([
    { id: contractIds.navair, contractNumber: 'W58RGZ-21-C-0001', name: 'NAVAIR Systems Support', description: 'Avionics software development and sustainment', contractType: 'prime', status: 'active', startDate: new Date('2025-01-01'), endDate: new Date('2027-12-31'), fundedValue: '2500000.00', ceilingValue: '3500000.00' },
    { id: contractIds.disa, contractNumber: 'HC1028-22-C-0015', name: 'DISA Cyber Operations', description: 'Cybersecurity operations and monitoring', contractType: 'prime', status: 'active', startDate: new Date('2025-06-01'), endDate: new Date('2028-05-31'), fundedValue: '1800000.00', ceilingValue: '2200000.00' },
    { id: contractIds.army, contractNumber: 'W911QX-23-D-0042', name: 'Army IT Support', description: 'IT help desk and network operations', contractType: 'sub', status: 'active', startDate: new Date('2025-10-01'), endDate: new Date('2026-09-30'), fundedValue: '750000.00', ceilingValue: '1000000.00' },
  ]);
  console.log('    ✓ 3 contracts created');

  // ── 3. CLINs ──
  console.log('  Creating CLINs...');
  const clinIds = {
    nav01: uuid(), nav02: uuid(), nav03: uuid(),
    disa01: uuid(), disa02: uuid(),
    army01: uuid(), army02: uuid(), army03: uuid(),
  };

  await db.insert(schema.clins).values([
    { id: clinIds.nav01, contractId: contractIds.navair, clinNumber: '0001', description: 'Base Year Labor', fundedAmount: '1200000.00', status: 'active' },
    { id: clinIds.nav02, contractId: contractIds.navair, clinNumber: '0002', description: 'Option Year 1 Labor', fundedAmount: '800000.00', status: 'active' },
    { id: clinIds.nav03, contractId: contractIds.navair, clinNumber: '0003', description: 'ODC — Travel', fundedAmount: '50000.00', status: 'active' },
    { id: clinIds.disa01, contractId: contractIds.disa, clinNumber: '0001', description: 'Cyber Operations Labor', fundedAmount: '1000000.00', status: 'active' },
    { id: clinIds.disa02, contractId: contractIds.disa, clinNumber: '0002', description: 'Cloud Infrastructure', fundedAmount: '300000.00', status: 'active' },
    { id: clinIds.army01, contractId: contractIds.army, clinNumber: '0001', description: 'Help Desk Support', fundedAmount: '300000.00', status: 'active' },
    { id: clinIds.army02, contractId: contractIds.army, clinNumber: '0002', description: 'Network Operations', fundedAmount: '250000.00', status: 'active' },
    { id: clinIds.army03, contractId: contractIds.army, clinNumber: '0003', description: 'Training & Transition', fundedAmount: '100000.00', status: 'active' },
  ]);
  console.log('    ✓ 8 CLINs created');

  // ── 4. SLINs ──
  console.log('  Creating SLINs...');
  const slinIds = { nav01aa: uuid(), nav01ab: uuid(), disa01aa: uuid(), disa01ab: uuid() };

  await db.insert(schema.slins).values([
    { id: slinIds.nav01aa, clinId: clinIds.nav01, slinNumber: '0001AA', description: 'Base Year Q1-Q2', fundedAmount: '600000.00' },
    { id: slinIds.nav01ab, clinId: clinIds.nav01, slinNumber: '0001AB', description: 'Base Year Q3-Q4', fundedAmount: '600000.00' },
    { id: slinIds.disa01aa, clinId: clinIds.disa01, slinNumber: '0001AA', description: 'Offensive Operations', fundedAmount: '500000.00' },
    { id: slinIds.disa01ab, clinId: clinIds.disa01, slinNumber: '0001AB', description: 'Defensive Operations', fundedAmount: '500000.00' },
  ]);
  console.log('    ✓ 4 SLINs created');

  // ── 5. Labor Categories ──
  console.log('  Creating labor categories...');
  const lcatIds: Record<string, string> = {};
  const lcats = [
    { clinId: clinIds.nav01, code: 'SE-III', title: 'Senior Software Engineer', rate: '145.00', ceiling: '160.00' },
    { clinId: clinIds.nav01, code: 'SE-II', title: 'Software Engineer', rate: '110.00', ceiling: '125.00' },
    { clinId: clinIds.nav01, code: 'PM-II', title: 'Program Manager', rate: '165.00', ceiling: '180.00' },
    { clinId: clinIds.nav02, code: 'SE-I', title: 'Junior Software Engineer', rate: '80.00', ceiling: '95.00' },
    { clinId: clinIds.disa01, code: 'SA-II', title: 'Systems Administrator', rate: '100.00', ceiling: '115.00' },
    { clinId: clinIds.disa01, code: 'SE-III', title: 'Senior Cyber Engineer', rate: '150.00', ceiling: '170.00' },
    { clinId: clinIds.disa02, code: 'BA-I', title: 'Business Analyst', rate: '95.00', ceiling: '110.00' },
    { clinId: clinIds.army01, code: 'HD-I', title: 'Help Desk Analyst', rate: '55.00', ceiling: '65.00' },
    { clinId: clinIds.army02, code: 'SA-I', title: 'Junior Systems Administrator', rate: '75.00', ceiling: '85.00' },
    { clinId: clinIds.army03, code: 'TR-I', title: 'Technical Trainer', rate: '85.00', ceiling: '100.00' },
  ];

  for (const lcat of lcats) {
    const id = uuid();
    lcatIds[`${lcat.clinId}-${lcat.code}`] = id;
    await db.insert(schema.laborCategories).values({
      id, clinId: lcat.clinId, lcatCode: lcat.code, title: lcat.title,
      hourlyRate: lcat.rate, ceilingRate: lcat.ceiling, status: 'active',
    });
  }
  console.log('    ✓ 10 labor categories created');

  // ── 6. User Assignments ──
  console.log('  Creating user assignments...');
  const assignments = [
    // Sarah (supervisor) — assigned to NAVAIR and DISA (so she can approve those employees)
    { userId: userIds.sarah, clinId: clinIds.nav01 },
    { userId: userIds.sarah, clinId: clinIds.disa01 },
    // Mike (supervisor) — assigned to Army
    { userId: userIds.mike, clinId: clinIds.army01 },
    { userId: userIds.mike, clinId: clinIds.army02 },
    // Jane — NAVAIR
    { userId: userIds.jane, clinId: clinIds.nav01 },
    { userId: userIds.jane, clinId: clinIds.nav02 },
    // John — NAVAIR + DISA
    { userId: userIds.john, clinId: clinIds.nav01 },
    { userId: userIds.john, clinId: clinIds.disa01 },
    // Emily — DISA + Army
    { userId: userIds.emily, clinId: clinIds.disa01 },
    { userId: userIds.emily, clinId: clinIds.army01 },
    // Robert — Army
    { userId: userIds.robert, clinId: clinIds.army01 },
    { userId: userIds.robert, clinId: clinIds.army02 },
    { userId: userIds.robert, clinId: clinIds.army03 },
    // Lisa (inactive) — was on NAVAIR
    { userId: userIds.lisa, clinId: clinIds.nav01 },
    { userId: userIds.lisa, clinId: clinIds.nav03 },
  ];

  for (const a of assignments) {
    await db.insert(schema.userAssignments).values({
      userId: a.userId, clinId: a.clinId, isActive: true, assignedBy: userIds.admin,
    });
  }
  // Deactivate Lisa's assignments
  await db.delete(schema.userAssignments).where(eq(schema.userAssignments.userId, userIds.lisa));
  await db.insert(schema.userAssignments).values([
    { userId: userIds.lisa, clinId: clinIds.nav01, isActive: false, assignedBy: userIds.admin },
  ]);
  console.log('    ✓ 15 user assignments created');

  // ── 7. User Labor Categories ──
  console.log('  Creating user labor category assignments...');
  const ulcats = [
    { userId: userIds.jane, lcatKey: `${clinIds.nav01}-SE-III` },
    { userId: userIds.jane, lcatKey: `${clinIds.nav02}-SE-I` },
    { userId: userIds.john, lcatKey: `${clinIds.nav01}-SE-II` },
    { userId: userIds.john, lcatKey: `${clinIds.disa01}-SA-II` },
    { userId: userIds.emily, lcatKey: `${clinIds.disa01}-SE-III` },
    { userId: userIds.emily, lcatKey: `${clinIds.army01}-HD-I` },
    { userId: userIds.robert, lcatKey: `${clinIds.army01}-HD-I` },
    { userId: userIds.robert, lcatKey: `${clinIds.army02}-SA-I` },
  ];

  for (const u of ulcats) {
    const lcatId = lcatIds[u.lcatKey];
    if (lcatId) {
      await db.insert(schema.userLaborCategories).values({
        userId: u.userId, laborCategoryId: lcatId,
        effectiveDate: new Date('2025-12-01'), assignedBy: userIds.admin,
      });
    }
  }
  console.log('    ✓ 8 user labor category assignments created');

  // ── 8. Indirect Charge Codes ──
  console.log('  Creating indirect charge codes...');
  const indirectIds: Record<string, string> = {};
  const indirects = [
    { code: 'OH-001', name: 'Overhead', category: 'overhead' as const, description: 'General overhead — admin, training, company meetings' },
    { code: 'GA-001', name: 'General & Administrative', category: 'ga' as const, description: 'G&A expenses — management, accounting, HR' },
    { code: 'IRAD-001', name: 'IR&D', category: 'irad' as const, description: 'Independent Research & Development' },
    { code: 'BP-001', name: 'Bid & Proposal', category: 'bp' as const, description: 'Proposal preparation and bid activities' },
    { code: 'LV-AL', name: 'Annual Leave', category: 'leave' as const, description: 'Paid annual leave / vacation' },
    { code: 'LV-SL', name: 'Sick Leave', category: 'leave' as const, description: 'Paid sick leave' },
    { code: 'LV-HOL', name: 'Holiday', category: 'leave' as const, description: 'Company-observed holiday' },
    { code: 'LV-LWOP', name: 'Leave Without Pay', category: 'leave' as const, description: 'Unpaid leave of absence' },
    { code: 'UA-001', name: 'Unallowable', category: 'unallowable' as const, description: 'Non-reimbursable activities (FAR 31.205)' },
  ];

  for (const ic of indirects) {
    const id = uuid();
    indirectIds[ic.code] = id;
    await db.insert(schema.indirectChargeCodes).values({
      id, code: ic.code, name: ic.name, category: ic.category,
      description: ic.description, isActive: true, availableToAll: true,
    });
  }
  console.log('    ✓ 9 indirect charge codes created');

  // ── 9. Timesheet Entries + Periods (6 months: Dec 2025 → May 2026) ──
  console.log('  Creating timesheet entries and periods (6 months)...');

  const activeEmployees = [
    { id: userIds.jane, clinIds: [clinIds.nav01, clinIds.nav02], hours: [6, 2] },
    { id: userIds.john, clinIds: [clinIds.nav01, clinIds.disa01], hours: [5, 3] },
    { id: userIds.emily, clinIds: [clinIds.disa01, clinIds.army01], hours: [4, 4] },
    { id: userIds.robert, clinIds: [clinIds.army01, clinIds.army02], hours: [5, 3] },
    { id: userIds.sarah, clinIds: [clinIds.nav01], hours: [4] },
    { id: userIds.mike, clinIds: [clinIds.army01], hours: [3] },
  ];

  // Generate all semi-monthly periods from Dec 1 2025 to current
  const periods: Date[] = [];
  let pStart = dayjs('2025-12-01');
  const now = dayjs();
  while (pStart.isBefore(now)) {
    periods.push(pStart.toDate());
    const numDays = getNumDays(pStart.toDate());
    if (pStart.date() === 1) {
      pStart = pStart.date(16);
    } else {
      pStart = pStart.add(1, 'month').date(1);
    }
  }

  let entryCount = 0;
  let periodCount = 0;
  const holidays = ['2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25'];

  for (const emp of activeEmployees) {
    for (let pi = 0; pi < periods.length; pi++) {
      const periodStart = periods[pi];
      const numDays = getNumDays(periodStart);
      const isCurrentPeriod = pi === periods.length - 1;
      const isPendingReview = pi === periods.length - 2;

      // Determine period status
      let status: 'draft' | 'submitted' | 'approved' | 'rejected' = 'approved';
      if (isCurrentPeriod) status = 'draft';
      else if (isPendingReview) status = 'submitted';

      // Create period record
      const periodId = uuid();
      const submittedAt = status !== 'draft' ? dayjs(periodStart).add(numDays, 'day').add(1, 'day').toDate() : null;
      const reviewedAt = status === 'approved' ? dayjs(periodStart).add(numDays + 2, 'day').toDate() : null;
      const reviewedBy = status === 'approved'
        ? (emp.clinIds.includes(clinIds.army01) || emp.clinIds.includes(clinIds.army02) ? userIds.mike : userIds.sarah)
        : null;

      await db.insert(schema.timesheetPeriods).values({
        id: periodId, userId: emp.id, periodStart, status,
        submittedAt, reviewedAt, reviewedBy,
        submittedComment: status !== 'draft' ? 'Timesheet complete' : null,
        reviewComment: status === 'approved' ? 'Approved — looks good' : null,
      });
      periodCount++;

      // Create daily entries for this period
      for (let d = 0; d < numDays; d++) {
        const entryDate = dayjs(periodStart).add(d, 'day');
        if (!isWeekday(entryDate)) continue;
        if (isCurrentPeriod && entryDate.isAfter(now, 'day')) continue;

        const dateStr = entryDate.format('YYYY-MM-DD');
        const isHoliday = holidays.includes(dateStr);

        if (isHoliday) {
          // Log holiday hours to leave code
          await db.insert(schema.timesheetEntries).values({
            userId: emp.id, clinId: null, indirectCodeId: indirectIds['LV-HOL'],
            entryDate: entryDate.toDate(), hours: '8', revisionNumber: 1, createdBy: emp.id,
          });
          entryCount++;
          continue;
        }

        // Log direct hours to assigned CLINs
        for (let ci = 0; ci < emp.clinIds.length; ci++) {
          const baseHours = emp.hours[ci] ?? 4;
          // Add some variation
          const variation = ((d + pi + ci) % 3 === 0) ? 0.5 : ((d + pi) % 5 === 0 ? -0.5 : 0);
          const hours = Math.max(0, Math.min(10, baseHours + variation));

          if (hours > 0) {
            await db.insert(schema.timesheetEntries).values({
              userId: emp.id, clinId: emp.clinIds[ci], indirectCodeId: null,
              entryDate: entryDate.toDate(), hours: hours.toFixed(2),
              revisionNumber: 1, createdBy: emp.id,
            });
            entryCount++;
          }
        }

        // Some days: add overhead hours (Fridays)
        if (entryDate.day() === 5 && pi % 2 === 0) {
          await db.insert(schema.timesheetEntries).values({
            userId: emp.id, clinId: null, indirectCodeId: indirectIds['OH-001'],
            entryDate: entryDate.toDate(), hours: '1.00', revisionNumber: 1, createdBy: emp.id,
          });
          entryCount++;
        }
      }

      // Add some corrections (revision 2) for older periods
      if (pi < periods.length - 3 && pi % 3 === 0) {
        const corrDate = dayjs(periodStart).add(2, 'day');
        if (isWeekday(corrDate)) {
          await db.insert(schema.timesheetEntries).values({
            userId: emp.id, clinId: emp.clinIds[0], indirectCodeId: null,
            entryDate: corrDate.toDate(), hours: '7.50',
            revisionNumber: 2, changeReasonCode: 'CORRECTION',
            comment: 'Corrected hours — was on training for part of the day',
            createdBy: emp.id,
          });
          entryCount++;
        }
      }
    }
  }
  console.log(`    ✓ ${entryCount} timesheet entries created`);
  console.log(`    ✓ ${periodCount} period records created`);

  // ── 10. Notification Preferences ──
  console.log('  Creating notification preferences...');
  const allUserIds = Object.values(userIds);
  for (const uid of allUserIds) {
    await db.insert(schema.notificationPreferences).values({
      userId: uid, emailOnSubmit: true, emailOnApprove: true, emailOnReject: true,
      emailDailyReminder: uid !== userIds.admin, emailDeadlineReminder: true,
    });
  }
  console.log('    ✓ 8 notification preference records created');

  // ── 11. Login Attempts ──
  console.log('  Creating login attempt history...');
  const loginData = [
    { email: 'admin@bytime.dev', successful: true },
    { email: 'admin@bytime.dev', successful: true },
    { email: 'jane.smith@bytime.dev', successful: true },
    { email: 'jane.smith@bytime.dev', successful: false },
    { email: 'jane.smith@bytime.dev', successful: true },
    { email: 'john.doe@bytime.dev', successful: true },
    { email: 'unknown@hacker.com', successful: false },
    { email: 'unknown@hacker.com', successful: false },
    { email: 'emily.davis@bytime.dev', successful: true },
    { email: 'robert.taylor@bytime.dev', successful: true },
  ];
  for (const la of loginData) {
    await db.insert(schema.loginAttempts).values(la);
  }
  console.log('    ✓ 10 login attempt records created');

  // ── 12. API Key ──
  console.log('  Creating API key...');
  const apiKeyValue = `byt_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(apiKeyValue).digest('hex');
  await db.insert(schema.apiKeys).values({
    name: 'QuickBooks Integration',
    keyHash,
    keyPrefix: apiKeyValue.substring(0, 8),
    createdByUserId: userIds.admin,
    permissions: 'read',
    isActive: true,
  });
  console.log(`    ✓ 1 API key created (prefix: ${apiKeyValue.substring(0, 8)}...)`);

  // ── Done ──
  console.log('\n✅ Database seed complete!');
  console.log('\n📋 Summary:');
  console.log('  • 8 users (password: Password123!)');
  console.log('  • 3 contracts, 8 CLINs, 4 SLINs');
  console.log('  • 10 labor categories, 8 user-LCAT assignments');
  console.log('  • 9 indirect charge codes');
  console.log(`  • ${entryCount} timesheet entries (6 months)`);
  console.log(`  • ${periodCount} period records`);
  console.log('  • 8 notification preferences');
  console.log('  • 10 login attempts, 1 API key');
  console.log('\n👤 Login credentials:');
  console.log('  admin@bytime.dev / Password123! (admin)');
  console.log('  sarah.wilson@bytime.dev / Password123! (supervisor)');
  console.log('  mike.chen@bytime.dev / Password123! (supervisor)');
  console.log('  jane.smith@bytime.dev / Password123! (employee)');
  console.log('  john.doe@bytime.dev / Password123! (employee)');
  console.log('  emily.davis@bytime.dev / Password123! (employee)');
  console.log('  robert.taylor@bytime.dev / Password123! (employee)');
  console.log('  lisa.anderson@bytime.dev / Password123! (employee, inactive)');

  await client.end();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
