import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DhanError, parseScripMaster, SCRIP_MASTER_URL, type Candles, type DhanClient } from '../dhan';
import { toSessions, type Bar, type Session } from '../live/enrich';
import { joinCandles } from '../candles/store';
import { DEFAULT_PARAMS } from '../setups/engine';
import { monthsNeeded, screenerDays, SCREENER } from '../setups/universe';
import { getJson, monthKey, putJson, type RunStatus, type Store } from '../setups/store';
import { NIFTY500 } from '../setups/job';
import { GridWriter } from './writer';
import { inLiveWindow, istDate, istMinute } from './wide';
import { I17_COLS, I17_PATH_COLS, iter17Day } from './iter17';
import { I17_STATUS_KEY } from './iter17Meta';
import { fetchResultsDays, NIFTY500_LIST_FILE, NIFTY500_LIST_URLS, parseIndexIds, parseIndustries, resultsFlag, sectorPlan } from './iter17Data';

/**
 * Algo Lab iteration 17, step 1: the dataset. The universe, the period and every row are those of the normal backtest's
 * Algo Lab dataset (₹250-340, 10-day average volume 5 lakh+ shares, every 10-min close from 09:25, Jan 2022 on), so the
 * control is iteration 10; the new facts are appended (lib/ml/iter17.ts) and F's trade paths go to paths.bin. Its own run:
 * no setups, no run index entry, so My Setups and the monthly Algo Live model never see it. Candles come from the same S3
 * cache as the backtest.
 */
export const I17_FROM = '2022-01-01';
export { I17_STATUS_KEY, I17_ITERATION, I17_QUESTION } from './iter17Meta';

const DAY = 86400_000, IST = 19800_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dateOf = (sec: number) => new Date(sec * 1000 + IST).toISOString().slice(0, 10);
const lastDayOfMonth = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };

export class LiveWindowError extends Error {
  constructor() { super('Stopped to keep Dhan\'s request limit free for Algo Live (08:40–11:15). Candles fetched so far are saved: press Run again after 11:15.'); }
}

export interface I17Deps {
  store: Store;
  dhan: Pick<DhanClient, 'intraday' | 'daily'> & Partial<Pick<DhanClient, 'profile'>>;
  fetchText: (url: string) => Promise<string>;
  /** for NSE's results calendar (cookies); undefined = no results days */
  fetchImpl?: typeof fetch;
  gridDir: string;
  now?: () => number;
  log?: (msg: string) => void;
  minGapMs?: number;
  concurrency?: number;
  onlySymbols?: string[];
  from?: string;
  override?: boolean;
}

/** what the extra sources gave (written to i17-data.json; shown with the results) */
export interface I17DataNotes {
  sectors: { ok: boolean; source?: string; indices: string[]; missingIndustries: string[]; stocksWithSector: number; stockDaysWithSector: number; stockDays: number; error?: string };
  results: { ok: boolean; meetings: number; stocks: number; flaggedStockDays: number; error?: string };
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

/** F's path records by grid row (Float32: row numbers stay exact below 16.7 million rows) */
class PathWriter {
  private buf: number[] = [];
  rows = 0;
  constructor(private dir: string) { writeFileSync(join(dir, 'paths.bin'), new Uint8Array(0)); }
  add(row: number, rec: number[]) {
    this.buf.push(row, ...rec); this.rows++;
    if (this.buf.length > 200_000) this.flush();
  }
  private flush() {
    if (!this.buf.length) return;
    appendFileSync(join(this.dir, 'paths.bin'), new Uint8Array(new Float32Array(this.buf).buffer));
    this.buf = [];
  }
  close() {
    this.flush();
    writeFileSync(join(this.dir, 'paths.json'), JSON.stringify({ v: 1, cols: I17_PATH_COLS, width: I17_PATH_COLS.length, rows: this.rows }));
  }
}

export async function runIter17Grid(runId: string, startedAt: number, deps: I17Deps): Promise<{ rows: number; stocks: number; stockDays: number; notes: I17DataNotes }> {
  const now = deps.now ?? Date.now, log = deps.log ?? (() => {});
  const gap = deps.minGapMs ?? 250;
  const LIVE_GAP = 1000;
  let next = 0, lastStatus = 0;
  const closed = new Set<string>(), open = new Set<string>();
  let checkAfter = 0;
  const marketOn = async (ms: number): Promise<boolean> => {
    if (!inLiveWindow(ms)) return false;
    const date = istDate(ms);
    if (closed.has(date)) return false;
    if (open.has(date) || !deps.override || istMinute(ms) < 9 * 60 + 20 || ms < checkAfter) return true;
    checkAfter = ms + 5 * 60_000;
    try {
      const c = await deps.dhan.intraday({ securityId: NIFTY500.securityId, segment: NIFTY500.segment, instrument: NIFTY500.instrument, from: date, to: addDays(date, 1), interval: 1 });
      if (c.t.some((t) => dateOf(t) === date)) { open.add(date); return true; }
      closed.add(date);
      return false;
    } catch (e) { if (e instanceof DhanError && e.isAuth) throw e; }
    return true;
  };
  const dhanCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const live = await marketOn(now());
      if (live && !deps.override) throw new LiveWindowError();
      const t = now(), at = Math.max(t, next);
      next = at + (live ? LIVE_GAP : gap);
      if (at > t) await new Promise((r) => setTimeout(r, at - t));
      try { return await fn(); }
      catch (e) {
        if (!(e instanceof DhanError && e.isRateLimited) || attempt >= 4) throw e;
        next = now() + 2000 * (attempt + 1);
      }
    }
  };
  const status = async (phase: string, done?: number, total?: number, force = false) => {
    if (!force && now() - lastStatus < 5000) return;
    lastStatus = now();
    await putJson(deps.store, I17_STATUS_KEY, { runId, state: 'running', phase, done, total, startedAt, updatedAt: now() } satisfies RunStatus);
  };
  const perStock = (e: unknown) => {
    if (e instanceof LiveWindowError || !(e instanceof DhanError)) throw e;
    if (e.isAuth || e.isNoDataPlan) throw e;
  };

  await status('Reading the NSE equity list', undefined, undefined, true);
  const csv = await deps.fetchText(SCRIP_MASTER_URL);
  const master = parseScripMaster(csv);
  const universe = [...master.entries()].filter(([s, id]) => id && (!deps.onlySymbols || deps.onlySymbols.includes(s))).map(([symbol, securityId]) => ({ symbol, securityId }));

  const today = new Date(now() + IST).toISOString().slice(0, 10);
  const fromAll = deps.from ?? I17_FROM;
  const niftyDaily = await dhanCall(() => deps.dhan.daily({ securityId: NIFTY500.securityId, segment: NIFTY500.segment, instrument: NIFTY500.instrument, from: addDays(fromAll, -70), to: today }));
  const sessions = [...new Set(niftyDaily.t.map(dateOf))].sort();
  const to = sessions.at(-1);
  if (!to) throw new Error('Dhan returned no Nifty 500 daily candles.');
  const prevSession = new Map(sessions.map((d, i) => [d, sessions[i - 1]]));

  // sectors: the Nifty 500 list's industries -> NSE sector indices in Dhan's list
  const notes: I17DataNotes = {
    sectors: { ok: false, indices: [], missingIndustries: [], stocksWithSector: 0, stockDaysWithSector: 0, stockDays: 0 },
    results: { ok: false, meetings: 0, stocks: 0, flaggedStockDays: 0 },
  };
  let plan17 = sectorPlan(new Map(), new Map());
  await status('Sectors: the Nifty 500 industries', undefined, undefined, true);
  const lists: [string, () => Promise<string>][] = [
    ...NIFTY500_LIST_URLS.map((u): [string, () => Promise<string>] => [new URL(u).host, () => deps.fetchText(u)]),
    ['the copy in the repo', async () => readFileSync(NIFTY500_LIST_FILE, 'utf8')],
  ];
  for (const [where, read] of lists) {
    try {
      const ind = parseIndustries(await read());
      if (ind.size < 300) throw new Error(`only ${ind.size} stocks in the list`);
      plan17 = sectorPlan(ind, parseIndexIds(csv));
      notes.sectors = { ...notes.sectors, ok: plan17.indices.length > 0, indices: plan17.indices.map((x) => x.name), missingIndustries: plan17.missing, stocksWithSector: plan17.bySymbol.size, error: undefined, source: where };
      if (!plan17.indices.length) notes.sectors.error = 'none of the sector indices was found in Dhan\'s instrument list';
      break;
    } catch (e) { notes.sectors.error = `${where}: ${(e as Error).message}`; }
  }
  log(`sectors: ${notes.sectors.ok ? `${plan17.bySymbol.size} stocks on ${plan17.indices.length} indices (${notes.sectors.indices.join(', ')}); no index for ${plan17.missing.join(', ') || '-'}` : `not available (${notes.sectors.error})`}`);

  // results days: NSE's board-meeting calendar
  let results: Map<string, Set<string>> | undefined;
  if (deps.fetchImpl) {
    await status('Results days: NSE\'s board-meeting calendar', undefined, undefined, true);
    try {
      results = await fetchResultsDays(fromAll, to, deps.fetchImpl, log);
      const meetings = [...results.values()].reduce((a, s) => a + s.size, 0);
      if (meetings < 500) throw new Error(`only ${meetings} results meetings came back`);
      notes.results = { ok: true, meetings, stocks: results.size, flaggedStockDays: 0 };
    } catch (e) { results = undefined; notes.results.error = (e as Error).message; }
  } else notes.results.error = 'not fetched';
  log(`results days: ${notes.results.ok ? `${notes.results.meetings} meetings for ${notes.results.stocks} stocks` : `not available (${notes.results.error}): Arm D runs on the sector alone`}`);

  const plan: { symbol: string; securityId: string; days: string[]; daily: Candles }[] = [];
  await pool(universe, deps.concurrency ?? 4, async (u, i) => {
    try {
      const daily = await dhanCall(() => deps.dhan.daily({ securityId: u.securityId, segment: 'NSE_EQ', instrument: 'EQUITY', from: addDays(fromAll, -1150), to: today }));
      const days = screenerDays(daily, SCREENER, fromAll, to);
      if (days.length) plan.push({ ...u, days, daily });
    } catch (e) { perStock(e); }
    await status('Daily candles: which stocks passed your screener', i + 1, universe.length);
  });
  plan.sort((a, b) => a.symbol.localeCompare(b.symbol));
  log(`screener: ${plan.length} stocks, ${plan.reduce((a, p) => a + p.days.length, 0)} stock-days`);

  const loadMonth = async (ins: { symbol: string; securityId: string; segment: string; instrument: string }, month: string): Promise<Candles> => {
    const key = monthKey(ins.symbol, month);
    const saved = await getJson<{ v: 1; complete: boolean; c: Candles }>(deps.store, key).catch(() => undefined);
    if (saved?.complete) return saved.c;
    const last = lastDayOfMonth(month);
    const c = await dhanCall(() => deps.dhan.intraday({ securityId: ins.securityId, segment: ins.segment, instrument: ins.instrument, from: `${month}-01`, to: last < today ? last : today, interval: 1 }));
    await putJson(deps.store, key, { v: 1, symbol: ins.symbol, securityId: ins.securityId, month, complete: last < today, savedAt: now(), c }).catch(() => {});
    return c;
  };
  const months = monthsNeeded(sessions.filter((d) => d >= fromAll && d <= to));
  const niftyByDate = new Map<string, Session>();
  for (const m of months) {
    for (const s of toSessions(await loadMonth(NIFTY500, m))) niftyByDate.set(s.date, s);
    await status('Nifty 500 1-minute history');
  }
  // the sector indices' 1-minute history (cached like any candles, under IDX-<security id>)
  const sectorBars = new Map<string, Map<string, Bar[]>>();
  for (const [i, ix] of plan17.indices.entries()) {
    const byDate = new Map<string, Bar[]>();
    for (const m of months) {
      try { for (const s of toSessions(await loadMonth({ symbol: `IDX-${ix.securityId}`, securityId: ix.securityId, segment: 'IDX_I', instrument: 'INDEX' }, m))) byDate.set(s.date, s.bars); }
      catch (e) { perStock(e); }
    }
    sectorBars.set(ix.securityId, byDate);
    await status('Sector indices 1-minute history', i + 1, plan17.indices.length, true);
  }

  const grid = new GridWriter(deps.gridDir, I17_COLS);
  const paths = new PathWriter(deps.gridDir);
  let done = 0, stockDays = 0, skipped = 0;
  const withSector = new Set<string>();
  await pool(plan, deps.concurrency ?? 4, async (p) => {
    const parts: Candles[] = [];
    for (const m of monthsNeeded(p.days)) {
      try { parts.push(await loadMonth({ symbol: p.symbol, securityId: p.securityId, segment: 'NSE_EQ', instrument: 'EQUITY' }, m)); }
      catch (e) { perStock(e); skipped++; }
    }
    const sess = toSessions(joinCandles(parts));
    const byDate = new Map(sess.map((s, i) => [s.date, i]));
    const dailyDates = p.daily.t.map(dateOf);
    const sec = plan17.bySymbol.get(p.symbol);
    for (const date of p.days) {
      const i = byDate.get(date), n = niftyByDate.get(date);
      if (i === undefined || !n) { skipped++; continue; }
      const cut = dailyDates.findIndex((x) => x >= date), end = cut < 0 ? dailyDates.length : cut;
      const daily: Candles = { t: p.daily.t.slice(0, end), o: p.daily.o.slice(0, end), h: p.daily.h.slice(0, end), l: p.daily.l.slice(0, end), c: p.daily.c.slice(0, end), v: p.daily.v.slice(0, end) };
      const sector = sec ? sectorBars.get(sec.securityId)?.get(date) : undefined;
      const resDay = results ? resultsFlag(results.get(p.symbol), date, prevSession.get(date)) : NaN;
      const r = iter17Day({ date, history: sess.slice(Math.max(0, i - 20), i), day: sess[i].bars, nifty: n.bars, daily, riskInr: DEFAULT_PARAMS.riskInr, pocRows: DEFAULT_PARAMS.pocRows, sector, resDay, key: `${p.symbol}|${date}` });
      if (!r.rows.length) continue;
      // grid.add is synchronous: the row numbers below are this stock-day's rows
      const first = grid.rows;
      grid.add(p.symbol, date, r.rows);
      if (grid.rows > 16_000_000) throw new Error('more than 16 million rows: paths.bin row numbers would lose precision');
      r.paths.forEach((rec, j) => paths.add(first + r.pathRow[j], rec));
      stockDays++;
      if (sector) { notes.sectors.stockDaysWithSector++; withSector.add(p.symbol); }
      if (resDay === 1) notes.results.flaggedStockDays++;
    }
    done++;
    await status('Building the dataset', done, plan.length);
  });
  grid.close({ runId, from: fromAll, to, mid: to, riskInr: DEFAULT_PARAMS.riskInr });
  paths.close();
  notes.sectors.stockDays = stockDays;
  notes.sectors.stocksWithSector = withSector.size;
  writeFileSync(join(deps.gridDir, 'i17-data.json'), JSON.stringify(notes));
  log(`dataset: ${grid.rows} rows, ${paths.rows} F moments, ${stockDays} stock-days (skipped ${skipped}); sector on ${notes.sectors.stockDaysWithSector} stock-days, results flag on ${notes.results.flaggedStockDays}`);
  await putJson(deps.store, I17_STATUS_KEY, { runId, state: 'running', phase: `Training the models on ${grid.rows.toLocaleString('en-IN')} moments (a few hours)`, startedAt, updatedAt: now() } satisfies RunStatus);
  return { rows: grid.rows, stocks: plan.length, stockDays, notes };
}
