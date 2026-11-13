import { NextResponse } from 'next/server';
import { errorResponse, guard } from '@/lib/live/guard';
import { scaler, ScalerError, type ScalerBook } from '@/lib/algoLive/scaler';
import { tradePlan } from '@/lib/algoLive/levels';
import { istNow, loadState } from '@/lib/algoLive/engine';
import { liveStore } from '@/lib/algoLive/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The Charts page's order buttons, for ONE stock, through trading-scaler (Dhan only takes orders from its fixed IP):
 *   book       its position and working orders (the chart draws them as lines)
 *   flatten    cancel its stop / target / other working orders (waiting until Dhan shows them gone), then close the
 *              position at market
 *   addstop    the position has no stop: a stop-limit at Algo Live's stop for this stock today and a target limit at its
 *              target, as a pair (trading-scaler cancels the other when one fills)
 *   clearall   cancel its working orders (the position stays)
 *   breakeven  move its stop(s) to where an exit pays Dhan's charges and the usual stop slippage (the same "move stop to"
 *              as Algo Live: lib/algoLive/levels.ts), so the trade cannot end red after costs
 *   move       { id, price }: a dragged order line
 *   cancel     { id }: the ✕ on an order line
 * These act on every order of that stock, hand-placed ones included, at once (no confirmation: his call).
 */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  const b = await req.json().catch(() => ({})) as { action?: string; securityId?: string; symbol?: string; id?: string; price?: number };
  const sid = String(b.securityId ?? '');
  if (!/^\d{1,10}$/.test(sid)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Need the stock\'s Dhan security id.' }, { status: 400 });
  try {
    switch (b.action) {
      case 'book': return NextResponse.json({ book: await scaler.book(g.token, sid) });
      case 'flatten': return NextResponse.json(await scaler.flatten(g.token, sid));
      case 'clearall': return NextResponse.json(await scaler.clearAll(g.token, sid));
      case 'move': return NextResponse.json(await scaler.move(g.token, sid, String(b.id ?? ''), Number(b.price)));
      case 'cancel': return NextResponse.json(await scaler.cancel(g.token, sid, String(b.id ?? '')));
      case 'addstop': {
        // Algo Live's stop and target for this stock today (its latest order that has them)
        const state = await loadState(liveStore, istNow().date).catch(() => undefined);
        const o = [...(state?.orders ?? [])].reverse().find((x) => (x.securityId === sid || x.symbol === b.symbol) && x.stop > 0);
        if (!o) return NextResponse.json({ error: 'NO_ALGO_STOP', message: `Algo Live has no stop for ${b.symbol ?? 'this stock'} today.` }, { status: 409 });
        return NextResponse.json({ ...(await scaler.addStop(g.token, sid, o.stop, o.target > 0 ? o.target : undefined)), stop: o.stop, target: o.target });
      }
      case 'breakeven': {
        const bk: ScalerBook = await scaler.book(g.token, sid);
        const p = bk.position;
        if (!p || !p.netQty || !(p.avgPrice > 0)) return NextResponse.json({ error: 'NO_POSITION', message: 'No open position on this stock.', book: bk }, { status: 409 });
        const stops = bk.working.filter((w) => w.role === 'stop');
        if (!stops.length) return NextResponse.json({ error: 'NO_STOP', message: 'There is no stop order to move.', book: bk }, { status: 409 });
        // the stock's usual volume sets the slippage allowance; unknown = the thinnest band (the safest stop)
        const state = await loadState(liveStore, istNow().date).catch(() => undefined);
        const avgVol = state?.list.find((x) => x.securityId === sid || x.symbol === b.symbol)?.avgVol;
        const dir: 1 | -1 = p.netQty > 0 ? 1 : -1;
        const price = tradePlan({ dir, entry: p.avgPrice, qty: Math.abs(p.netQty), avgVol }).moveStop;
        let last = bk;
        for (const s of stops) last = (await scaler.move(g.token, sid, s.id, price)).book;
        return NextResponse.json({ price, book: last });
      }
      default: return NextResponse.json({ error: 'BAD_REQUEST', message: 'Unknown action.' }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof ScalerError) return NextResponse.json({ error: 'SCALER', message: e.message }, { status: 502 });
    return errorResponse(e);
  }
}
