import { NextResponse } from 'next/server';
import { ownerGuard } from '@/lib/live/guard';
import { DispatchError, dispatchWorkflow, latestWorkflowRun } from '@/lib/setups/github';
import { getChunk, putChunk } from '@/lib/book/s3';
import { STATUS_KEY, getJson, type RunStatus } from '@/lib/setups/store';
import { WIDE_STATUS_KEY } from '@/lib/ml/wideJob';
import { loadSettings } from '@/lib/algoLive/engine';
import { liveStore } from '@/lib/algoLive/store';

export const dynamic = 'force-dynamic';

/** the GitHub workflows that train this month's Algo Live model: narrow (algo-live-model.yml) and wide (algo-live-model-wide.yml) */
const WORKFLOW = { narrow: 'algo-live-model.yml', wide: 'algo-live-model-wide.yml' } as const;

const fail = (e: unknown) => NextResponse.json({ error: e instanceof DispatchError ? e.code : 'FAILED', message: (e as Error).message }, { status: 502 });

/** GET -> the newest model run of the model the page is switched to (status, conclusion, link), or null. */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try { const { version } = await loadSettings(liveStore); return NextResponse.json({ run: await latestWorkflowRun(WORKFLOW[version]), version }); }
  catch (e) { return fail(e); }
}

/**
 * POST -> starts the model workflow of the model the page is switched to, for this month, from the latest dataset still kept
 * (the backtest's for narrow, Algo Lab's for wide; the workflow's own defaults: both inputs empty). Refused while a run is
 * already queued or running, or while the dataset it needs is still being built.
 */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const { version } = await loadSettings(liveStore);
    if (version === 'wide') {
      // the wide model learns from the newest Algo Lab dataset: the model jobs may still run, the dataset must be done
      const lab = await getJson<RunStatus>({ get: getChunk, put: putChunk }, WIDE_STATUS_KEY).catch(() => undefined);
      if (lab && lab.state !== 'done' && lab.state !== 'failed' && !/^Training the models/.test(lab.phase ?? '')) return NextResponse.json({ error: 'LAB_RUNNING', message: 'Algo Lab is still building its dataset: make the model once that is done.' }, { status: 409 });
    } else {
      // the model learns from the newest finished backtest: one still running would leave it the older dataset
      const bt = await getJson<RunStatus>({ get: getChunk, put: putChunk }, STATUS_KEY).catch(() => undefined);
      if (bt && bt.state !== 'done' && bt.state !== 'failed') return NextResponse.json({ error: 'BACKTEST_RUNNING', message: 'The backtest is still running: make the model once it is done.' }, { status: 409 });
    }
    const last = await latestWorkflowRun(WORKFLOW[version]);
    if (last && last.status !== 'completed') return NextResponse.json({ error: 'BUSY', message: 'A model run is already going: wait for it to finish.', run: last }, { status: 409 });
    await dispatchWorkflow(WORKFLOW[version], {}, version === 'wide' ? 'the Algo Live model (wide) workflow' : 'the Algo Live model workflow');
    return NextResponse.json({ ok: true, startedAt: Date.now() });
  } catch (e) { return fail(e); }
}
