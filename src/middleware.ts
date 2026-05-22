export { auth as middleware } from '@/auth';

export const config = {
  matcher: [
    // Protect all (app) routes — timesheet and admin
    '/timesheet/:path*',
    '/admin/:path*',
  ],
};
