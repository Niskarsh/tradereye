import { NextResponse } from 'next/server';
import { errorResponse, guard, ownerGuard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { DispatchError, dispatchWorkflow } from '@/lib/setups/github';
import { STATUS_KEY, getJson, isActive, pendingKey, putJson, type RunStatus } from '@/lib/setups/store';
import { istDateTime } from '@/lib/live/time';
import { WIDE_STATUS_KEY } from '@/lib/ml/wideJob';
import { inLiveWindow } from '@/lib/ml/wide';

export const dynamic = 'force-dynamic';

const store = { get: getChunk, put: putChunk };
const WORKFLOW = 'algo-lab-wide.yml';

/** GET -> where Algo Lab's wide-universe run stands */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const status = (await getJson<RunStatus>(store, WIDE_STATUS_KEY)) ?? null;
    return NextResponse.json({ status, active: isActive(status ?? undefined) });
  } catch (e) { return errorResponse(e); }
}

/**
 * POST (Dhan token in the header) -> starts it on GitHub Actions. The token waits in S3 under the run id for the job, which
 * overwrites it on reading. Refused while Algo Live needs Dhan's request limit, and while a backtest is running (both
 * share that limit).
 */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    if (inLiveWindow(Date.now())) return NextResponse.json({ error: 'LIVE_WINDOW', message: 'Not between 08:40 and 11:15 on a weekday: Algo Live needs Dhan\'s request limit then.' }, { status: 409 });
    const [cur, bt] = await Promise.all([getJson<RunStatus>(store, WIDE_STATUS_KEY), getJson<RunStatus>(store, STATUS_KEY)]);
    if (isActive(cur)) return NextResponse.json({ error: 'RUNNING', message: 'This run is already going.', status: cur }, { status: 409 });
    if (isActive(bt)) return NextResponse.json({ error: 'BACKTEST_RUNNING', message: 'The backtest is running and shares Dhan\'s request limit: start this once it is done.' }, { status: 409 });
    const runId = `${istDateTime(Date.now()).replace(/[: ]/g, '-').slice(0, 16)}-${Math.random().toString(36).slice(2, 6)}`;
    await putJson(store, pendingKey(runId), { token: g.token, at: Date.now() });
    try { await dispatchWorkflow(WORKFLOW, { run_id: runId }, 'the wide-universe run'); }
    catch (e) {
      await putJson(store, pendingKey(runId), { used: true, at: Date.now() }).catch(() => {});
      if (e instanceof DispatchError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'FAILED' ? 502 : 400 });
      throw e;
    }
    const status: RunStatus = { runId, state: 'queued', phase: 'Waiting for GitHub to start the job', startedAt: Date.now(), updatedAt: Date.now() };
    await putJson(store, WIDE_STATUS_KEY, status);
    return NextResponse.json({ status, active: true });
  } catch (e) { return errorResponse(e); }
}
