import { gunzip, gzip } from '../book/record';
import type { Summary } from './stats';
import type { CaseId } from './cases';

/**
 * Where the setup backtest keeps things in S3 (same bucket as everything else):
 *
 *   setups/status.json                      the run in progress / the last run (the page polls it)
 *   setups/pending/<runId>.json             the Dhan token handed to the GitHub job (overwritten as soon as it is read)
 *   setups/runs/index.json                  every run, newest first
 *   setups/runs/<runId>/summary.json.gz     the numbers per case, the rule checks, the alert lookup
 *   setups/runs/<runId>/signals-<case>.json.gz   every past trade of that case (for the page's filters)
 *   setups/runs/<runId>/study.json.gz       the reversal study: labelled moments -> facts -> rules (year 1) -> year 2
 *   setups/runs/<runId>/moments-long|short.bin.gz  every possible reversal entry (so new rules can be tested later)
 *   setups/runs/<runId>/claude-rules.json.gz      the rules Claude wrote from year 1, with their year 1 / year 2 results
 *   setups/runs/<runId>/ml.json.gz          Algo Lab: walk-forward machine-learning results (out of sample)
 *   setups/ml/iterations.json               Algo Lab: every iteration from 5 on (run, code version, headline), kept for good
 *   setups/ml/iterations/<n>/<runId>.json.gz  Algo Lab: a full copy of that iteration's results, kept for good
 *   setups/candles/1m/<SYMBOL>/<YYYY-MM>.json.gz  one month of 1-minute candles (a finished month is never fetched again)
 *   setups/candles/daily/<SYMBOL>.json.gz   daily candles (fetched again on each run: one request per stock)
 */

export interface Store {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, body: Uint8Array): Promise<void>;
}

export type RunState = 'queued' | 'running' | 'done' | 'failed';
export interface RunStatus {
  runId: string;
  state: RunState;
  phase?: string;
  done?: number;
  total?: number;
  message?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
}
export interface RunIndexItem { runId: string; createdAt: number; period: Summary['period']; signals: number; symbols: number }

export const STATUS_KEY = 'setups/status.json';
export const INDEX_KEY = 'setups/runs/index.json';
export const pendingKey = (runId: string) => `setups/pending/${runId}.json`;
export const summaryKey = (runId: string) => `setups/runs/${runId}/summary.json.gz`;
export const signalsKey = (runId: string, c: CaseId) => `setups/runs/${runId}/signals-${c}.json.gz`;
/** the reversal study of a run (lib/study) */
export const studyKey = (runId: string) => `setups/runs/${runId}/study.json.gz`;
/** every possible entry of the study, per side (lib/study/moments.ts), and the rules Claude wrote for that run */
export const momentsKey = (runId: string, dir: 1 | -1) => `setups/runs/${runId}/moments-${dir === 1 ? 'long' : 'short'}.bin.gz`;
export const claudeRulesKey = (runId: string) => `setups/runs/${runId}/claude-rules.json.gz`;
/** Algo Lab: the walk-forward model results of a run (scripts/ml_walkforward.py) */
export const mlKey = (runId: string) => `setups/runs/${runId}/ml.json.gz`;
/**
 * Algo Lab iterations, kept for good (never pruned with the run index): the ledger of every iteration from 5 on (its
 * run, its code version, its headline numbers) and a copy of each iteration's full results, so we can always go back.
 */
export const ML_LEDGER_KEY = 'setups/ml/iterations.json';
export const mlIterKey = (iteration: number, runId: string) => `setups/ml/iterations/${iteration}/${runId}.json.gz`;
export const monthKey = (symbol: string, month: string) => `setups/candles/1m/${symbol.toUpperCase()}/${month}.json.gz`;
export const dailyKey = (symbol: string) => `setups/candles/daily/${symbol.toUpperCase()}.json.gz`;

export const RUN_ID = /^[0-9A-Za-z-]{6,40}$/;

/** A run whose status has not moved for this long is treated as dead (the job was cancelled or timed out). */
/** the Algo Lab model step updates nothing while it trains (iteration 7: 2.5 hours), so only the job's own 5-hour limit
 * (.github/workflows/setups-backtest.yml timeout-minutes) can tell a dead run from a slow one */
export const STALE_MS = 320 * 60_000;
export function isActive(s: RunStatus | undefined, now = Date.now()): boolean {
  return !!s && (s.state === 'queued' || s.state === 'running') && now - s.updatedAt < STALE_MS;
}

const enc = new TextEncoder(), dec = new TextDecoder();
export async function getJson<T>(store: Store, key: string): Promise<T | undefined> {
  const b = await store.get(key);
  if (!b) return undefined;
  try { return JSON.parse(key.endsWith('.gz') ? await gunzip(b) : dec.decode(b)) as T; } catch { return undefined; }
}
export async function putJson(store: Store, key: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  await store.put(key, key.endsWith('.gz') ? await gzip(text) : enc.encode(text));
}
