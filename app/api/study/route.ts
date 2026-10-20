import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { INDEX_KEY, RUN_ID, getJson, studyKey, type RunIndexItem } from '@/lib/setups/store';
import type { Study } from '@/lib/study/analyze';

export const dynamic = 'force-dynamic';

const store = { get: getChunk, put: putChunk };

/** GET ?run=<id> -> the reversal study of that run (default: the latest run that has one), and the list of runs. */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const want = new URL(req.url).searchParams.get('run');
    const runs = (await getJson<RunIndexItem[]>(store, INDEX_KEY)) ?? [];
    const order = want && RUN_ID.test(want) ? [want, ...runs.map((r) => r.runId).filter((x) => x !== want)] : runs.map((r) => r.runId);
    for (const id of order.slice(0, 6)) {
      const study = await getJson<Study>(store, studyKey(id));
      if (study) return NextResponse.json({ runs, study });
    }
    return NextResponse.json({ runs, study: null });
  } catch (e) { return errorResponse(e); }
}
