import { NextResponse } from 'next/server';
import { ownerGuard } from '@/lib/live/guard';
import { toRow } from '@/lib/socialAnalysis/analyze';
import { loadMetrics } from '@/lib/socialAnalysis/collect';
import { makeRead } from '@/lib/socialAnalysis/read';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** POST -> one Claude read of the saved numbers (on demand only: every press is one paid call). */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const now = Date.now();
    const file = await loadMetrics();
    return NextResponse.json({ read: await makeRead(Object.values(file.posts).map((p) => toRow(p, now))) });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Nothing is 7 days')) return NextResponse.json({ error: 'TOO_EARLY', message: e.message }, { status: 400 });
    return NextResponse.json({ error: 'FAILED', message: (e as Error).message }, { status: 500 });
  }
}
