/** Same picks, smaller bracket (lib/ml/bracketReplay.ts). Results: annotations and setups/ml/bracket-replay/ in S3. */
import { getChunk, putChunk } from '../lib/book/s3';
import { ML_LEDGER_KEY, getJson, mlIterKey, putJson } from '../lib/setups/store';
import type { LedgerEntry } from '../lib/ml/ledger';
import { bracketReplay, type Line, type Strat } from '../lib/ml/bracketReplay';

const store = { get: getChunk, put: putChunk };
const line = (l: Line) => `${Math.round(l.scale * 100)}%: ${l.netR}R (t ${l.t}) win ${Math.round(l.win * 100)}% | Rs ${l.inr} (${l.inrPerTrade}/trade) | green ${l.monthsGreen}/${l.months} worst month ${l.worstMonth} | vs 100% ${l.diffR}R (t ${l.diffT}) | n ${l.n} capped ${l.capped}`;
const notice = (title: string, ls: Line[]) => console.log(`::notice title=${title}::${ls.map(line).join('%0A')}`);

async function main() {
  const iteration = Number(process.env.ITERATION || 10), id = process.env.STRATEGY || 'fCap2';
  const ledger = (await getJson<LedgerEntry[]>(store, ML_LEDGER_KEY)) ?? [];
  const entry = ledger.filter((e) => e.iteration === iteration && e.lines.some((l) => l.id === id)).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!entry) throw new Error(`no iteration ${iteration} with ${id}`);
  const ml = await getJson<{ examFrom: string; strategies: Strat[]; untouched?: Strat[] }>(store, mlIterKey(iteration, entry.runId));
  if (!ml) throw new Error('iteration file missing');
  const r = await bracketReplay(ml, id, store, console.log);
  await putJson(store, `setups/ml/bracket-replay/${iteration}-${entry.runId}-${process.env.GITHUB_RUN_ID ?? 'local'}.json.gz`, { iteration, runId: entry.runId, code: entry.code, ...r });
  console.log(`::notice title=Replay check::iteration ${iteration} run ${entry.runId} ${id}: ${r.trades} trades, 100% matched the stored result on ${r.checked - r.mismatch}/${r.checked}, no data ${r.skipped}, chosen on decide months: ${Math.round(r.chosen * 100)}%`);
  notice('Decide, real fills and cap', r.decideReal);
  notice('Decide, old fills', r.decideOld);
  notice('Exam, real fills and cap', r.exam);
  if (r.untouched.length) notice('Untouched, real fills and cap', r.untouched);
  if (r.mismatch > r.checked * 0.02) { console.log('::error title=Replay does not match::the 100% replay differs from the stored trades'); process.exit(1); }
}
main().catch((e) => { console.log(`::error title=Bracket replay failed::${String(e?.message ?? e).replace(/\n/g, ' ')}`); process.exit(1); });
