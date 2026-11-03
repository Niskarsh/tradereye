/** Same picks, protect the profit at 80-90% (lib/ml/profitLock.ts). Results: annotations and setups/ml/profit-lock/ in S3. */
import { getChunk, putChunk } from '../lib/book/s3';
import { ML_LEDGER_KEY, getJson, mlIterKey, putJson } from '../lib/setups/store';
import type { LedgerEntry } from '../lib/ml/ledger';
import type { Line, Strat } from '../lib/ml/bracketReplay';
import { profitLock, RULES } from '../lib/ml/profitLock';

const store = { get: getChunk, put: putChunk };
type L = Line & { rule: string };
const line = (l: L) => `${RULES.find((r) => r.id === l.rule)?.label}: ${l.netR.toFixed(3)}R (t ${l.t}) win ${Math.round(l.win * 100)}pct | Rs ${l.inr} | green ${l.monthsGreen}/${l.months} worst month ${l.worstMonth} | vs as now ${l.diffR}R (t ${l.diffT}) | n ${l.n}`;
const notice = (title: string, ls: L[]) => { if (ls.length) console.log(`::notice title=${title}::${ls.map(line).join('%0A')}`); };

async function main() {
  const iteration = Number(process.env.ITERATION || 10), id = 'fCap2';
  const ledger = (await getJson<LedgerEntry[]>(store, ML_LEDGER_KEY)) ?? [];
  const entry = ledger.filter((e) => e.iteration === iteration && e.lines.some((l) => l.id === id)).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!entry) throw new Error(`no iteration ${iteration}`);
  const ml = await getJson<{ examFrom: string; strategies: Strat[]; untouched?: Strat[] }>(store, mlIterKey(iteration, entry.runId));
  if (!ml) throw new Error('iteration file missing');
  const r = await profitLock(ml, id, store, console.log);
  await putJson(store, `setups/ml/profit-lock/${iteration}-${entry.runId}-${process.env.GITHUB_RUN_ID ?? 'local'}.json.gz`, { iteration, runId: entry.runId, ...r });
  console.log(`::notice title=Check::simulator vs backtest ride: ${r.checked - r.mismatch}/${r.checked} matched; chosen on decide months at 3 ticks: ${r.chosen}`);
  notice('Decide 1 tick past', r.through1); notice('Decide 3 ticks past', r.through3);
  notice('Exam 1 tick past', r.exam1); notice('Exam 3 ticks past', r.exam3);
  notice('Untouched 1 tick past', r.untouched1); notice('Untouched 3 ticks past', r.untouched3);
  if (r.mismatch > r.checked * 0.02) { console.log('::error title=Simulator does not match::'); process.exit(1); }
}
main().catch((e) => { console.log(`::error title=Failed::${String(e?.message ?? e).replace(/\n/g, ' ')}`); process.exit(1); });
