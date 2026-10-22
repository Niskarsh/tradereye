import { NextResponse } from 'next/server';
import { ownerGuard } from '@/lib/live/guard';
import { istNow, loadModel, loadSettings, loadState, recordList } from '@/lib/algoLive/engine';
import { liveStore } from '@/lib/algoLive/store';

export const dynamic = 'force-dynamic';

/** The day so far (list, vetoes, closes scored, orders, log) and the model in use (without its trees). */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  const { date } = istNow();
  let state, model, settings;
  try { [state, model, settings] = await Promise.all([loadState(liveStore, date), loadModel(liveStore), loadSettings(liveStore)]); }
  catch (e) { return NextResponse.json({ error: 'S3', message: `Could not read Algo Live's files in S3: ${(e as Error).message}` }, { status: 502 }); }
  const m = model ? (({ models, parity, ...rest }) => ({ ...rest, trees: models.reduce((a, x) => a + x.trees.length, 0), parityWorst: parity?.worst ?? null }))(model) : null;
  return NextResponse.json({ now: Date.now(), date, state, record: recordList(state.list), model: m, settings, scaler: !!(process.env.TRADING_SCALER_URL && process.env.TE_SHARED_SECRET) });
}
