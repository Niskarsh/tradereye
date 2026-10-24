import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { tick } from '@/lib/shorts/publish';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST (Authorization: Bearer CRON_SECRET) -> the posting timer: prepares and publishes Instagram Reels that are due.
 * Called every 5 minutes by .github/workflows/social-tick.yml. Public path (no sign-in), so the secret is the lock.
 * Answers with counts only: the GitHub job log is public.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET?.trim() ?? '';
  if (secret.length < 24) return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503 });
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got), b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try { return NextResponse.json(await tick()); }
  catch { return NextResponse.json({ error: 'FAILED' }, { status: 500 }); }
}
