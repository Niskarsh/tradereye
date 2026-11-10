/**
 * Algo Lab iteration 12, step 3: merges the model jobs (ml-data/wide-<universe>-<shard>.json), applies the rule fixed
 * before the run (lib/ml/wide.ts) and files the result in the iteration ledger, where Algo Lab can open it. It is not added
 * to the run index, so it never becomes "the latest backtest" for My Setups or for the monthly Algo Live model.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { getChunk, putChunk } from '../lib/book/s3';
import { ML_LEDGER_KEY, getJson, mlIterKey, putJson, type RunStatus } from '../lib/setups/store';
import { ledgerEntry, type LedgerEntry, type MlResult } from '../lib/ml/ledger';
import { wideVerdict, type WideShard } from '../lib/ml/wide';
import { WIDE_STATUS_KEY } from '../lib/ml/wideJob';

const store = { get: getChunk, put: putChunk };
type Dev = { n: number; netR: number; t: number; sumR: number; monthsGreen?: number; monthsTraded?: number };
type Shard = Omit<WideShard, 'strategies'> & Omit<MlResult, 'strategies'> & { locked?: string; strategies: (WideShard['strategies'][number] & { overall: { n: number; netR: number; t: number } })[] };

/** one strategy's numbers in each training draw */
function noiseOf(shards: Shard[], id: string) {
  const draws = shards.flatMap((s) => {
    const st = s.strategies.find((x) => x.id === id);
    const dev = st?.dev as Dev | undefined;
    return st && dev ? [{ draw: s.shard, n: st.overall.n, netR: st.overall.netR, t: st.overall.t, devNetR: dev.netR, devT: dev.t, devGreen: [dev.monthsGreen ?? 0, dev.monthsTraded ?? 0] }] : [];
  });
  const dv = draws.map((r) => r.devNetR);
  return { strategy: id, draws, devMin: Math.min(...dv), devMax: Math.max(...dv), devMean: Math.round((dv.reduce((a, b) => a + b, 0) / Math.max(1, dv.length)) * 1000) / 1000 };
}

async function finish(runId: string, state: 'done' | 'failed', message: string) {
  const prev = await getJson<RunStatus>(store, WIDE_STATUS_KEY).catch(() => undefined);
  await putJson(store, WIDE_STATUS_KEY, { runId, state, startedAt: prev?.startedAt ?? Date.now(), updatedAt: Date.now(), finishedAt: Date.now(), message } satisfies RunStatus);
  console.log(message);
}

async function main() {
  const runId = process.env.RUN_ID ?? '', dir = process.env.ML_DIR ?? 'ml-data';
  const prev = await getJson<RunStatus>(store, WIDE_STATUS_KEY);
  if (!prev || prev.runId !== runId || prev.state === 'failed') { console.log('the dataset step did not finish; nothing to add'); return; }
  const shards: Shard[] = (existsSync(dir) ? readdirSync(dir) : []).flatMap((f: string) => {
    const m = /^wide-(narrow|wide|wide5|ladder)-(main|seed\d+)\.json$/.exec(f);
    if (!m) return [];
    return [{ ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as Shard), universe: m[1] as WideShard['universe'], shard: m[2] }];
  });
  const wide = shards.find((s) => s.universe === 'wide' && s.shard === 'main');
  const narrow = shards.find((s) => s.universe === 'narrow' && s.shard === 'main');
  // iteration 14's second size was 'wide5'; from 15 the size ladder is 'ladder' (main draw only)
  const extra = shards.find((s) => (s.universe === 'ladder' || s.universe === 'wide5') && s.shard === 'main');
  if (!wide || !narrow) { await finish(runId, 'failed', 'The run did not finish (see the GitHub run log). Nothing was filed; candles fetched so far are saved, so pressing Run again carries on.'); process.exit(1); }
  const verdict = wideVerdict(shards);
  const wides = shards.filter((s) => s.universe === 'wide'), narrows = shards.filter((s) => s.universe === 'narrow');
  const ml = {
    ...wide,
    strategies: [...narrow.strategies, ...wide.strategies, ...(extra?.strategies ?? [])],
    untouched: [narrow, wide, extra].flatMap((x) => ((x as unknown as { untouched?: unknown[] } | undefined)?.untouched ?? [])),
    noiseAll: [noiseOf(narrows, 'nF'), noiseOf(narrows, 'nT10'), ...wide.strategies.filter((s) => s.id !== 'placebo').map((s) => noiseOf(wides, s.id))].filter((x) => x.draws.length > 1),
    best: verdict.pick?.id ?? 'nF',
    locked: 'nF', // Algo Live's own setup (₹250-340, ₹300 risk), not the grid's first cell
    narrowStocks: (narrow as unknown as { stocks?: number }).stocks,
    wide: verdict,
  };
  delete (ml as { noise?: unknown }).noise; // noiseAll has it, per version
  await putJson(store, mlIterKey(ml.iteration, runId), ml);
  const ledger = (await getJson<LedgerEntry[]>(store, ML_LEDGER_KEY)) ?? [];
  if (!ledger.some((e) => e.runId === runId)) {
    ledger.push(ledgerEntry(ml as unknown as MlResult));
    await putJson(store, ML_LEDGER_KEY, ledger.sort((a, b) => a.iteration - b.iteration || a.createdAt - b.createdAt));
  }
  await finish(runId, 'done', `Iteration ${ml.iteration}: ${verdict.message}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
