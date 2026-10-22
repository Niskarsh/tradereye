/**
 * Algo Lab, step 3 (runs after the model jobs, even if one failed): merges the main result (ml-data/ml.json) with the
 * noise-check shards (ml-data/ml-seed*.json), runs the trade-management experiment on the trades (lib/ml/manageRun.ts),
 * uploads it to S3, files it in the iteration ledger (kept for good), and finishes the run's status. The backtest
 * results are already saved by then, so a failed model never loses them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { getChunk, putChunk } from '../lib/book/s3';
import { INDEX_KEY, ML_LEDGER_KEY, STATUS_KEY, getJson, mlIterKey, mlKey, putJson, type RunIndexItem, type RunStatus } from '../lib/setups/store';
import { ledgerEntry, type LedgerEntry, type MlResult } from '../lib/ml/ledger';
import { confirmAll } from '../lib/ml/manageRun';

interface Shard { shard: string; seedOffset: number; locked?: string; strategies: { id: string; overall: { n: number; netR: number; t: number; monthsGreen?: number; monthsTraded?: number }; dev: { n: number; netR: number; t: number; monthsGreen?: number; monthsTraded?: number } }[] }

/** the locked strategy's numbers from each training draw: how much of a result is just luck in the training */
function noiseOf(main: MlResult & Shard, dir: string) {
  const files = existsSync(dir) ? readdirSync(dir).filter((f: string) => /^ml-seed\d+\.json$/.test(f)).sort() : [];
  const shards: Shard[] = [main, ...files.map((f: string) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as Shard)];
  const rows = shards.map((x) => {
    const st = x.strategies.find((y) => y.id === main.locked);
    return st ? { draw: x.shard === 'main' ? 'main' : x.shard, n: st.overall.n, netR: st.overall.netR, t: st.overall.t, devNetR: st.dev.netR, devT: st.dev.t, devGreen: [st.dev.monthsGreen ?? 0, st.dev.monthsTraded ?? 0] } : undefined;
  }).filter((x): x is NonNullable<typeof x> => !!x);
  const dv = rows.map((r) => r.devNetR);
  return { strategy: main.locked, draws: rows, devMin: Math.min(...dv), devMax: Math.max(...dv), devMean: Math.round((dv.reduce((a, b) => a + b, 0) / Math.max(1, dv.length)) * 1000) / 1000 };
}

const store = { get: getChunk, put: putChunk };

/** files a result in the ledger (and keeps a full copy) unless that run is already there */
async function file(ledger: LedgerEntry[], ml: MlResult): Promise<boolean> {
  if (!ml || !(ml.iteration >= 5) || ledger.some((e) => e.runId === ml.runId)) return false;
  await putJson(store, mlIterKey(ml.iteration, ml.runId), ml);
  ledger.push(ledgerEntry(ml));
  return true;
}

async function main() {
  const runId = process.env.RUN_ID ?? '';
  const dir = process.env.ML_DIR ?? 'ml-data';
  const prev = await getJson<RunStatus>(store, STATUS_KEY);
  if (!prev || prev.runId !== runId || prev.state === 'failed') { console.log('the backtest itself did not finish; nothing to add'); return; }
  const file_ = `${dir}/ml.json`;
  const ledger = (await getJson<LedgerEntry[]>(store, ML_LEDGER_KEY)) ?? [];
  let changed = false;
  // earlier iterations (from 5 on) that ran before the ledger existed: file them too
  for (const r of ((await getJson<RunIndexItem[]>(store, INDEX_KEY)) ?? [])) {
    if (r.runId === runId) continue;
    const old = await getJson<MlResult>(store, mlKey(r.runId)).catch(() => undefined);
    if (old && (await file(ledger, old))) { changed = true; console.log(`filed iteration ${old.iteration} (run ${old.runId})`); }
  }
  let message: string;
  if (existsSync(file_)) {
    const ml = JSON.parse(readFileSync(file_, 'utf8')) as MlResult & Shard & { examFrom: string; noise?: unknown; management?: unknown; managementError?: string };
    if (ml.locked) ml.noise = noiseOf(ml, dir);
    // iteration 9: no search; the add rule fixed in advance is replayed on every set of trades (see lib/ml/manageRun.ts CONFIRM)
    try { (ml as { confirm?: unknown }).confirm = await confirmAll(ml as never, store, (m) => console.log(m)); }
    catch (e) { ml.managementError = (e as Error).message; console.error('management failed', e); }
    await putJson(store, mlKey(runId), ml);
    if (await file(ledger, ml)) changed = true;
    const best = (ml.strategies ?? []).find((s) => s.id === ml.best);
    const r = (x: number) => `${x > 0 ? '+' : ''}${x}R`;
    message = best
      ? `Algo Lab iteration ${ml.iteration}: best on the decide months is ${best.name}, ${r(best.dev.netR)} a trade after costs`
      : `Algo Lab: done`;
  } else message = 'Backtest done; the Algo Lab model step failed (see the GitHub run log)';
  if (changed) await putJson(store, ML_LEDGER_KEY, ledger.sort((a, b) => a.iteration - b.iteration || a.createdAt - b.createdAt));
  await putJson(store, STATUS_KEY, { runId, state: 'done', startedAt: prev?.startedAt ?? Date.now(), updatedAt: Date.now(), finishedAt: Date.now(), message } satisfies RunStatus);
  console.log(message);
}
main().catch((e) => { console.error(e); process.exit(1); });
