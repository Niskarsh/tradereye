import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { mysteryCandidates, season } from '@/lib/shorts/source';
import { mysteryCutoff, scoreR, type ShortTrade } from '@/lib/shorts/trades';
import { dateLabel } from '@/lib/shorts/spec';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET ?kind=mystery -> his trades old enough to show with the ticker (over 3 months, SEBI), newest first.
 * GET ?kind=vs      -> every finished week since Algo Live started: both sides' R, the trade that decided each side.
 */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const kind = new URL(req.url).searchParams.get('kind');
    if (kind === 'mystery') return NextResponse.json({ cutoff: mysteryCutoff(), trades: await mysteryCandidates() });
    if (kind === 'vs') {
      const s = await season();
      const brief = (t?: ShortTrade & { orderRisk?: number }) =>
        t ? { symbol: t.symbol, date: t.date, dir: t.dir, r: scoreR(t) } : undefined;
      return NextResponse.json({
        weeks: s.weeks.map((w) => ({ week: w.week, label: `Week of ${dateLabel(w.week)}`, me: w.me, algo: w.algo, winner: w.winner, meTrade: brief(w.meTrade), algoTrade: brief(w.algoTrade) })).reverse(),
      });
    }
    return NextResponse.json({ error: 'BAD_REQUEST', message: 'kind must be mystery or vs' }, { status: 400 });
  } catch (e) { return errorResponse(e); }
}
