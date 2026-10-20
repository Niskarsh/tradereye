import { NextResponse } from 'next/server';
import { errorResponse, guard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { DispatchError, dispatchBacktest } from '@/lib/setups/github';
import { STATUS_KEY, getJson, isActive, pendingKey, putJson, type RunStatus } from '@/lib/setups/store';
import { istDateTime } from '@/lib/live/time';

export const dynamic = 'force-dynamic';

const store = { get: getChunk, put: putChunk };

/**
 * POST (Dhan token in the header) -> starts a backtest run on GitHub Actions. The token is left in S3 under the run
 * id for the job to pick up (a workflow input would show in the public log), and the job overwrites it on reading.
 */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    const cur = await getJson<RunStatus>(store, STATUS_KEY);
    if (isActive(cur)) return NextResponse.json({ error: 'RUNNING', message: 'A run is already going. It shows here when it finishes.', status: cur }, { status: 409 });
    const runId = `${istDateTime(Date.now()).replace(/[: ]/g, '-').slice(0, 16)}-${Math.random().toString(36).slice(2, 6)}`;
    await putJson(store, pendingKey(runId), { token: g.token, at: Date.now() });
    try { await dispatchBacktest(runId); }
    catch (e) {
      await putJson(store, pendingKey(runId), { used: true, at: Date.now() }).catch(() => {});
      if (e instanceof DispatchError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'FAILED' ? 502 : 400 });
      throw e;
    }
    const status: RunStatus = { runId, state: 'queued', phase: 'Waiting for GitHub to start the job', startedAt: Date.now(), updatedAt: Date.now() };
    await putJson(store, STATUS_KEY, status);
    return NextResponse.json({ status });
  } catch (e) { return errorResponse(e); }
}
