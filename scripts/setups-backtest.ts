/**
 * Entry point of the "Setup backtest" GitHub Action (.github/workflows/setups-backtest.yml), started by the Re-run
 * button on My Setups. The repo is public, so the Action's log is public too: this script prints progress only,
 * never the token, never prices of his trades.
 *
 * Env: RUN_ID (from the button), AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET_NAME,
 *      DHAN_CLIENT_ID (optional: the token must belong to this Dhan account), SETUPS_ONLY (optional: "A,B" for a quick trial)
 */
import { DhanClient, DhanError, clientIdFromToken } from '../lib/dhan';
import { getChunk, putChunk } from '../lib/book/s3';
import { runBacktest } from '../lib/setups/job';
import { RUN_ID, STATUS_KEY, getJson, pendingKey, putJson, type RunStatus } from '../lib/setups/store';

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
  // the token is in S3 only until the job has it
  await putJson(store, pendingKey(runId), { used: true, at: Date.now() });
  if (!token) throw new Error('No Dhan token was handed over for this run (press Re-run again on My Setups).');
  console.log(`::add-mask::${token}`);
  const want = process.env.DHAN_CLIENT_ID?.trim();
  if (want && clientIdFromToken(token) !== want) throw new Error('The Dhan token belongs to a different Dhan account than DHAN_CLIENT_ID.');

  const only = process.env.SETUPS_ONLY?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const t0 = Date.now();
  const { summary } = await runBacktest(runId, {
    store, dhan: new DhanClient({ token }), fetchText,
    log: (m) => console.log(m),
    onlySymbols: only?.length ? only : undefined,
    gridDir: process.env.ML_DIR || undefined,
    mlYears: Number(process.env.ML_YEARS) || undefined,
  });
  console.log(`done in ${Math.round((Date.now() - t0) / 60000)} min: ${summary.universe.signals} signals, ${summary.universe.symbols} stocks, ${summary.period.from}..${summary.period.to}`);
}

main().catch(async (e) => {
  const msg = e instanceof DhanError
    ? (e.isAuth ? 'Dhan rejected the token (expired?). Generate today\'s token and press Re-run.' : e.isNoDataPlan ? 'Dhan says the Data API plan is not active.' : `Dhan error: ${e.message}`)
    : (e as Error)?.message ?? String(e);
  console.error(`failed: ${msg}`);
  const prev = await getJson<RunStatus>(store, STATUS_KEY).catch(() => undefined);
  await putJson(store, STATUS_KEY, {
    runId: process.env.RUN_ID ?? '', state: 'failed', startedAt: prev?.startedAt ?? Date.now(), updatedAt: Date.now(), finishedAt: Date.now(), message: msg,
  } satisfies RunStatus).catch(() => {});
  process.exit(1);
});
