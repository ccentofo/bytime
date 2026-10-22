import { vi } from 'vitest';

// Mock the database module globally
// Individual tests can override with specific return values
vi.mock('@/db', () => {
  const mockDb = {
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
  };
  // Expose the tenant-aware accessors (getDb/getDbForUrl) alongside the legacy `db`
  // shape so server-action unit tests resolve a usable client after the control-plane refactor.
  return {
    db: mockDb,
    getDb: vi.fn().mockResolvedValue(mockDb),
    getDbForUrl: vi.fn().mockReturnValue(mockDb),
  };
});

// Mock auth module
vi.mock('@/auth', () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: 'test-user-id', email: 'test@bytime.dev', role: 'admin', fullName: 'Test Admin' },
  }),
}));

// Mock session module. AuthorizationError is real-shaped: userAction (src/lib/action-result.ts) maps it by instanceof.
vi.mock('@/lib/session', () => ({
  AuthorizationError: class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  },
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
