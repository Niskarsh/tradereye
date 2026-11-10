/**
 * Algo Lab iteration 12, step 1 (.github/workflows/algo-lab-wide.yml): builds the wide-universe dataset. The repo is public,
 * so this prints progress only, never the token.
 * Env: RUN_ID, ML_DIR, AWS_*, DHAN_CLIENT_ID (optional: the token must belong to this account)
 */
import { DhanClient, DhanError, clientIdFromToken } from '../lib/dhan';
import { getChunk, putChunk } from '../lib/book/s3';
import { RUN_ID, getJson, pendingKey, putJson, type RunStatus } from '../lib/setups/store';
import { runWideGrid, WIDE_STATUS_KEY } from '../lib/ml/wideJob';

const store = { get: getChunk, put: putChunk };

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (tradereye backtest)', Accept: 'text/csv,*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
  return res.text();
}

async function main() {
  const runId = process.env.RUN_ID ?? '';
  if (!RUN_ID.test(runId)) throw new Error('RUN_ID is missing or malformed.');
  const pending = await getJson<{ token?: string }>(store, pendingKey(runId));
  const token = pending?.token ?? '';
  await putJson(store, pendingKey(runId), { used: true, at: Date.now() }); // the token is in S3 only until the job has it
  if (!token) throw new Error('No Dhan token was handed over for this run (press Run again on Algo Lab).');
  console.log(`::add-mask::${token}`);
  const want = process.env.DHAN_CLIENT_ID?.trim();
  if (want && clientIdFromToken(token) !== want) throw new Error('The Dhan token belongs to a different Dhan account than DHAN_CLIENT_ID.');
  const prev = await getJson<RunStatus>(store, WIDE_STATUS_KEY);
  const startedAt = prev?.runId === runId ? prev.startedAt : Date.now();
  const r = await runWideGrid(runId, startedAt, { store, dhan: new DhanClient({ token }), fetchText, gridDir: process.env.ML_DIR ?? 'ml-data', override: process.env.OVERRIDE === 'true', log: (m) => console.log(m) });
  console.log(`done: ${r.rows} rows, ${r.stocks} stocks, ${r.stockDays} stock-days`);
}

main().catch(async (e) => {
  const msg = e instanceof DhanError
    ? (e.isAuth ? 'Dhan rejected the token (expired?). Log in again and press Run.' : e.isNoDataPlan ? 'Dhan says the Data API plan is not active.' : `Dhan error: ${e.message}`)
    : (e as Error)?.message ?? String(e);
  console.error(`failed: ${msg}`);
  const prev = await getJson<RunStatus>(store, WIDE_STATUS_KEY).catch(() => undefined);
  await putJson(store, WIDE_STATUS_KEY, { runId: process.env.RUN_ID ?? '', state: 'failed', startedAt: prev?.startedAt ?? Date.now(), updatedAt: Date.now(), finishedAt: Date.now(), message: msg } satisfies RunStatus).catch(() => {});
  process.exit(1);
});
