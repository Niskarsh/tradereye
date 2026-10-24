import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { season } from '@/lib/shorts/source';
import { loadLedger, rescore, saveLedger } from '@/lib/shorts/season';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST { week } -> re-scores one frozen Me vs Algo week from today's journal / Algo Live data (a deliberate correction).
 * The previous result is kept in that week's history; later shorts show the corrected season.
 */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const { week } = await req.json().catch(() => ({})) as { week?: string };
    if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Which week?' }, { status: 400 });
    const [s, ledger] = await Promise.all([season(), loadLedger()]);
    const now = s.weeks.find((w) => w.week === week);
    if (!now) return NextResponse.json({ error: 'BAD_REQUEST', message: 'That week is not finished yet, or is before Algo Live started.' }, { status: 400 });
    if (!ledger.weeks[week]) return NextResponse.json({ error: 'BAD_REQUEST', message: 'That week is not frozen yet: it freezes when its first short is made.' }, { status: 400 });
    const next = rescore(ledger, { week, me: now.me, algo: now.algo, winner: now.winner });
    await saveLedger(next);
    return NextResponse.json({ week: next.weeks[week] });
  } catch (e) { return errorResponse(e); }
}
