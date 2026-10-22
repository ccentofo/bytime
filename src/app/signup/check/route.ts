import { NextRequest, NextResponse } from 'next/server';
import { checkSlugLookupRateLimit, getClientIp } from '@/lib/rate-limit';
import { checkSlugAvailable } from '@/server/actions/signup';
import { slugify } from '@/lib/tenant/slugify';

export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const limit = checkSlugLookupRateLimit(ip); // shared with the apex workspace finder
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const raw = req.nextUrl.searchParams.get('slug') ?? '';
  const slug = raw.trim() || slugify(req.nextUrl.searchParams.get('name') ?? '');
  if (!slug) return NextResponse.json({ available: false, reason: 'empty' });

  const result = await checkSlugAvailable(slug);
  return NextResponse.json({ ...result, slug });
}
