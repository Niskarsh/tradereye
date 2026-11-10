import { DhanError, parseScripMaster, SCRIP_MASTER_URL, type Candles, type DhanClient } from '../dhan';
import { toSessions, type Session } from '../live/enrich';
import { joinCandles } from '../candles/store';
import { DEFAULT_PARAMS } from '../setups/engine';
import { monthsNeeded } from '../setups/universe';
import { getJson, monthKey, putJson, type RunStatus, type Store } from '../setups/store';
import { NIFTY500 } from '../setups/job';
import { gridDay } from './grid';
import { GridWriter } from './writer';
import { etfSymbols, inLiveWindow, istDate, istMinute, wideDays, type WideDay } from './wide';

/**
 * Algo Lab iteration 12, step 1: the dataset for the wide universe (lib/ml/wide.ts), written to disk for the model jobs.
 * Its own run: it writes no setups, no study and no run index entry, so My Setups, Backtest vs live and the monthly Algo
 * Live model never see it. 1-minute candles use the same S3 cache as the backtest, so a finished month is fetched once
 * and a run that hits the job's time limit carries on where it stopped when pressed again.
 */
export const WIDE_STATUS_KEY = 'setups/ml/wide-status.json';
export const WIDE_FROM = '2022-01-01';

const DAY = 86400_000, IST = 19800_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dateOf = (sec: number) => new Date(sec * 1000 + IST).toISOString().slice(0, 10);
const lastDayOfMonth = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };

export class LiveWindowError extends Error {
  constructor() { super('Stopped to keep Dhan\'s request limit free for Algo Live (08:40–11:15). Candles fetched so far are saved: press Run again after 11:15.'); }
}

export interface WideDeps {
  store: Store;
  dhan: Pick<DhanClient, 'intraday' | 'daily'> & Partial<Pick<DhanClient, 'profile'>>;
  fetchText: (url: string) => Promise<string>;
  gridDir: string;
  now?: () => number;
  log?: (msg: string) => void;
  /** Dhan allows 5 data requests a second; the job keeps to 4 */
  minGapMs?: number;
  concurrency?: number;
  onlySymbols?: string[];
  from?: string;
  /** keep going between 08:40 and 11:15, at 1 request a second there so Algo Live keeps most of Dhan's limit */
  override?: boolean;
}

/** gap between Dhan requests inside 08:40-11:15 when overridden: Dhan allows 5 a second, this leaves Algo Live 4 */
export const LIVE_WINDOW_GAP_MS = 1000;

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

export async function runWideGrid(runId: string, startedAt: number, deps: WideDeps): Promise<{ rows: number; stocks: number; stockDays: number }> {
  const now = deps.now ?? Date.now, log = deps.log ?? (() => {});
  const gap = deps.minGapMs ?? 250;
  let next = 0, lastStatus = 0;
  // a weekday holiday missing from NSE_HOLIDAYS: from 09:20 one request tells (no Nifty 500 candles today)
  const closed = new Set<string>(), open = new Set<string>();
  let checkAfter = 0;
  const marketOn = async (ms: number): Promise<boolean> => {
    if (!inLiveWindow(ms)) return false;
    const date = istDate(ms);
    if (closed.has(date)) return false;
    if (open.has(date) || !deps.override || istMinute(ms) < 9 * 60 + 20 || ms < checkAfter) return true;
    checkAfter = ms + 5 * 60_000; // an unclear reply: assume open (the safe side) and ask again in 5 minutes
    try {
      const c = await deps.dhan.intraday({ securityId: NIFTY500.securityId, segment: NIFTY500.segment, instrument: NIFTY500.instrument, from: date, to: addDays(date, 1), interval: 1 });
      if (c.t.some((t) => dateOf(t) === date)) { open.add(date); return true; }
      closed.add(date);
      log(`${date}: no Nifty 500 candles after 09:20, the market is closed today: full speed`);
      return false;
    } catch (e) { if (e instanceof DhanError && e.isAuth) throw e; }
    return true;
  };
  const dhanCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const live = await marketOn(now());
      if (live && !deps.override) throw new LiveWindowError();
      const t = now(), at = Math.max(t, next);
      next = at + (live ? LIVE_WINDOW_GAP_MS : gap);
      if (at > t) await new Promise((r) => setTimeout(r, at - t));
      try { return await fn(); }
      catch (e) {
        // Dhan's limit hit (Algo Live may be fetching too): back off, never take a stock out of the run for it
        if (!(e instanceof DhanError && e.isRateLimited) || attempt >= 4) throw e;
        next = now() + 2000 * (attempt + 1);
      }
    }
  };
  const status = async (phase: string, done?: number, total?: number, force = false) => {
    if (!force && now() - lastStatus < 5000) return;
    lastStatus = now();
    await putJson(deps.store, WIDE_STATUS_KEY, { runId, state: 'running', phase, done, total, startedAt, updatedAt: now() } satisfies RunStatus);
  };

  await status('Reading the NSE equity list', undefined, undefined, true);
  const csv = await deps.fetchText(SCRIP_MASTER_URL);
  const master = parseScripMaster(csv), etfs = etfSymbols(csv);
  const all = [...master.entries()].filter(([s, id]) => id && (!deps.onlySymbols || deps.onlySymbols.includes(s)));
  const universe = all.filter(([s]) => !etfs.has(s)).map(([symbol, securityId]) => ({ symbol, securityId }));
  const dropped = all.filter(([s]) => etfs.has(s)).map(([s]) => s).sort();
  log(`equities: ${universe.length} (left out ${dropped.length} ETFs: ${dropped.join(' ')})`);

  const today = new Date(now() + IST).toISOString().slice(0, 10);
  const fromAll = deps.from ?? WIDE_FROM;
  const niftyDaily = await dhanCall(() => deps.dhan.daily({ securityId: NIFTY500.securityId, segment: NIFTY500.segment, instrument: NIFTY500.instrument, from: addDays(fromAll, -70), to: today }));
  const sessions = [...new Set(niftyDaily.t.map(dateOf))].sort();
  const to = sessions.at(-1);
  if (!to) throw new Error('Dhan returned no Nifty 500 daily candles.');

  /**
   * A per-stock reply that reads like "token dead" or "no data plan" stopped the whole run before (10 Nov: one reply 20
   * minutes in, with the plan active). Now Dhan's profile is asked first: only a dead token or a lapsed plan there stops
   * the run; otherwise the reply was about that one request, so it is logged as Dhan sent it and the stock-month skipped.
   */
  let odd = 0, verified = 0;
  const describe = (e: DhanError) => `HTTP ${e.status}${e.code ? ` ${e.code}` : ''}: ${e.message}`;
  const perStock = async (e: unknown, what: string) => {
    if (e instanceof LiveWindowError || !(e instanceof DhanError)) throw e;
    if (!e.isAuth && !e.isNoDataPlan) return;
    log(`${what}: Dhan replied ${describe(e)}`);
    if (deps.dhan.profile && now() - verified > 60_000) {
      let p;
      try { p = await dhanCall(() => deps.dhan.profile!()); }
      catch (pe) { throw pe instanceof DhanError ? new DhanError(pe.status, pe.code, `profile check failed too (${describe(pe)}); the request before: ${describe(e)}`) : pe; }
      const plan = String(p?.dataPlan ?? '').trim();
      const lapsed = (!!plan && !/^(active|subscribed)$/i.test(plan)) || (!!p?.dataValidity && Date.parse(String(p.dataValidity)) < now());
      if (lapsed) throw new DhanError(e.status, 'DH-902', `Dhan's profile says the data plan is "${p?.dataPlan}" (valid till ${p?.dataValidity}). The request: ${describe(e)}`);
      log(`profile: token works, data plan "${p?.dataPlan ?? '?'}" valid till ${p?.dataValidity ?? '?'}: skipping ${what} only`);
      verified = now();
    } else if (!deps.dhan.profile) throw e;
    if (++odd > 25) throw new DhanError(e.status, e.code, `more than 25 requests failed this way although the profile says all is fine; the last: ${describe(e)}`);
  };

  const plan: { symbol: string; securityId: string; days: WideDay[]; daily: Candles }[] = [];
  await pool(universe, deps.concurrency ?? 4, async (u, i) => {
    try {
      const daily = await dhanCall(() => deps.dhan.daily({ securityId: u.securityId, segment: 'NSE_EQ', instrument: 'EQUITY', from: addDays(fromAll, -1150), to: today }));
      const days = wideDays(daily, fromAll, to);
      if (days.length) plan.push({ ...u, days, daily });
    } catch (e) { await perStock(e, `${u.symbol} daily`); }
    await status('Daily candles: which stocks are in the wide universe', i + 1, universe.length);
  });
  plan.sort((a, b) => a.symbol.localeCompare(b.symbol));
  log(`wide universe: ${plan.length} stocks, ${plan.reduce((a, p) => a + p.days.length, 0)} stock-days`);

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

  const niftyByDate = new Map<string, Session>();
  for (const m of monthsNeeded(sessions.filter((d) => d >= fromAll && d <= to))) {
    for (const s of toSessions(await loadMonth(NIFTY500, m))) niftyByDate.set(s.date, s);
    await status('Nifty 500 1-minute history');
  }

  const grid = new GridWriter(deps.gridDir, ['inNarrow']);
  let done = 0, stockDays = 0, skipped = 0;
  await pool(plan, deps.concurrency ?? 4, async (p) => {
    const parts: Candles[] = [];
    for (const m of monthsNeeded(p.days.map((d) => d.date))) {
      try { parts.push(await loadMonth({ symbol: p.symbol, securityId: p.securityId, segment: 'NSE_EQ', instrument: 'EQUITY' }, m)); }
      catch (e) { await perStock(e, `${p.symbol} ${m}`); skipped++; }
    }
    const sess = toSessions(joinCandles(parts));
    const byDate = new Map(sess.map((s, i) => [s.date, i]));
    const dailyDates = p.daily.t.map(dateOf);
    for (const { date, narrow } of p.days) {
      const i = byDate.get(date), n = niftyByDate.get(date);
      if (i === undefined || !n) { skipped++; continue; }
      const cut = dailyDates.findIndex((x) => x >= date), end = cut < 0 ? dailyDates.length : cut;
      const daily: Candles = { t: p.daily.t.slice(0, end), o: p.daily.o.slice(0, end), h: p.daily.h.slice(0, end), l: p.daily.l.slice(0, end), c: p.daily.c.slice(0, end), v: p.daily.v.slice(0, end) };
      grid.add(p.symbol, date, gridDay({ date, history: sess.slice(Math.max(0, i - 20), i), day: sess[i].bars, nifty: n.bars, daily, riskInr: DEFAULT_PARAMS.riskInr, pocRows: DEFAULT_PARAMS.pocRows, wide: true }), [narrow ? 1 : 0]);
      stockDays++;
    }
    done++;
    await status('Building the dataset', done, plan.length);
  });
  grid.close({ runId, from: fromAll, to, mid: to, riskInr: DEFAULT_PARAMS.riskInr });
  log(`dataset: ${grid.rows} rows, ${stockDays} stock-days (skipped ${skipped})`);
  await putJson(deps.store, WIDE_STATUS_KEY, { runId, state: 'running', phase: `Training the models on ${grid.rows.toLocaleString('en-IN')} moments (a few hours)`, startedAt, updatedAt: now() } satisfies RunStatus);
  return { rows: grid.rows, stocks: plan.length, stockDays };
}
