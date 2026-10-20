import { DhanError, parseScripMaster, SCRIP_MASTER_URL, type Candles, type DhanClient } from '../dhan';
import { toSessions, type Session } from '../live/enrich';
import { joinCandles } from '../candles/store';
import { runDay, DEFAULT_PARAMS, type Params } from './engine';
import { CASES, type Signal } from './cases';
import { buildSummary, pack, type Summary } from './stats';
import { monthsNeeded, parseIndexCsv, screenerDays, SCREENER, type ScreenerFilter } from './universe';
import { INDEX_KEY, STATUS_KEY, dailyKey, getJson, monthKey, putJson, signalsKey, summaryKey, type RunIndexItem, type RunStatus, type Store } from './store';

/**
 * The backtest, start to finish (run by the GitHub Action; see scripts/setups-backtest.ts):
 *  1. the universe: today's Nifty 500 list, mapped to Dhan security ids
 *  2. daily candles for each stock (one request each) -> the days it passed his screener in the last 2 years
 *  3. 1-minute candles for those months only (plus ~5 weeks before, for ATR / EMA / relative volume), from S3 when
 *     already saved; a finished month is saved and never fetched again
 *  4. every passing day replayed through the engine; every signal followed to its outcome
 *  5. the summary, the per-case signal files and the run index written to S3
 * Progress goes to setups/status.json every few seconds. Nothing here prints the token.
 */

export const NIFTY500 = { symbol: 'NIFTY500', securityId: '19', segment: 'IDX_I', instrument: 'INDEX' };
export const INDEX_URLS = [
  'https://niftyindices.com/IndexConstituent/ind_nifty500list.csv',
  'https://archives.nseindia.com/content/indices/ind_nifty500list.csv',
];
const DAY = 86400_000;
const IST = 19800_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dateOf = (sec: number) => new Date(sec * 1000 + IST).toISOString().slice(0, 10);
const lastDayOfMonth = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };

export interface JobDeps {
  store: Store;
  dhan: Pick<DhanClient, 'intraday' | 'daily'>;
  fetchText: (url: string) => Promise<string>;
  now?: () => number;
  log?: (msg: string) => void;
  /** Dhan allows 5 data requests a second; the job keeps to 4 */
  minGapMs?: number;
  concurrency?: number;
  years?: number;
  screener?: ScreenerFilter;
  params?: Partial<Params>;
  /** limit the universe (tests / a quick trial run) */
  onlySymbols?: string[];
}

class RateLimit {
  private next = 0;
  constructor(private gap: number) {}
  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

export interface JobResult { summary: Summary; signals: Signal[] }

export async function runBacktest(runId: string, deps: JobDeps): Promise<JobResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const rl = new RateLimit(deps.minGapMs ?? 250);
  const params: Params = { ...DEFAULT_PARAMS, ...deps.params };
  const screener = deps.screener ?? SCREENER;
  const startedAt = now();
  let lastStatus = 0;
  const status = async (s: Partial<RunStatus>, force = false) => {
    if (!force && now() - lastStatus < 5000) return;
    lastStatus = now();
    await putJson(deps.store, STATUS_KEY, { runId, state: 'running', startedAt, updatedAt: now(), ...s } satisfies RunStatus);
  };
  const dhanCall = async <T>(fn: () => Promise<T>): Promise<T> => { await rl.wait(); return fn(); };

  // ---- 1. universe
  await status({ phase: 'Reading the Nifty 500 list' }, true);
  let symbols: string[] = [];
  let source = 'Nifty 500 (today\'s members)';
  for (const url of INDEX_URLS) {
    try { symbols = parseIndexCsv(await deps.fetchText(url)); if (symbols.length > 400) break; } catch { /* next */ }
  }
  const master = parseScripMaster(await deps.fetchText(SCRIP_MASTER_URL));
  if (symbols.length < 400) {
    // the index list could not be downloaded: every NSE equity, the screener still applies (noted on the page)
    symbols = [...master.keys()];
    source = 'All NSE equities (the Nifty 500 list could not be downloaded)';
  }
  if (deps.onlySymbols) symbols = symbols.filter((s) => deps.onlySymbols!.includes(s));
  const universe = symbols.map((symbol) => ({ symbol, securityId: master.get(symbol) })).filter((x): x is { symbol: string; securityId: string } => !!x.securityId);
  log(`universe: ${universe.length} stocks (${source})`);

  // ---- the period: the last 2 years of finished sessions
  const today = new Date(now() + IST).toISOString().slice(0, 10);
  const niftyDaily = await dhanCall(() => deps.dhan.daily({ securityId: NIFTY500.securityId, segment: NIFTY500.segment, instrument: NIFTY500.instrument, from: addDays(today, -800), to: today }));
  const sessions = [...new Set(niftyDaily.t.map(dateOf))].sort();
  const to = sessions.at(-1);
  if (!to) throw new Error('Dhan returned no Nifty 500 daily candles.');
  const from = addDays(to, -Math.round(365 * (deps.years ?? 2)));
  const inPeriod = sessions.filter((d) => d >= from && d <= to);
  const mid = inPeriod[Math.floor(inPeriod.length / 2)] ?? to;

  // ---- 2. daily candles and screener days
  const plan: { symbol: string; securityId: string; days: string[]; daily: Candles }[] = [];
  await pool(universe, deps.concurrency ?? 3, async (u, i) => {
    try {
      const daily = await dhanCall(() => deps.dhan.daily({ securityId: u.securityId, segment: 'NSE_EQ', instrument: 'EQUITY', from: addDays(from, -1150), to: today }));
      await putJson(deps.store, dailyKey(u.symbol), { v: 1, symbol: u.symbol, securityId: u.securityId, savedAt: now(), c: daily }).catch(() => {});
      const days = screenerDays(daily, screener, from, to);
      if (days.length) plan.push({ ...u, days, daily });
    } catch (e) { if (e instanceof DhanError && (e.isAuth || e.isNoDataPlan)) throw e; }
    await status({ phase: 'Daily candles: which stocks passed your screener', done: i + 1, total: universe.length });
  });
  plan.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const stockDays = plan.reduce((a, p) => a + p.days.length, 0);
  log(`screener: ${plan.length} stocks passed on ${stockDays} stock-days`);

  // ---- 3. one month of 1-minute candles, from S3 or Dhan
  const loadMonth = async (ins: { symbol: string; securityId: string; segment: string; instrument: string }, month: string): Promise<Candles> => {
    const key = monthKey(ins.symbol, month);
    const saved = await getJson<{ v: 1; complete: boolean; c: Candles }>(deps.store, key).catch(() => undefined);
    if (saved?.complete) return saved.c;
    const last = lastDayOfMonth(month);
    const c = await dhanCall(() => deps.dhan.intraday({ securityId: ins.securityId, segment: ins.segment, instrument: ins.instrument, from: `${month}-01`, to: last < today ? last : today, interval: 1 }));
    const complete = last < today;
    await putJson(deps.store, key, { v: 1, symbol: ins.symbol, securityId: ins.securityId, month, complete, savedAt: now(), c }).catch(() => {});
    return c;
  };
  const allMonths = monthsNeeded(inPeriod);
  const niftyByDate = new Map<string, Session>();
  for (const m of allMonths) {
    for (const s of toSessions(await loadMonth(NIFTY500, m))) niftyByDate.set(s.date, s);
    await status({ phase: 'Nifty 500 1-minute history' });
  }

  // ---- 4. replay
  const signals: Signal[] = [];
  let done = 0, skipped = 0;
  await pool(plan, deps.concurrency ?? 3, async (p) => {
    const parts: Candles[] = [];
    for (const m of monthsNeeded(p.days)) {
      try { parts.push(await loadMonth({ symbol: p.symbol, securityId: p.securityId, segment: 'NSE_EQ', instrument: 'EQUITY' }, m)); }
      catch (e) { if (e instanceof DhanError && (e.isAuth || e.isNoDataPlan)) throw e; skipped++; }
    }
    const sess = toSessions(joinCandles(parts));
    const byDate = new Map(sess.map((s, i) => [s.date, i]));
    const dailyDates = p.daily.t.map(dateOf);
    for (const d of p.days) {
      const i = byDate.get(d), n = niftyByDate.get(d);
      if (i === undefined || !n) { skipped++; continue; }
      const cut = dailyDates.findIndex((x) => x >= d);
      const end = cut < 0 ? dailyDates.length : cut;
      const daily: Candles = { t: p.daily.t.slice(0, end), o: p.daily.o.slice(0, end), h: p.daily.h.slice(0, end), l: p.daily.l.slice(0, end), c: p.daily.c.slice(0, end), v: p.daily.v.slice(0, end) };
      signals.push(...runDay({ symbol: p.symbol, date: d, history: sess.slice(Math.max(0, i - 20), i), day: sess[i].bars, nifty: n.bars, daily, params, simulate: true }));
    }
    done++;
    await status({ phase: 'Testing the setups', done, total: plan.length });
  });
  log(`signals: ${signals.length} (skipped ${skipped} stock-days or months without data)`);

  // ---- 5. results
  await status({ phase: 'Writing the results' }, true);
  signals.sort((a, b) => (a.date === b.date ? a.slot - b.slot : a.date < b.date ? -1 : 1));
  const summary = buildSummary(signals, {
    runId, createdAt: now(), period: { from, to, mid },
    universe: { source, symbols: plan.length, stockDays },
    params: { ...params, priceMin: screener.priceMin, priceMax: screener.priceMax, avgVolMin: screener.avgVolMin, years: deps.years ?? 2 },
  });
  for (const c of CASES) await putJson(deps.store, signalsKey(runId, c.id), pack(signals.filter((s) => s.case === c.id)));
  await putJson(deps.store, summaryKey(runId), summary);
  const index = (await getJson<RunIndexItem[]>(deps.store, INDEX_KEY)) ?? [];
  const item: RunIndexItem = { runId, createdAt: summary.createdAt, period: summary.period, signals: signals.length, symbols: plan.length };
  await putJson(deps.store, INDEX_KEY, [item, ...index.filter((x) => x.runId !== runId)].slice(0, 36));
  await putJson(deps.store, STATUS_KEY, { runId, state: 'done', startedAt, updatedAt: now(), finishedAt: now(), message: `${signals.length} past trades across ${plan.length} stocks` } satisfies RunStatus);
  return { summary, signals };
}
