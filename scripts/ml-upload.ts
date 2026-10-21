/**
 * Algo Lab, step 3 (runs after the Python step, even if it failed): uploads ml-data/ml.json to S3 and finishes the
 * run's status. The backtest results are already saved by then, so a failed model never loses them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { getChunk, putChunk } from '../lib/book/s3';
import { STATUS_KEY, getJson, mlKey, putJson, type RunStatus } from '../lib/setups/store';

const store = { get: getChunk, put: putChunk };

async function main() {
  const runId = process.env.RUN_ID ?? '';
  const dir = process.env.ML_DIR ?? 'ml-data';
  const prev = await getJson<RunStatus>(store, STATUS_KEY);
  if (prev?.runId !== runId || prev.state === 'failed') { console.log('the backtest itself did not finish; nothing to add'); return; }
  const file = `${dir}/ml.json`;
  let message: string;
  if (existsSync(file)) {
    const ml = JSON.parse(readFileSync(file, 'utf8'));
    await putJson(store, mlKey(runId), ml);
    const best = (ml.strategies ?? []).find((s: { id: string }) => s.id === ml.best);
    const r = (x: number) => `${x > 0 ? '+' : ''}${x}R`;
    message = best
      ? `Algo Lab iteration ${ml.iteration}: best is ${best.name}, ${r(best.dev.netR)} a trade on the earlier months, ${r(best.exam.netR)} on the exam months (after costs)`
      : `Algo Lab: ${ml.overall?.n ?? 0} out-of-sample trades, ${r(ml.overall?.netR ?? 0)} each after costs`;
  } else message = 'Backtest done; the Algo Lab model step failed (see the GitHub run log)';
  await putJson(store, STATUS_KEY, { runId, state: 'done', startedAt: prev?.startedAt ?? Date.now(), updatedAt: Date.now(), finishedAt: Date.now(), message } satisfies RunStatus);
  console.log(message);
}
main().catch((e) => { console.error(e); process.exit(1); });
