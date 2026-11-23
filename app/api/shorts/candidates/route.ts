import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { botCandidates, chartInfo, mysteryCandidates, season } from '@/lib/shorts/source';
import { botRef } from '@/lib/shorts/bot';
import { scoreR, type ShortTrade } from '@/lib/shorts/trades';
import { dateLabel } from '@/lib/shorts/spec';
import { drifted, loadLedger, mergedWeeks } from '@/lib/shorts/season';
import { listShorts } from '@/lib/shorts/store';
import { loadPosts } from '@/lib/shorts/publish';
import { usedBy } from '@/lib/shorts/used';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET ?kind=mystery -> his trades with a real stop in the journal, newest first (any age).
 * GET ?kind=bot     -> every closed Algo Live trade, newest first: what the bot proposed, what he did, what untouched did.
 * Every kind carries `used` when a short was already made from that trade / week (lib/shorts/used.ts).
 * GET ?kind=vs      -> every finished week since Algo Live started: both sides' R (frozen weeks as frozen, see
 *                     lib/shorts/season.ts), the trade that decided each side.
 */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const kind = new URL(req.url).searchParams.get('kind');
    if (kind !== 'mystery' && kind !== 'vs' && kind !== 'bot') return NextResponse.json({ error: 'BAD_REQUEST', message: 'kind must be mystery, vs or bot' }, { status: 400 });
    const [items, posts] = await Promise.all([listShorts(), loadPosts()]);
    if (kind === 'bot') {
      const rows = await botCandidates(g.dhan);
      return NextResponse.json({
        trades: rows.map((r) => ({
          ref: botRef(r), date: r.date, symbol: r.symbol, time: r.time, entry: r.entry, stop: r.stop, target: r.target,
          myInr: r.myInr, myHow: r.myHow, myTime: r.myTime, planInr: r.planInr, planOutcome: r.planOutcome, diffInr: r.diffInr, steppedIn: r.steppedIn, note: r.note,
          used: usedBy(items, posts, 'bot', botRef(r), ''),
        })),
      });
    }
    if (kind === 'mystery') {
      const trades = await mysteryCandidates();
      return NextResponse.json({ trades: trades.map((t) => ({ ...t, used: usedBy(items, posts, 'mystery', t.id, `Mystery: ${t.symbol} · ${dateLabel(t.date)}`) })) });
    }
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
          used: usedBy(items, posts, 'vs', w.week, `Me vs Algo · Week of ${dateLabel(w.week)}`),
        };
      }).reverse(),
    });
  } catch (e) { return errorResponse(e); }
}
