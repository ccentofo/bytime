import { vi } from 'vitest';

// Mock the database module globally
// Individual tests can override with specific return values
vi.mock('@/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue([]),
  },
}));

// Mock auth module
vi.mock('@/auth', () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: 'test-user-id', email: 'test@bytime.dev', role: 'admin', fullName: 'Test Admin' },
  }),
}));

// Mock session module
vi.mock('@/lib/session', () => ({
  getSessionUser: vi.fn().mockResolvedValue({
    id: 'test-user-id',
    email: 'test@bytime.dev',
    fullName: 'Test Admin',
    role: 'admin',
  }),
  requireSession: vi.fn().mockResolvedValue({
    id: 'test-user-id',
    email: 'test@bytime.dev',
    fullName: 'Test Admin',
    role: 'admin',
  }),
  requireAdmin: vi.fn().mockResolvedValue({
    id: 'test-user-id',
    email: 'test@bytime.dev',
    fullName: 'Test Admin',
    role: 'admin',
  }),
}));
