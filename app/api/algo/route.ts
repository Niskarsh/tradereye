import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { INDEX_KEY, RUN_ID, getJson, mlKey, type RunIndexItem } from '@/lib/setups/store';

export const dynamic = 'force-dynamic';

const store = { get: getChunk, put: putChunk };

/** the headline numbers of one strategy, for the "iterations so far" table */
interface Line { id: string; name: string; n: number; netR: number; gross: number | null; t: number; monthsGreen: number; monthsTraded: number; dev: number | null; exam: number | null; ic: number | null }
interface Head { runId: string; createdAt: number; iteration: number; lines: Line[] }

type AnyMl = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function headOf(ml: AnyMl): Head {
  if (ml.v === 1) {
    const o = ml.overall ?? {};
    return { runId: ml.runId, createdAt: ml.createdAt, iteration: 1, lines: [{ id: 'tight', name: 'Tight bracket (1 ATR stop, 1.5 ATR target)', n: o.n, netR: o.netR, gross: o.gross ?? null, t: o.t, monthsGreen: o.monthsGreen, monthsTraded: o.monthsTraded, dev: null, exam: null, ic: null }] };
  }
  return {
    runId: ml.runId, createdAt: ml.createdAt, iteration: ml.iteration ?? 2,
    lines: (ml.strategies ?? []).map((s: AnyMl) => ({ id: s.id, name: s.name, n: s.overall.n, netR: s.overall.netR, gross: s.overall.gross, t: s.overall.t, monthsGreen: s.overall.monthsGreen, monthsTraded: s.overall.monthsTraded, dev: s.dev?.n ? s.dev.netR : null, exam: s.exam?.n ? s.exam.netR : null, ic: s.ic?.mean ?? null })),
  };
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
    return NextResponse.json({ ml: ml ?? null, history: found.map((x) => headOf(x.ml)) });
  } catch (e) { return errorResponse(e); }
}
