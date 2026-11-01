import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { getSheetsClient } from '@/lib/sheetsApi';
import { istDateKey } from '@/lib/live/time';
import { liveStore } from '@/lib/algoLive/store';
import { loadModel, loadState } from '@/lib/algoLive/engine';
import { LIVE_FROM, liveFills, tradingDays, type FillRow } from '@/lib/algoLive/fills';
import { reconcile, type BtTrade } from '@/lib/algoLive/reconcile';
import { newestWithStrategy } from '@/lib/ml/find';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const store = { get: getChunk, put: putChunk };

/**
 * GET -> backtest vs live, day by day since Algo Live started (read only; lib/algoLive/reconcile.ts): the live
 * strategy's trades in the newest Algo Lab run next to Algo Live's orders, with the reason for every mismatch.
 */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const model = await loadModel(liveStore).catch(() => undefined);
    const strategy = model?.strategy ?? 'fCap2';
    const found = await newestWithStrategy(store, strategy);
    if (!found) return NextResponse.json({ result: null, message: 'No Algo Lab run has the live strategy yet.' });
    const cols: string[] = found.st.tradeCols ?? [];
    if (!(cols[0] === 'day' && cols[1] === 'sym' && cols[2] === 'time' && cols[6] === 'gross')) {
      return NextResponse.json({ result: null, message: 'This Algo Lab run keeps its trades in an older layout.' });
    }
    const dataTo: string = found.ml.period?.to ?? '';
    const today = istDateKey(Date.now());
    const dates = tradingDays(LIVE_FROM, today);
    const bt = ((found.st.trades ?? []) as BtTrade[]).filter((x) => x[0] >= LIVE_FROM);
    const [states, fills] = await Promise.all([
      Promise.all(dates.map((d) => loadState(liveStore, d).catch(() => undefined))),
      liveFills(liveStore, getSheetsClient(), today).then((x) => x.rows).catch(() => [] as FillRow[]),
    ]);
    const result = reconcile(dates, states, bt, dataTo, fills);
    return NextResponse.json({ result: { ...result, dataTo, run: { runId: found.ml.runId, iteration: found.ml.iteration } } });
  } catch (e) { return errorResponse(e); }
}
