import { NextResponse } from 'next/server';
import { ownerGuard } from '@/lib/live/guard';
import { DispatchError, dispatchWorkflow, latestWorkflowRun } from '@/lib/setups/github';
import { getChunk, putChunk } from '@/lib/book/s3';
import { STATUS_KEY, getJson, type RunStatus } from '@/lib/setups/store';

export const dynamic = 'force-dynamic';

/** the GitHub workflow that trains this month's Algo Live model (.github/workflows/algo-live-model.yml) */
const MODEL_WORKFLOW = 'algo-live-model.yml';

const fail = (e: unknown) => NextResponse.json({ error: e instanceof DispatchError ? e.code : 'FAILED', message: (e as Error).message }, { status: 502 });

/** GET -> the newest "Algo Live model" run (status, conclusion, link), or null if it never ran from a dispatch. */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try { return NextResponse.json({ run: await latestWorkflowRun(MODEL_WORKFLOW) }); }
  catch (e) { return fail(e); }
}

/**
 * POST -> starts the "Algo Live model" workflow for this month, from the latest backtest run that still has its dataset
 * (the workflow's own defaults: both inputs empty). Refused while a run is already queued or running.
 */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    // the model learns from the newest finished backtest: one still running would leave it the older dataset
    const bt = await getJson<RunStatus>({ get: getChunk, put: putChunk }, STATUS_KEY).catch(() => undefined);
    if (bt && bt.state !== 'done' && bt.state !== 'failed') return NextResponse.json({ error: 'BACKTEST_RUNNING', message: 'The backtest is still running: make the model once it is done.' }, { status: 409 });
    const last = await latestWorkflowRun(MODEL_WORKFLOW);
    if (last && last.status !== 'completed') return NextResponse.json({ error: 'BUSY', message: 'A model run is already going: wait for it to finish.', run: last }, { status: 409 });
    await dispatchWorkflow(MODEL_WORKFLOW, {}, 'the Algo Live model workflow');
    return NextResponse.json({ ok: true, startedAt: Date.now() });
  } catch (e) { return fail(e); }
}
