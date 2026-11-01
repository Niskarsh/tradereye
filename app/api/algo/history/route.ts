import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk, listKeys, putChunk } from '@/lib/book/s3';
import { getJson } from '@/lib/setups/store';
import { newestWithStrategy } from '@/lib/ml/find';
import { loadModel } from '@/lib/algoLive/engine';
import { liveStore } from '@/lib/algoLive/store';
import { activeOf } from '@/lib/algoLive/active';
import type { LiveModel } from '@/lib/algoLive/model';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const store = { get: getChunk, put: putChunk };
type AnyMl = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** one month as the walk-forward ran it for the live strategy (scripts/ml_walkforward.py, a strategy's `months`) */
interface BtMonth {
  month: string; thr: number | null; note: string; n: number; netR: number; sumR: number; hit: number; exam: boolean; shadow?: boolean;
  train?: [string, string]; val?: [string, string]; valN?: number; valR?: number | null; valSum?: number; facts?: [string, number][] | null; shares?: Record<string, number> | null;
}

/**
 * GET -> Model history: month by month, the model behind the live strategy.
 *   backtest: every month the walk-forward traded for that strategy (newest Algo Lab run that has it): its bar, how the bar
 *             did on its 3 bar months, how the month itself went, and (runs from Nov 2026 on) the facts its models leaned on
 *   live:     every model Algo Live has traded (setups/live/models/, the newest per month): its windows, bar, bar-month
 *             result and (from Nov 2026) its facts
 */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const current = await loadModel(liveStore).catch(() => undefined);
    const active = current ? activeOf(current) : null;
    const strategy = current?.strategy ?? 'fCap2';

    const found = await newestWithStrategy(store, strategy);
    const ml = found?.ml, st = found?.st;
    const months: BtMonth[] = (st?.months ?? []).map((m: AnyMl) => ({
      month: m.month, thr: m.thr, note: m.note, n: m.n, netR: m.netR, sumR: m.sumR, hit: m.hit, exam: !!m.exam, shadow: !!m.shadow,
      train: m.train, val: m.val, valN: m.valN, valR: m.valR, valSum: m.valSum, facts: m.facts ?? null, shares: m.shares ?? null,
    }));

    // every live model kept (one per month: the newest)
    let live: AnyMl[] = [], liveError: string | null = null;
    try {
      const keys = (await listKeys('setups/live/models/')).filter((k) => /\/\d{4}-\d{2}-\d+\.json\.gz$/.test(k));
      const newest = new Map<string, { key: string; run: number }>();
      for (const k of keys) {
        const [, month, run] = k.match(/\/(\d{4}-\d{2})-(\d+)\.json\.gz$/)!;
        const was = newest.get(month);
        if (!was || Number(run) > was.run) newest.set(month, { key: k, run: Number(run) });
      }
      const picked = [...newest.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 24);
      live = (await Promise.all(picked.map(async ([, x]) => {
        const m = await getJson<LiveModel>(liveStore, x.key).catch(() => undefined);
        if (!m) return null;
        const a = activeOf(m);
        return {
          month: m.month, iteration: a.iteration, name: a.name, createdAt: m.createdAt, runAt: a.runAt, dataTo: m.dataTo ?? null,
          train: m.train, val: m.val, threshold: m.threshold, standAside: m.standAside, valTrades: m.valTrades, valR: m.valR, valDays: m.valDays,
          trees: m.models.reduce((s, x) => s + x.trees.length, 0), factCount: m.features.length, facts: m.facts ?? null, shares: m.shares ?? null, factLabels: m.factLabels ?? null,
          inUse: !!current && current.month === m.month && current.createdAt === m.createdAt,
        };
      }))).filter((x) => !!x) as AnyMl[];
    } catch (e) { liveError = (e as Error).message; }

    return NextResponse.json({
      active, strategy,
      source: ml ? { runId: ml.runId, iteration: ml.iteration, createdAt: ml.createdAt, name: st?.name } : null,
      labels: ml?.factLabels ?? {}, months, live, liveError,
    });
  } catch (e) { return errorResponse(e); }
}
