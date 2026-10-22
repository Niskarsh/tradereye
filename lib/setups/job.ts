import { DhanError, parseScripMaster, SCRIP_MASTER_URL, type Candles, type DhanClient } from '../dhan';
import { toSessions, type Session } from '../live/enrich';
import { joinCandles } from '../candles/store';
import { runDay, DEFAULT_PARAMS, type Params } from './engine';
import { CASES, type Signal } from './cases';
import { buildSummary, pack, type Summary } from './stats';
import { monthsNeeded, screenerDays, SCREENER, type ScreenerFilter } from './universe';
import { monthEndsOf, prepare, runMonthly, runSingle, runSwing, type DailyStock } from './swing';
import { mineDay, type Moment } from '../study/mine';
import { encodeMoments, gzipBytes } from '../study/moments';
import { gridDay } from '../ml/grid';
import { GridWriter } from '../ml/writer';
import { analyze } from '../study/analyze';
import { INDEX_KEY, STATUS_KEY, dailyKey, getJson, momentsKey, monthKey, putJson, signalsKey, studyKey, summaryKey, type RunIndexItem, type RunStatus, type Store } from './store';

/**
 * The backtest, start to finish (run by the GitHub Action; see scripts/setups-backtest.ts):
 *  1. the universe: every NSE equity in Dhan's instrument list
 *  2. daily candles for each stock (one request each) -> the days it was in his price range with enough volume in the
 *     last 2 years; the 5-day reversal (S1) is run on these daily candles
 *  3. 1-minute candles for those months only (plus ~5 weeks before, for ATR / EMA / relative volume), from S3 when
 *     already saved; a finished month is saved and never fetched again
 *  4. every passing day replayed through the engine; every signal followed to its outcome; the 20 busiest stocks of
 *     each day at 09:25 marked as "in play"
 *  5. the summary, the per-case signal files and the run index written to S3
 * Progress goes to setups/status.json every few seconds. Nothing here prints the token.
 */

export const NIFTY500 = { symbol: 'NIFTY500', securityId: '19', segment: 'IDX_I', instrument: 'INDEX' };
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
  /** Algo Lab: write the dataset here for the Python step that runs after this job (the run is then finished by it) */
  gridDir?: string;
  /** Algo Lab: the first day of its dataset (the setups and the study keep `years`). Default 2022-01-01: Jan-Sep 2022
   * is the untouched test (scripts/ml_walkforward.py DECIDE_FROM), clear of the COVID years; Dhan keeps 5 years of 1-min data */
  mlFrom?: string;
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

/** volume of the first 10 minutes (09:15-09:24) vs the same window over the previous 10 sessions */
export function first10Busy(sess: Session[], i: number): number | undefined {
  const w = (s: Session) => s.bars.reduce((a, b) => { const m = new Date(b.t * 1000 + IST).getUTCHours() * 60 + new Date(b.t * 1000 + IST).getUTCMinutes(); return m >= 555 && m < 565 ? a + b.v : a; }, 0);
  const priors = sess.slice(Math.max(0, i - 10), i).map(w).filter((v) => v > 0);
  if (priors.length < 5) return undefined;
  const base = priors.reduce((a, b) => a + b, 0) / priors.length;
  return base > 0 ? w(sess[i]) / base : undefined;
}

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

  // ---- 1. universe: every NSE equity (the price range and the liquidity floor are applied day by day)
  await status({ phase: 'Reading the NSE equity list' }, true);
  const master = parseScripMaster(await deps.fetchText(SCRIP_MASTER_URL));
  let symbols = [...master.keys()];
  const source = `All NSE equities ₹${screener.priceMin}-${screener.priceMax}, 10-day average volume ${(screener.avgVolMin / 1e5).toFixed(0)} lakh+ shares`;
  if (deps.onlySymbols) symbols = symbols.filter((s) => deps.onlySymbols!.includes(s));
  const universe = symbols.map((symbol) => ({ symbol, securityId: master.get(symbol) })).filter((x): x is { symbol: string; securityId: string } => !!x.securityId);
  log(`universe: ${universe.length} stocks (${source})`);

  // ---- the period: the last 2 years of finished sessions (the Algo Lab dataset goes further back: mlYears)
  const today = new Date(now() + IST).toISOString().slice(0, 10);
  const years = deps.years ?? 2;
  const mlFrom = deps.gridDir ? (deps.mlFrom ?? '2022-01-01') : undefined;
  const span = Math.max(years, mlFrom ? (Date.parse(today) - Date.parse(mlFrom)) / (365 * DAY) : 0);
  const niftyDaily = await dhanCall(() => deps.dhan.daily({ securityId: NIFTY500.securityId, segment: NIFTY500.segment, instrument: NIFTY500.instrument, from: addDays(today, -Math.round(365 * span) - 70), to: today }));
  const sessions = [...new Set(niftyDaily.t.map(dateOf))].sort();
  const to = sessions.at(-1);
  if (!to) throw new Error('Dhan returned no Nifty 500 daily candles.');
  const from = addDays(to, -Math.round(365 * years));
  /** the first day of the Algo Lab dataset (= from when there is no Algo Lab) */
  const fromAll = mlFrom && mlFrom < from ? mlFrom : from;
  const inPeriod = sessions.filter((d) => d >= from && d <= to);
  const mid = inPeriod[Math.floor(inPeriod.length / 2)] ?? to;

  // ---- 2. daily candles, screener days, and the 5-day reversal (S1, daily candles only)
  const plan: { symbol: string; securityId: string; days: string[]; daily: Candles }[] = [];
  const niftyClose = new Map(niftyDaily.t.map((t, i) => [dateOf(t), niftyDaily.c[i]]));
  const signals: Signal[] = [];
  const dailyStocks: DailyStock[] = [];
  await pool(universe, deps.concurrency ?? 3, async (u, i) => {
    try {
      const daily = await dhanCall(() => deps.dhan.daily({ securityId: u.securityId, segment: 'NSE_EQ', instrument: 'EQUITY', from: addDays(fromAll, -1150), to: today }));
      await putJson(deps.store, dailyKey(u.symbol), { v: 1, symbol: u.symbol, securityId: u.securityId, savedAt: now(), c: daily }).catch(() => {});
      const days = screenerDays(daily, screener, fromAll, to);
      if (days.length) plan.push({ ...u, days, daily });
      signals.push(...runSwing(u.symbol, daily, niftyClose, from, to, screener, params));
      // kept for the delivery strategies only if it was ever in the price range during the period
      if (daily.c.some((c, k) => c >= screener.priceMin && c <= screener.priceMax && dateOf(daily.t[k]) >= from)) dailyStocks.push(prepare(u.symbol, daily));
    } catch (e) { if (e instanceof DhanError && (e.isAuth || e.isNoDataPlan)) throw e; }
    await status({ phase: 'Daily candles: which stocks passed your screener', done: i + 1, total: universe.length });
  });
  plan.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const stockDays = plan.reduce((a, p) => a + p.days.filter((d) => d >= from).length, 0);
  log(`screener: ${plan.length} stocks passed on ${stockDays} stock-days`);

  // ---- delivery strategies on the daily candles (D1 / D2 ranked across stocks at each month-end; D3 / D4 per stock)
  await status({ phase: 'Delivery strategies (daily candles)' }, true);
  for (const st of dailyStocks) signals.push(...runSingle(st, from, to, screener, params));
  signals.push(...runMonthly(dailyStocks, monthEndsOf(sessions), from, to, screener, params));
  log(`delivery: ${signals.length} trades on ${dailyStocks.length} stocks`);

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
  const allMonths = monthsNeeded(sessions.filter((d) => d >= fromAll && d <= to));
  const niftyByDate = new Map<string, Session>();
  for (const m of allMonths) {
    for (const s of toSessions(await loadMonth(NIFTY500, m))) niftyByDate.set(s.date, s);
    await status({ phase: 'Nifty 500 1-minute history' });
  }

  // ---- 4. replay
  let done = 0, skipped = 0;
  const moments: Moment[] = [];
  const grid = deps.gridDir ? new GridWriter(deps.gridDir) : undefined;
  /** first-10-minute volume vs usual, per day and stock: the 20 busiest are "in play" that day */
  const busyByDate = new Map<string, { symbol: string; x: number }[]>();
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
      // Algo Lab: every 10-min close of this stock-day, with what the trades taken there would have made (all years)
      grid?.add(p.symbol, d, gridDay({ date: d, history: sess.slice(Math.max(0, i - 20), i), day: sess[i].bars, nifty: n.bars, daily, riskInr: params.riskInr, pocRows: params.pocRows }));
      if (d < from) continue; // the setups and the study: the last `years` only
      const x = first10Busy(sess, i);
      if (x !== undefined) { const a = busyByDate.get(d) ?? []; a.push({ symbol: p.symbol, x }); busyByDate.set(d, a); }
      signals.push(...runDay({ symbol: p.symbol, date: d, history: sess.slice(Math.max(0, i - 20), i), day: sess[i].bars, nifty: n.bars, daily, params, simulate: true }));
      // the reversal study: every moment that could have been a reversal entry, labelled with what happened next
      moments.push(...mineDay({ symbol: p.symbol, date: d, history: sess.slice(Math.max(0, i - 20), i), day: sess[i].bars, nifty: n.bars, daily, riskInr: params.riskInr, pocRows: params.pocRows }));
    }
    done++;
    await status({ phase: 'Testing the setups', done, total: plan.length });
  });
  log(`signals: ${signals.length} (skipped ${skipped} stock-days or months without data)`);
  // stocks in play: the 20 busiest of the day at 09:25 (and at least 1.5x their usual first 10 minutes)
  const inPlay = new Set<string>();
  for (const [d, list] of busyByDate) for (const it of list.sort((a, b) => b.x - a.x).slice(0, 20)) if (it.x >= 1.5) inPlay.add(`${d}|${it.symbol}`);
  for (const sg of signals) if (sg.slot !== 370) sg.inPlay = inPlay.has(`${sg.date}|${sg.symbol}`);

  // ---- 5. results
  await status({ phase: 'Writing the results' }, true);
  signals.sort((a, b) => (a.date === b.date ? a.slot - b.slot : a.date < b.date ? -1 : 1));
  const summary = buildSummary(signals, {
    runId, createdAt: now(), period: { from, to, mid },
    universe: { source, symbols: plan.length, stockDays },
    params: { ...params, priceMin: screener.priceMin, priceMax: screener.priceMax, avgVolMin: screener.avgVolMin, years },
  });
  for (const c of CASES) await putJson(deps.store, signalsKey(runId, c.id), pack(signals.filter((s) => s.case === c.id)));
  await putJson(deps.store, summaryKey(runId), summary);
  // the reversal study (rules searched on year 1, traded on year 2)
  await status({ phase: `Reversal study: ${moments.length.toLocaleString('en-IN')} possible entries` }, true);
  log(`study: ${moments.length} moments`);
  const study = analyze(moments, { runId, createdAt: now(), period: { from, to, mid } });
  await putJson(deps.store, studyKey(runId), study);
  // every possible entry, so rules written later (by Claude) are tested on exactly this data
  for (const dir of [1, -1] as const) await deps.store.put(momentsKey(runId, dir), await gzipBytes(encodeMoments(moments, dir)));
  const index = (await getJson<RunIndexItem[]>(deps.store, INDEX_KEY)) ?? [];
  const item: RunIndexItem = { runId, createdAt: summary.createdAt, period: summary.period, signals: signals.length, symbols: plan.length };
  await putJson(deps.store, INDEX_KEY, [item, ...index.filter((x) => x.runId !== runId)].slice(0, 36));
  if (grid) {
    grid.close({ runId, from: fromAll, to, mid, riskInr: params.riskInr });
    log(`algo lab: ${grid.rows} rows written`);
    // the Python step trains the models next; scripts/ml-upload.ts finishes the run
    await putJson(deps.store, STATUS_KEY, { runId, state: 'running', phase: `Algo Lab: training the models on ${grid.rows.toLocaleString('en-IN')} moments (walk-forward)`, startedAt, updatedAt: now() } satisfies RunStatus);
  } else {
    await putJson(deps.store, STATUS_KEY, { runId, state: 'done', startedAt, updatedAt: now(), finishedAt: now(), message: `${signals.length} past trades across ${plan.length} stocks` } satisfies RunStatus);
  }
  return { summary, signals };
}
