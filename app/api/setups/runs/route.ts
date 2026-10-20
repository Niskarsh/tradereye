import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { INDEX_KEY, RUN_ID, STATUS_KEY, getJson, isActive, summaryKey, type RunIndexItem, type RunStatus } from '@/lib/setups/store';
import type { Summary } from '@/lib/setups/stats';

export const dynamic = 'force-dynamic';

const store = { get: getChunk, put: putChunk };

/**
 * GET ?run=<id> -> { status, runs, summary (that run, or the latest), previous (the run before it) }.
 * GET ?status=1 -> { status } only (the page polls this while a run is going).
 */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const url = new URL(req.url);
    const status = await getJson<RunStatus>(store, STATUS_KEY);
    const st = status ? { ...status, stale: (status.state === 'queued' || status.state === 'running') && !isActive(status) } : null;
    if (url.searchParams.get('status')) return NextResponse.json({ status: st });
    const runs = (await getJson<RunIndexItem[]>(store, INDEX_KEY)) ?? [];
    const want = url.searchParams.get('run');
    const i = want && RUN_ID.test(want) ? runs.findIndex((r) => r.runId === want) : 0;
    const pick = runs[i < 0 ? 0 : i];
    const prev = runs[(i < 0 ? 0 : i) + 1];
    const [summary, previous] = await Promise.all([
      pick ? getJson<Summary>(store, summaryKey(pick.runId)) : undefined,
      prev ? getJson<Summary>(store, summaryKey(prev.runId)) : undefined,
    ]);
    const minHit = Number(process.env.SETUPS_ALERT_MIN_HIT ?? 0.6);
    return NextResponse.json({ status: st, runs, summary: summary ?? null, previous: previous ?? null, minHit: Number.isFinite(minHit) ? minHit : 0.6 });
  } catch (e) { return errorResponse(e); }
}
