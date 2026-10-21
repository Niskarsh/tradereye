import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { INDEX_KEY, ML_LEDGER_KEY, RUN_ID, getJson, mlKey, type RunIndexItem } from '@/lib/setups/store';
import { ledgerEntry, type LedgerEntry, type MlResult } from '@/lib/ml/ledger';

export const dynamic = 'force-dynamic';

const store = { get: getChunk, put: putChunk };

/** the headline numbers of one strategy, for the "iterations so far" table */
interface Line { id: string; name: string; n: number; netR: number; gross: number | null; t: number; monthsGreen: number; monthsTraded: number; dev: number | null; exam: number | null; ic: number | null }
interface Head { runId: string; createdAt: number; iteration: number; code?: string | null; lines: Line[] }

type AnyMl = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function headOf(ml: AnyMl): Head {
  if (ml.v === 1) {
    const o = ml.overall ?? {};
    return { runId: ml.runId, createdAt: ml.createdAt, iteration: 1, lines: [{ id: 'tight', name: 'Tight bracket (1 ATR stop, 1.5 ATR target)', n: o.n, netR: o.netR, gross: o.gross ?? null, t: o.t, monthsGreen: o.monthsGreen, monthsTraded: o.monthsTraded, dev: null, exam: null, ic: null }] };
  }
  const e = ledgerEntry({ ...(ml as MlResult), iteration: ml.iteration ?? 2 });
  return { runId: e.runId, createdAt: e.createdAt, iteration: e.iteration, code: e.code, lines: e.lines };
}

/** the page does not need every trade (they stay in S3 with the iteration) */
function slim(ml: AnyMl | undefined) {
  if (!ml) return null;
  return { ...ml, strategies: (ml.strategies ?? []).map(({ trades: _t, tradeCols: _c, ...s }: AnyMl) => s) }; // eslint-disable-line @typescript-eslint/no-unused-vars
}

/** GET ?run=<id> -> the Algo Lab results of that run (default: the latest run that has them), and every earlier iteration's headline. */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const want = new URL(req.url).searchParams.get('run');
    const runs = (await getJson<RunIndexItem[]>(store, INDEX_KEY)) ?? [];
    const ids = runs.map((r) => r.runId).slice(0, 15);
    const all = await Promise.all(ids.map((id) => getJson<AnyMl>(store, mlKey(id)).catch(() => undefined)));
    const found = ids.map((id, i) => ({ id, ml: all[i] })).filter((x): x is { id: string; ml: AnyMl } => !!x.ml);
    let ml: AnyMl | undefined = found[0]?.ml;
    if (want && RUN_ID.test(want)) ml = found.find((x) => x.id === want)?.ml ?? (await getJson<AnyMl>(store, mlKey(want)));
    // every iteration from 5 on comes from the ledger (kept for good); older ones from the recent runs
    const ledger = (await getJson<LedgerEntry[]>(store, ML_LEDGER_KEY)) ?? [];
    const kept = new Set(ledger.map((e) => e.runId));
    const history: Head[] = [
      ...ledger.map((e) => ({ runId: e.runId, createdAt: e.createdAt, iteration: e.iteration, code: e.code, lines: e.lines })),
      ...found.filter((x) => !kept.has(x.id)).map((x) => headOf(x.ml)),
    ].sort((a, b) => b.createdAt - a.createdAt);
    return NextResponse.json({ ml: slim(ml), history });
  } catch (e) { return errorResponse(e); }
}
