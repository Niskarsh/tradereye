import { NextResponse } from 'next/server';
import { ownerGuard } from '@/lib/live/guard';
import { istNow, loadModelOf, loadSettings, loadState, recordList } from '@/lib/algoLive/engine';
import { liveStore } from '@/lib/algoLive/store';
import { activeOf } from '@/lib/algoLive/active';
import { protectLevels } from '@/lib/algoLive/levels';

export const dynamic = 'force-dynamic';

/**
 * The day so far (list, vetoes, closes scored, orders, log), the model in use (without its trees or gate history), and a
 * line on each model (narrow, wide) so the page can show what a switch would trade.
 */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  const { date } = istNow();
  const fresh = new URL(req.url).searchParams.has('fresh');
  let state, model, settings, narrow, wide;
  try {
    [state, settings, narrow, wide] = await Promise.all([loadState(liveStore, date), loadSettings(liveStore), loadModelOf(liveStore, 'narrow', fresh), loadModelOf(liveStore, 'wide', fresh)]);
    model = settings.version === 'wide' ? wide : narrow;
  }
  catch (e) { return NextResponse.json({ error: 'S3', message: `Could not read Algo Live's files in S3: ${(e as Error).message}` }, { status: 502 }); }
  const m = model ? (({ models, parity, gate, ...rest }) => ({ ...rest, trees: models.reduce((a, x) => a + x.trees.length, 0), parityWorst: parity?.worst ?? null, active: activeOf(rest), gated: !!gate }))(model) : null;
  const line = (x: typeof narrow) => (x ? { month: x.month, iteration: activeOf(x).iteration, name: activeOf(x).name, standAside: x.standAside, threshold: x.threshold, valTrades: x.valTrades, valR: x.valR } : null);
  const levels = Object.fromEntries(state.orders.map((o) => [o.correlationId, protectLevels(o, state.list.find((x) => x.symbol === o.symbol)?.avgVol)]));
  return NextResponse.json({ now: Date.now(), date, state, levels, record: recordList(state.list), model: m, settings, versions: { narrow: line(narrow), wide: line(wide) }, scaler: !!(process.env.TRADING_SCALER_URL && process.env.TE_SHARED_SECRET) });
}
