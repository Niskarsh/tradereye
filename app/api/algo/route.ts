import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { INDEX_KEY, RUN_ID, getJson, mlKey, type RunIndexItem } from '@/lib/setups/store';

export const dynamic = 'force-dynamic';

const store = { get: getChunk, put: putChunk };

/** GET ?run=<id> -> the Algo Lab results of that run (default: the latest run that has them). */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const want = new URL(req.url).searchParams.get('run');
    const runs = (await getJson<RunIndexItem[]>(store, INDEX_KEY)) ?? [];
    const order = want && RUN_ID.test(want) ? [want] : runs.map((r) => r.runId).slice(0, 6);
    for (const id of order) {
      const ml = await getJson<unknown>(store, mlKey(id));
      if (ml) return NextResponse.json({ ml });
    }
    return NextResponse.json({ ml: null });
  } catch (e) { return errorResponse(e); }
}
