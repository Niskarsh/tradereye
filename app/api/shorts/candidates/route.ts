import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { chartInfo, mysteryCandidates, season } from '@/lib/shorts/source';
import { mysteryCutoff, scoreR, type ShortTrade } from '@/lib/shorts/trades';
import { dateLabel } from '@/lib/shorts/spec';
import { drifted, loadLedger, mergedWeeks } from '@/lib/shorts/season';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET ?kind=mystery -> his trades old enough to show with the ticker (over 3 months, SEBI), newest first.
 * GET ?kind=vs      -> every finished week since Algo Live started: both sides' R (frozen weeks as frozen, see
 *                     lib/shorts/season.ts), the trade that decided each side.
 */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const kind = new URL(req.url).searchParams.get('kind');
    if (kind === 'mystery') return NextResponse.json({ cutoff: mysteryCutoff(), trades: await mysteryCandidates() });
    if (kind === 'vs') {
      const [s, ledger] = await Promise.all([season(), loadLedger()]);
      const shown = new Map(mergedWeeks(ledger, s.weeks).map((w) => [w.week, w]));
      const brief = (t?: ShortTrade & { orderRisk?: number }) =>
        t ? { symbol: t.symbol, date: t.date, dir: t.dir, r: scoreR(t), chart: chartInfo(t) } : undefined;
      return NextResponse.json({
        // a frozen week shows its frozen numbers (what viewers saw); `drift` = today's data would score it differently
        weeks: s.weeks.map((w) => {
          const f = ledger.weeks[w.week], v = shown.get(w.week) ?? w;
          return {
            week: w.week, label: `Week of ${dateLabel(w.week)}`, me: v.me, algo: v.algo, winner: v.winner,
            frozenAt: f?.frozenAt, rescoredAt: f?.rescoredAt, drift: drifted(f, w), now: f && drifted(f, w) ? { me: w.me, algo: w.algo, winner: w.winner } : undefined,
            meTrade: brief(w.meTrade), algoTrade: brief(w.algoTrade),
          };
        }).reverse(),
      });
    }
    return NextResponse.json({ error: 'BAD_REQUEST', message: 'kind must be mystery or vs' }, { status: 400 });
  } catch (e) { return errorResponse(e); }
}
