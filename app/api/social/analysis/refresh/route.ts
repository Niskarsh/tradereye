import { NextResponse } from 'next/server';
import { ownerGuard } from '@/lib/live/guard';
import { pullMetrics } from '@/lib/socialAnalysis/collect';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** POST -> pull today's numbers now (the same pull the daily timer runs). Costs no Claude call. */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const r = await pullMetrics('manual');
    return NextResponse.json({ pulled: r.pulled, failed: r.failed, problems: r.lastRun?.problems ?? [] });
  } catch (e) { return NextResponse.json({ error: 'FAILED', message: (e as Error).message }, { status: 500 }); }
}
