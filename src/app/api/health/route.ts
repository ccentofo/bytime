import { NextResponse } from 'next/server';
import { controlDb } from '@/db/control-plane';
import { sql } from 'drizzle-orm';

export async function GET() {
  try {
    // Check control-plane DB connectivity
    await controlDb.execute(sql`SELECT 1`);

    return NextResponse.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.1.0',
    });
  } catch {
    return NextResponse.json(
      { status: 'unhealthy', error: 'Database connection failed' },
      { status: 503 }
    );
  }
}
