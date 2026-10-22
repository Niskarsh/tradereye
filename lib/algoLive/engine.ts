import { DhanClient, DhanError, parseScripMaster, SCRIP_MASTER_URL, type Candles } from '../dhan';
import { toSessions, type Bar, type Session } from '../live/enrich';
import { getJson, putJson, type Store } from '../setups/store';
import { SCREENER } from '../setups/universe';
import { sizeFor } from '../setups/costs';
import { onTick, TICK } from '../study/mine';
import { dailyBefore, factsAt, hasMinute } from './features';
import { addRanks, MODEL_KEY, predictVector, vectorOf, type LiveModel } from './model';
import type { ScalerOrder, ScalerStatus } from './scaler';

/**
 * Algo Live: the day, step by step (driven by the Algo Live page; everything is saved in S3 under setups/live/<date>/).
 *
 *  1. the day list (any time before the open): every NSE equity that passes the backtest's screener today, exactly as
 *     lib/setups/universe.ts screenerDays: previous close ₹250-340 and 10-day average volume above 5 lakh shares.
 *     A quote for every equity narrows it to those near the range; their daily candles decide.
 *  2. preparation: for each stock on the list, its daily candles (from the same start as the backtest) and its last 20
 *     sessions of 1-minute candles, saved once (the facts need them at every close).
 *  3. at each 10-minute close (09:25 for the shortlist, 09:35-10:55 to trade): today's 1-minute candles of every stock,
 *     the facts by the backtest's own code, the ranks across the list, the model's prediction; at 09:35-10:55 the
 *     first two that clear the bar (stronger first within a close) are shorted, unless vetoed.
 */

export const NIFTY = { securityId: '19', segment: 'IDX_I', instrument: 'INDEX' };
/** the backtest's daily candles start 1150 days before 1 Jan 2022 (lib/setups/job.ts): the same start keeps the daily 200 EMA identical */
export const DAILY_FROM = '2018-11-08';
const IST = 19800_000;
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
export const istNow = (ms = Date.now()) => { const t = new Date(ms + IST); return { date: t.toISOString().slice(0, 10), min: t.getUTCHours() * 60 + t.getUTCMinutes(), sec: t.getUTCSeconds() }; };
export const slotTime = (k: number) => { const m = 555 + k; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

/** the shortlist close (09:25) and the trading closes (09:35 ... 10:55) */
export const SHORTLIST_SLOT = 10;
/** an order is sent only if its close was at most this many minutes ago (the backtest enters at the close) */
export const MAX_LATE_MIN = 4;
/** the order-book recorder watches at most this many stocks */
export const RECORD_MAX = 50;

export interface ListItem { symbol: string; securityId: string; prevClose: number; avgVol: number }
export interface StockPrep { symbol: string; securityId: string; daily: Candles; history: Candles }
export interface Scored { symbol: string; pred: number | null; price?: number; adr?: number; above: boolean; note?: string }
export interface OrderRec {
  symbol: string; securityId: string; slot: number; pred: number; price: number; adr: number; qty: number; stop: number; target: number;
  correlationId: string; sentAt: number; orderId?: string; status: string; error?: string; avgPrice?: number;
}
export interface TickLog { slot: number; at: number; scored: Scored[]; picked: string[]; note: string; missing: string[] }
export interface DayState {
  v: 1; date: string; list: ListItem[]; listAt?: number; candidates?: number; prepared: string[];
  vetoes: string[]; armed: boolean; ticks: Record<string, TickLog>; orders: OrderRec[]; log: { at: number; msg: string }[];
  model?: { month: string; threshold: number | null; standAside: boolean; createdAt: number };
}

const stateKey = (date: string) => `setups/live/${date}/state.json`;
const stockKey = (date: string, sym: string) => `setups/live/${date}/stock/${sym.replace(/[^A-Za-z0-9&_-]/g, '_')}.json.gz`;

export async function loadState(store: Store, date: string): Promise<DayState> {
  return (await getJson<DayState>(store, stateKey(date))) ?? { v: 1, date, list: [], prepared: [], vetoes: [], armed: false, ticks: {}, orders: [], log: [] };
}
export async function saveState(store: Store, s: DayState): Promise<void> {
  s.log = s.log.slice(-300);
  await putJson(store, stateKey(s.date), s);
}
export const note = (s: DayState, msg: string) => { s.log.push({ at: Date.now(), msg }); };

let modelCache: { at: number; m: LiveModel } | null = null;
export async function loadModel(store: Store): Promise<LiveModel | undefined> {
  if (modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache.m;
  const m = await getJson<LiveModel>(store, MODEL_KEY);
  if (m) modelCache = { at: Date.now(), m };
  return m;
}

class Gate { private next = 0; constructor(private gap: number) {} async wait() { const now = Date.now(), at = Math.max(now, this.next); this.next = at + this.gap; if (at > now) await new Promise((r) => setTimeout(r, at - now)); } }
async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r2 = (x: number) => Math.round(x * 100) / 100;

/* ---- 1. the day list -------------------------------------------------------------------------------------- */

/** every NSE equity whose quote is anywhere near the price range (the daily candles decide in `screen`) */
export async function candidates(dhan: DhanClient, clientId: string, fetchText: (u: string) => Promise<string> = async (u) => (await fetch(u)).text()): Promise<{ symbol: string; securityId: string }[]> {
  const master = parseScripMaster(await fetchText(SCRIP_MASTER_URL));
  const byId = new Map([...master.entries()].map(([s, id]) => [id, s]));
  const ids = [...byId.keys()].filter(Boolean);
  const out: { symbol: string; securityId: string }[] = [];
  const lo = SCREENER.priceMin * 0.9, hi = SCREENER.priceMax * 1.1;
  for (let i = 0; i < ids.length; i += 1000) {
    if (i) await sleep(1100); // the quote API allows one call a second
    const q = await dhan.ohlc(clientId, 'NSE_EQ', ids.slice(i, i + 1000));
    for (const [id, x] of q) if ([x.close, x.last, x.open].some((p) => p >= lo && p <= hi)) out.push({ symbol: byId.get(id)!, securityId: id });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** the backtest's screener for `date` on daily candles that end before it */
export function passes(daily: Candles, date: string): { prevClose: number; avgVol: number } | undefined {
  const d = dailyBefore(daily, date), n = d.c.length;
  if (n < 10) return undefined;
  const pc = d.c[n - 1];
  let v = 0;
  for (let j = n - 10; j < n; j++) v += d.v[j];
  return pc >= SCREENER.priceMin && pc <= SCREENER.priceMax && v / 10 > SCREENER.avgVolMin ? { prevClose: pc, avgVol: Math.round(v / 10) } : undefined;
}

/** daily candles of some candidates; those that pass go on the list and their history is saved for the day */
export async function screen(dhan: DhanClient, store: Store, date: string, items: { symbol: string; securityId: string }[]): Promise<{ passed: ListItem[]; failed: string[] }> {
  const gate = new Gate(260);
  const passed: ListItem[] = [], failed: string[] = [];
  await pool(items, 3, async (u) => {
    try {
      await gate.wait();
      const daily = await dhan.daily({ securityId: u.securityId, segment: 'NSE_EQ', instrument: 'EQUITY', from: DAILY_FROM, to: date });
      const p = passes(daily, date);
      if (!p) return;
      await gate.wait();
      const hist = await dhan.intraday({ securityId: u.securityId, segment: 'NSE_EQ', instrument: 'EQUITY', from: addDays(date, -45), to: addDays(date, -1), interval: 1 });
      const sessions = toSessions(hist).filter((s) => s.date < date).slice(-20);
      const bars = sessions.flatMap((s) => s.bars);
      const history: Candles = { t: bars.map((b) => b.t), o: bars.map((b) => b.o), h: bars.map((b) => b.h), l: bars.map((b) => b.l), c: bars.map((b) => b.c), v: bars.map((b) => b.v) };
      await putJson(store, stockKey(date, u.symbol), { symbol: u.symbol, securityId: u.securityId, daily: dailyBefore(daily, date), history } satisfies StockPrep);
      passed.push({ symbol: u.symbol, securityId: u.securityId, ...p });
    } catch (e) {
      if (e instanceof DhanError && (e.isAuth || e.isNoDataPlan)) throw e;
      failed.push(u.symbol);
    }
  });
  return { passed, failed };
}

/** the list for the order-book recorder: all of it, or the 50 busiest if more passed */
export function recordList(list: ListItem[]): string[] {
  const top = list.length > RECORD_MAX ? [...list].sort((a, b) => b.avgVol - a.avgVol).slice(0, RECORD_MAX) : list;
  return top.map((x) => x.symbol).sort();
}

/* ---- 3. a 10-minute close ------------------------------------------------------------------------------------ */

const toBars = (c: Candles): Bar[] => c.t.map((t, i) => ({ t, o: c.o[i], h: c.h[i], l: c.l[i], c: c.c[i], v: c.v[i] }));

export interface ScoreResult { scored: Scored[]; missing: string[]; facts: Map<string, Record<string, number>>; preps: Map<string, StockPrep> }

/** today's facts and the model's prediction for every stock on the list at slot k */
export async function scoreAt(dhan: DhanClient, store: Store, model: LiveModel, date: string, list: ListItem[], k: number): Promise<ScoreResult> {
  const preps = new Map<string, StockPrep>();
  await pool(list, 8, async (it) => { const p = await getJson<StockPrep>(store, stockKey(date, it.symbol)); if (p) preps.set(it.symbol, p); });
  const gate = new Gate(260);
  const fetchToday = async (x: { securityId: string; segment: string; instrument: string }) => { await gate.wait(); return toBars(await dhan.intraday({ ...x, from: date, to: date, interval: 1 })); };
  let nifty: Bar[] = [];
  const today = new Map<string, Bar[]>();
  const load = async (syms: string[]) => {
    await pool(syms, 3, async (s) => {
      const p = preps.get(s);
      if (!p) return;
      try { today.set(s, await fetchToday({ securityId: p.securityId, segment: 'NSE_EQ', instrument: 'EQUITY' })); } catch (e) { if (e instanceof DhanError && e.isAuth) throw e; }
    });
  };
  const want = list.map((x) => x.symbol).filter((s) => preps.has(s));
  nifty = await fetchToday(NIFTY);
  await load(want);
  // Dhan serves a minute a few seconds after it closes: fetch again the ones whose last minute is not in yet
  for (let attempt = 0; attempt < 3; attempt++) {
    const late = want.filter((s) => !hasMinute(today.get(s) ?? [], k));
    const niftyLate = !hasMinute(nifty, k);
    if (!late.length && !niftyLate) break;
    await sleep(4000);
    if (niftyLate) nifty = await fetchToday(NIFTY);
    await load(late);
  }
  const facts = new Map<string, Record<string, number>>();
  const missing: string[] = [];
  for (const s of want) {
    const p = preps.get(s)!, bars = today.get(s);
    // a quiet stock may simply not have traded in the last minute (the backtest fills such minutes flat, and so does
    // gridDay here); one with nothing in the last 3 minutes is left out
    if (!bars?.length || !(hasMinute(bars, k) || hasMinute(bars, k - 1) || hasMinute(bars, k - 2))) { missing.push(s); continue; }
    const history: Session[] = toSessions(p.history).filter((x) => x.date < date).slice(-20);
    const f = factsAt({ date, history, today: bars, nifty, daily: p.daily }, k);
    if (f) facts.set(s, f);
    else missing.push(s);
  }
  const syms = [...facts.keys()];
  const rows = syms.map((s) => ({ ...facts.get(s)! }));
  addRanks(rows, model.ranked);
  const scored: Scored[] = rows.map((x, i) => {
    const pred = predictVector(model, vectorOf(model, x));
    const daily = preps.get(syms[i])!.daily, n = daily.c.length;
    const adr = daily.h.slice(-10).reduce((a, h, j) => a + h - daily.l[n - 10 + j], 0) / 10;
    return { symbol: syms[i], pred: Math.round(pred * 10000) / 10000, price: x.priceRs, adr: r2(adr), above: model.threshold !== null && pred > model.threshold };
  });
  for (const s of list.map((x) => x.symbol)) if (!facts.has(s)) scored.push({ symbol: s, pred: null, above: false, note: preps.has(s) ? 'no facts at this close' : 'not prepared' });
  scored.sort((a, b) => (b.pred ?? -9) - (a.pred ?? -9));
  return { scored, missing, facts, preps };
}

/** an order is still taking (or took) one of the day's places unless it was rejected or cancelled before it filled */
export const counts = (o: OrderRec) => !['REJECTED', 'ERROR', 'CANCELLED', 'NOT_SENT'].includes(o.status);

/**
 * The picks at a close: the bar cleared, not vetoed, not traded today, at most `cap` a day in all; within one close the
 * stronger prediction first (the backtest's first come, first served).
 */
export function pick(model: LiveModel, state: DayState, scored: Scored[], k: number): Scored[] {
  if (model.standAside || model.threshold === null) return [];
  if (k < model.rules.firstSlot || k > model.rules.lastSlot) return [];
  const used = new Set(state.orders.filter(counts).map((o) => o.symbol));
  const tried = new Set(state.orders.map((o) => o.symbol));
  const free = model.rules.cap - used.size;
  if (free <= 0) return [];
  const veto = new Set(state.vetoes);
  return scored.filter((x) => x.above && x.pred !== null && !veto.has(x.symbol) && !tried.has(x.symbol)).sort((a, b) => b.pred! - a.pred!).slice(0, free);
}

/** the short as the backtest takes it: stop ½ the usual daily range above the close, target ½ below, ₹300 risk */
export function orderFor(model: LiveModel, x: Scored, date: string, k: number, securityId: string): Omit<OrderRec, 'sentAt' | 'status'> {
  const price = x.price!, adr = x.adr!;
  const stop = onTick(price + model.rules.stopAdr * adr, 1), target = onTick(price - model.rules.targetAdr * adr, -1);
  const entry = price - TICK; // a market order fills about a tick worse than the close
  const qty = sizeFor(model.rules.riskInr, stop - entry);
  const correlationId = `te-${date.replace(/-/g, '')}-${x.symbol.replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 30);
  return { symbol: x.symbol, securityId, slot: k, pred: x.pred!, price, adr, qty, stop, target, correlationId };
}

export const toScaler = (o: OrderRec): ScalerOrder => ({ symbol: o.symbol, securityId: o.securityId, qty: o.qty, targetPrice: o.target, stopLossPrice: o.stop, correlationId: o.correlationId });

/** brings the day's orders up to date from trading-scaler's view of Dhan */
export function reconcile(state: DayState, st: ScalerStatus): void {
  for (const o of state.orders) {
    const s = st.orders.find((x) => x.correlationId === o.correlationId);
    if (!s) continue;
    o.orderId = s.orderId || o.orderId;
    o.status = s.orderStatus;
    if (s.avgPrice) o.avgPrice = s.avgPrice;
    if (s.error) o.error = s.error;
  }
}
