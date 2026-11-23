/**
 * Algo Lab iteration 17, step 4: files the result (ml-data/i17.json, from scripts/ml_iter17_layers.py) in the iteration
 * ledger, where Algo Lab can open it. It is not added to the run index, so it never becomes "the latest backtest" for My
 * Setups or for the monthly Algo Live model.
 */
import { existsSync, readFileSync } from 'node:fs';
import { getChunk, putChunk } from '../lib/book/s3';
import { ML_LEDGER_KEY, getJson, mlIterKey, putJson, type RunStatus } from '../lib/setups/store';
import { ledgerEntry, type LedgerEntry, type MlResult } from '../lib/ml/ledger';
import { I17_STATUS_KEY } from '../lib/ml/iter17Meta';

const store = { get: getChunk, put: putChunk };

async function finish(runId: string, state: 'done' | 'failed', message: string) {
  const prev = await getJson<RunStatus>(store, I17_STATUS_KEY).catch(() => undefined);
  await putJson(store, I17_STATUS_KEY, { runId, state, startedAt: prev?.startedAt ?? Date.now(), updatedAt: Date.now(), finishedAt: Date.now(), message } satisfies RunStatus);
  console.log(message);
}

async function main() {
  const runId = process.env.RUN_ID ?? '', dir = process.env.ML_DIR ?? 'ml-data';
  const prev = await getJson<RunStatus>(store, I17_STATUS_KEY);
  if (!prev || prev.runId !== runId || prev.state === 'failed') { console.log('the dataset step did not finish; nothing to add'); return; }
  const file = `${dir}/i17.json`;
  if (!existsSync(file)) {
    const why = process.env.LAYERS === 'failure' ? 'the learning-from-losses step failed' : 'a model job did not finish';
    await finish(runId, 'failed', `The run did not finish: ${why} (see the GitHub run log). Nothing was filed; candles fetched so far are saved, so pressing Run again carries on.`);
    process.exit(1);
  }
  const ml = JSON.parse(readFileSync(file, 'utf8')) as MlResult & { iter17?: { verdict?: { message?: string } } };
  await putJson(store, mlIterKey(ml.iteration, runId), ml);
  const ledger = (await getJson<LedgerEntry[]>(store, ML_LEDGER_KEY)) ?? [];
  if (!ledger.some((e) => e.runId === runId)) {
    ledger.push(ledgerEntry(ml));
    await putJson(store, ML_LEDGER_KEY, ledger.sort((a, b) => a.iteration - b.iteration || a.createdAt - b.createdAt));
  }
  await finish(runId, 'done', `Iteration ${ml.iteration}: ${ml.iter17?.verdict?.message ?? 'filed'}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
