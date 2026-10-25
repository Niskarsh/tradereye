import { NextResponse } from 'next/server';
import { cronCheck } from '@/lib/auth/cron';
import { collect } from '@/lib/medium/collect';
import { mediumStore } from '@/lib/medium/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST (Authorization: Bearer CRON_SECRET) -> one Medium trend radar run: reads the RSS feeds in lib/medium/collect.ts
 * and saves what it saw to S3. Called by the Lambda tradereye-medium-collector (infra/medium-collector) every few hours
 * via EventBridge Scheduler. Public path (no sign-in), so the secret is the lock. Answers with counts only.
 */
export async function POST(req: Request) {
  const c = cronCheck(req);
  if (c === 'unset') return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503 });
  if (c === 'denied') return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const run = await collect(mediumStore);
    const failed = run.feeds.filter((f) => f.error).length;
    // every feed failing = something is wrong (Medium blocking, S3 fine): fail so the Lambda shows an error
    if (failed === run.feeds.length) return NextResponse.json({ error: 'ALL_FEEDS_FAILED', feeds: run.feeds }, { status: 502 });
    return NextResponse.json({ newPosts: run.newPosts, totalPosts: run.totalPosts, failedFeeds: failed, fullFeeds: run.feeds.filter((f) => f.full).length });
  } catch { return NextResponse.json({ error: 'FAILED' }, { status: 500 }); }
}
