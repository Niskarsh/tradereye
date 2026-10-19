import type { Candles, DhanClient } from '../dhan';
import { MONTHS, gunzip, gzip } from '../book/record';
import { LOOKBACK_CALENDAR_DAYS } from '../live/enrich';

/**
 * Candles for the journal charts, saved in S3 so Dhan is asked only once per stock per day.
 *
 *   candles/1m/2026/october/FSL_2026-10-15.json.gz       that day's 1-minute candles (one file per stock per day)
 *   candles/1m/2026/october/NIFTY500_2026-10-15.json.gz  Nifty 500, same layout, shared by every trade that day
 *   candles/daily/2026/october/FSL_2026-10-15.json.gz    about 2 years of daily candles ENDING on that day
 *
 * The path comes from the stock and the date alone, so nothing has to be written to the sheet to find it.
 * A weekday with no trading (a holiday) gets a small "empty" file, so it is not asked for again.
 * A day is saved only once it is over (after 15:35 IST): a half day is never stored as if it were complete.
 * Past days never change, so files are written once and kept.
 */

export const NIFTY_SYMBOL = 'NIFTY500';
/** Nifty 500 on Dhan (same as NIFTY500 in live/backfill; repeated so this file does not pull in the Sheets code) */
const NIFTY500 = { securityId: '19', segment: 'IDX_I', instrument: 'INDEX' };
const IST = 19800_000;
const DAY = 86400_000;
const CLOSED_MIN = 15 * 60 + 35;
export const DAILY_LOOKBACK_DAYS = 730;
/** how far back the 10-minute chart goes: enough sessions for the 200 EMA to match the co-pilot */
export const MINUTE_LOOKBACK_DAYS = LOOKBACK_CALENDAR_DAYS;
const NIFTY_LOOKBACK_DAYS = 7;

export interface CandleFile { v: 1; kind: '1m' | '1d'; symbol: string; securityId: string; date: string; savedAt: number; empty?: boolean; c: Candles }

export interface Store {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, body: Uint8Array): Promise<void>;
}
type Dhan = Pick<DhanClient, 'intraday' | 'daily'>;
export interface LoadDeps { store: Store; /** absent when no Dhan token was sent: then only saved candles are used */ dhan?: Dhan; lookupSecurityId: (symbol: string) => Promise<string | undefined>; now?: () => number; sleep?: (ms: number) => Promise<void> }

const folder = (kind: '1m' | 'daily', date: string) => {
  const [y, m] = date.split('-');
  return `candles/${kind}/${y}/${MONTHS[Number(m) - 1]}`;
};
export const minuteKey = (symbol: string, date: string) => `${folder('1m', date)}/${symbol.toUpperCase()}_${date}.json.gz`;
export const dailyKey = (symbol: string, date: string) => `${folder('daily', date)}/${symbol.toUpperCase()}_${date}.json.gz`;

const emptyCandles = (): Candles => ({ t: [], o: [], h: [], l: [], c: [], v: [] });
export const istDateOf = (sec: number) => new Date(sec * 1000 + IST).toISOString().slice(0, 10);
const istMinuteOfDay = (ms: number) => { const d = new Date(ms + IST); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Weekdays from `days` calendar days before `date` up to `date`, oldest first. */
export function weekdaysBack(date: string, days: number): string[] {
  const out: string[] = [];
  for (let i = days; i >= 0; i--) {
    const d = addDays(date, -i);
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d);
  }
  return out;
}

/** True once the session of `date` is over (any earlier day, or today after 15:35 IST). */
export function dayIsOver(date: string, nowMs: number): boolean {
  const today = new Date(nowMs + IST).toISOString().slice(0, 10);
  return date < today || (date === today && istMinuteOfDay(nowMs) >= CLOSED_MIN);
}

/** Split candles by IST date. */
export function splitByDate(c: Candles): Map<string, Candles> {
  const out = new Map<string, Candles>();
  for (let i = 0; i < c.t.length; i++) {
    const d = istDateOf(c.t[i]);
    const x = out.get(d) ?? emptyCandles();
    x.t.push(c.t[i]); x.o.push(c.o[i]); x.h.push(c.h[i]); x.l.push(c.l[i]); x.c.push(c.c[i]); x.v.push(c.v[i]);
    out.set(d, x);
  }
  return out;
}

/** Join candle sets, in time order, without duplicates. */
export function joinCandles(parts: Candles[]): Candles {
  const rows: [number, number, number, number, number, number][] = [];
  for (const c of parts) for (let i = 0; i < c.t.length; i++) rows.push([c.t[i], c.o[i], c.h[i], c.l[i], c.c[i], c.v[i]]);
  rows.sort((a, b) => a[0] - b[0]);
  const out = emptyCandles();
  for (const r of rows) {
    if (out.t.length && out.t[out.t.length - 1] === r[0]) continue;
    out.t.push(r[0]); out.o.push(r[1]); out.h.push(r[2]); out.l.push(r[3]); out.c.push(r[4]); out.v.push(r[5]);
  }
  return out;
}

async function readFile(store: Store, key: string, n?: Counts): Promise<CandleFile | undefined> {
  let bytes: Uint8Array | undefined;
  try { bytes = await store.get(key); } catch (e) { if (n) { n.s3Errors++; n.s3Error ??= (e as Error).message; } return undefined; }
  if (!bytes) return undefined;
  try {
    const f = JSON.parse(await gunzip(bytes)) as CandleFile;
    return f && f.v === 1 && f.c && Array.isArray(f.c.t) ? f : undefined;
  } catch { return undefined; } // a broken file is treated as missing and written again
}
/** A failed save never breaks the chart: the data is still shown, and it is fetched again next time. */
async function writeFile(store: Store, key: string, f: CandleFile, n: Counts) {
  try { await store.put(key, await gzip(JSON.stringify(f))); n.saved++; }
  catch (e) { n.s3Errors++; n.s3Error ??= (e as Error).message; }
}

export interface Counts { fromS3: number; fromDhan: number; saved: number; dhanCalls: number; s3Errors: number; s3Error?: string; /** days not saved yet that could not be fetched (no Dhan token) */ notSaved: number }

/** The trade's own day is not saved yet and there is no Dhan token to fetch it. */
export class NeedsDhanError extends Error {
  constructor(public symbol: string, public date: string) { super(`The ${symbol} candles for ${date} are not saved yet. Log in on the Dhan login tab once to fetch them; after that they load without Dhan.`); }
}
interface Instrument { symbol: string; securityId?: string; segment: string; instrument: string }

/**
 * 1-minute candles for every weekday in `days`: from S3 where saved, the rest in ONE Dhan request, then saved
 * (finished days only). `mustTrade` is a day known to have had trading (the trade's own day): it is never marked
 * empty, and an answer that has no candles at all marks nothing empty (it is more likely a Dhan hiccup).
 */
async function minuteDays(deps: LoadDeps, ins: Instrument, days: string[], mustTrade: string | undefined, n: Counts, resolveId: () => Promise<string>): Promise<{ c: Candles; securityId?: string }> {
  const now = (deps.now ?? Date.now)();
  const files = await Promise.all(days.map((d) => readFile(deps.store, minuteKey(ins.symbol, d), n)));
  const have = new Map<string, Candles>();
  let securityId = ins.securityId;
  files.forEach((f, i) => { if (f) { have.set(days[i], f.c); securityId ??= f.securityId || undefined; n.fromS3++; } });
  const missing = days.filter((d) => !have.has(d));
  if (missing.length && !deps.dhan) {
    // no Dhan token: show what is saved; only the trade's own day is a must
    if (mustTrade && missing.includes(mustTrade)) throw new NeedsDhanError(ins.symbol, mustTrade);
    n.notSaved += missing.length;
  } else if (missing.length && deps.dhan) {
    const id = ins.securityId ?? await resolveId();
    securityId = id;
    if (n.dhanCalls) await (deps.sleep ?? sleep)(220); // Dhan allows 5 data requests a second
    n.dhanCalls++;
    const got = splitByDate(await deps.dhan.intraday({ securityId: id, segment: ins.segment, instrument: ins.instrument, from: missing[0], to: missing[missing.length - 1] }));
    const anyData = got.size > 0;
    const writes: Promise<void>[] = [];
    for (const d of missing) {
      const c = got.get(d);
      if (c?.t.length) { have.set(d, c); n.fromDhan++; }
      if (!dayIsOver(d, now)) continue;
      const base = { v: 1 as const, kind: '1m' as const, symbol: ins.symbol, securityId: id, date: d, savedAt: now };
      if (c?.t.length) writes.push(writeFile(deps.store, minuteKey(ins.symbol, d), { ...base, c }, n));
      else if (anyData && d !== mustTrade) writes.push(writeFile(deps.store, minuteKey(ins.symbol, d), { ...base, empty: true, c: emptyCandles() }, n));
    }
    await Promise.all(writes);
  }
  return { c: joinCandles([...have.values()]), securityId };
}

export interface TradeCandles {
  symbol: string; securityId?: string; date: string;
  /** stock 1-minute candles, about 4 weeks up to `date` */
  minute: Candles;
  /** Nifty 500 1-minute candles, the last week up to `date` */
  nifty: Candles;
  /** stock daily candles, about 2 years up to and including `date` (undefined when not asked for) */
  daily?: Candles;
  /** true while `date` is today and the market is still open: nothing of today was saved */
  live: boolean;
  counts: Counts;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Everything the journal charts need for one trade. `parts` limits the work (a day picked on the daily chart only
 * needs its minutes).
 */
export async function loadTradeCandles(deps: LoadDeps, req: { symbol: string; date: string; securityId?: string; parts?: ('minute' | 'nifty' | 'daily')[] }): Promise<TradeCandles> {
  const symbol = req.symbol.trim().toUpperCase();
  const { date } = req;
  const parts = new Set(req.parts ?? ['minute', 'nifty', 'daily']);
  const now = (deps.now ?? Date.now)();
  const n: Counts = { fromS3: 0, fromDhan: 0, saved: 0, dhanCalls: 0, s3Errors: 0, notSaved: 0 };
  let securityId = req.securityId;
  const resolveId = async () => {
    securityId ??= await deps.lookupSecurityId(symbol);
    if (!securityId) throw new Error(`${symbol} is not in Dhan's NSE equity list.`);
    return securityId;
  };
  const stock: Instrument = { symbol, securityId, segment: 'NSE_EQ', instrument: 'EQUITY' };

  let minute = emptyCandles();
  if (parts.has('minute')) {
    const r = await minuteDays(deps, stock, weekdaysBack(date, MINUTE_LOOKBACK_DAYS), date, n, resolveId);
    minute = r.c; securityId ??= r.securityId;
  }
  let nifty = emptyCandles();
  if (parts.has('nifty')) {
    nifty = (await minuteDays(deps, { symbol: NIFTY_SYMBOL, ...NIFTY500 }, weekdaysBack(date, NIFTY_LOOKBACK_DAYS), deps.dhan ? date : undefined, n, async () => NIFTY500.securityId)).c;
  }
  let daily: Candles | undefined;
  if (parts.has('daily')) {
    const key = dailyKey(symbol, date);
    const f = await readFile(deps.store, key, n);
    if (f) { daily = f.c; securityId ??= f.securityId || undefined; n.fromS3++; }
    else if (!deps.dhan) n.notSaved++;
    else {
      const id = await resolveId();
      if (n.dhanCalls) await (deps.sleep ?? sleep)(220);
      n.dhanCalls++;
      // Dhan's toDate is exclusive: the day after, so the trade day's own candle is in
      const c = await deps.dhan.daily({ securityId: id, segment: 'NSE_EQ', instrument: 'EQUITY', from: addDays(date, -DAILY_LOOKBACK_DAYS), to: addDays(date, 1) });
      daily = joinCandles([c]);
      n.fromDhan++;
      const last = daily.t.length ? istDateOf(daily.t[daily.t.length - 1]) : '';
      // saved only when complete: the day is over and Dhan already has its daily candle
      if (dayIsOver(date, now) && last === date) { await writeFile(deps.store, key, { v: 1, kind: '1d', symbol, securityId: id, date, savedAt: now, c: daily }, n); }
    }
  }
  return { symbol, securityId, date, minute, nifty, daily, live: !dayIsOver(date, now), counts: n };
}
