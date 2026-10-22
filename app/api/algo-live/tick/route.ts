import { NextResponse } from 'next/server';
import { errorResponse, guard } from '@/lib/live/guard';
import {
  counts, istNow, loadModel, loadState, MAX_LATE_MIN, note, orderFor, pick, reconcile, saveState, scoreAt, SHORTLIST_SLOT, slotTime, toScaler,
  type OrderRec, type TickLog,
} from '@/lib/algoLive/engine';
import { scaler, ScalerError, type ScalerStatus } from '@/lib/algoLive/scaler';
import { liveStore } from '@/lib/algoLive/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * One 10-minute close: { slot } (minutes since 09:15: 10 = the 09:25 shortlist, 20..100 = 09:35..10:55).
 * Scores every stock on the day list; at a trading close, if armed and on time, sends the picks to trading-scaler.
 */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => ({}))) as { slot?: number };
  const k = Number(body.slot);
  const now = istNow();
  try {
    const model = await loadModel(liveStore);
    if (!model) return NextResponse.json({ error: 'NO_MODEL', message: 'No live model in S3 yet: run the "Algo Live model" workflow on GitHub.' }, { status: 409 });
    const trading = k >= model.rules.firstSlot && k <= model.rules.lastSlot && k % 10 === 0;
    if (!(k === SHORTLIST_SLOT || trading)) return NextResponse.json({ error: 'BAD_SLOT', message: `No decision at slot ${k}.` }, { status: 400 });
    const closeMin = 555 + k;
    if (now.min < closeMin) return NextResponse.json({ error: 'TOO_EARLY', message: `The ${slotTime(k)} candle has not closed yet.` }, { status: 425 });
    if (model.month !== now.date.slice(0, 7)) return NextResponse.json({ error: 'OLD_MODEL', message: `The live model is for ${model.month}; this is ${now.date.slice(0, 7)}. Re-run the backtest and the "Algo Live model" workflow.` }, { status: 409 });
    const first = await loadState(liveStore, now.date);
    if (!first.list.length) return NextResponse.json({ error: 'NO_LIST', message: 'Make the day list first.' }, { status: 409 });

    const res = await scoreAt(g.dhan, liveStore, model, now.date, first.list, k);
    // the state again (a veto or the arm switch may have changed while the candles were fetched)
    const s = await loadState(liveStore, now.date);
    s.model = { month: model.month, threshold: model.threshold, standAside: model.standAside, createdAt: model.createdAt };
    let st: ScalerStatus | null = null;
    if (trading) {
      try { st = await scaler.status(g.token); reconcile(s, st); } catch (e) { note(s, `${slotTime(k)}: could not read the orders from trading-scaler (${(e as Error).message})`); }
    }
    const picks = trading ? pick(model, s, res.scored, k) : [];
    const late = istNow().min - closeMin;
    let msg: string;
    if (!trading) msg = `shortlist: ${res.scored.filter((x) => x.above).length} above the bar at ${slotTime(k)}`;
    else if (model.standAside) msg = 'standing aside this month (no bar made money on the 3 months before)';
    else if (!picks.length) msg = s.orders.filter(counts).length >= model.rules.cap ? `the day's ${model.rules.cap} trades are taken` : 'nothing cleared the bar';
    else if (!s.armed) msg = `NOT ARMED: would have shorted ${picks.map((x) => x.symbol).join(', ')}`;
    else if (late > MAX_LATE_MIN) msg = `too late (${late} min after the close): not sending ${picks.map((x) => x.symbol).join(', ')}`;
    else msg = `shorting ${picks.map((x) => x.symbol).join(', ')}`;
    const log: TickLog = { slot: k, at: Date.now(), scored: res.scored, picked: picks.map((x) => x.symbol), note: msg, missing: res.missing };
    s.ticks[String(k)] = log;
    note(s, `${slotTime(k)}: ${msg}${res.missing.length ? ` (no data for ${res.missing.length})` : ''}`);

    if (trading && picks.length && s.armed && !model.standAside && late <= MAX_LATE_MIN) {
      const recs: OrderRec[] = picks.map((x) => ({ ...orderFor(model, x, now.date, k, s.list.find((l) => l.symbol === x.symbol)!.securityId), sentAt: Date.now(), status: 'SENDING' }));
      s.orders.push(...recs);
      await saveState(liveStore, s); // written before sending: a second tab never sends the same stock again
      try {
        const r = await scaler.place(g.token, recs.map(toScaler));
        for (const o of recs) {
          const p = r.placed.find((x) => x.correlationId === o.correlationId);
          o.orderId = p?.orderId; o.status = p?.error ? 'REJECTED' : (p?.orderStatus ?? 'UNKNOWN'); o.error = p?.error;
          note(s, `${o.symbol}: short ${o.qty} at market, stop ${o.stop}, target ${o.target} -> ${o.status}${o.error ? ` (${o.error})` : ''}`);
        }
      } catch (e) {
        // unknown whether Dhan got it: trading-scaler refuses the same order id twice, and the next status read settles it
        for (const o of recs) { o.status = 'UNKNOWN'; o.error = (e as Error).message; }
        note(s, `sending failed: ${(e as Error).message}`);
      }
    }
    await saveState(liveStore, s);
    return NextResponse.json({ tick: log, orders: s.orders, armed: s.armed });
  } catch (e) {
    if (e instanceof ScalerError) return NextResponse.json({ error: 'SCALER', message: e.message }, { status: 502 });
    return errorResponse(e);
  }
}
