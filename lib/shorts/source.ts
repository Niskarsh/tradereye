import type { DhanClient } from '../dhan';
import { lookupSecurityId } from '../dhan';
import { getSheetsClient } from '../sheetsApi';
import { MONTHS } from '../live/time';
import { getChunk, putChunk } from '../book/s3';
import { loadTradeCandles } from '../candles/store';
import { loadState } from '../algoLive/engine';
import { LIVE_FROM } from '../algoLive/fills';
import { liveStore } from '../algoLive/store';
import { dayCandles, stopFor } from './spec';
import {
  istToday, journalShortTrades, mysteryEligible, resultOf, scoreWeek, seasonScore, splitMeAlgo, tradeOfWeek, weekOf,
  type AlgoOrder, type ShortTrade, type WeekScore,
} from './trades';

/** Server-side loading for the shorts: journal trades, Algo Live's orders, and the trade day's candles. */

const MONTH_TAB = new RegExp(`^(${MONTHS.join('|')})-(\\d{4})$`);
const tabMonth = (title: string) => { const m = title.match(MONTH_TAB); return m ? `${m[2]}-${String((MONTHS as readonly string[]).indexOf(m[1]) + 1).padStart(2, '0')}` : ''; };

/** Every closed trade from the monthly tabs whose month lies in [fromMonth, toMonth] ("YYYY-MM"). */
export async function journalTradesBetween(fromMonth: string, toMonth: string): Promise<ShortTrade[]> {
  const sheets = getSheetsClient();
  const tabs = (await sheets.listTabs()).map((t) => t.title).filter((t) => { const m = tabMonth(t); return m && m >= fromMonth && m <= toMonth; });
  if (!tabs.length) return [];
  const reads = await sheets.readTails(tabs.map((title) => ({ title, tail: 5000 })));
  return reads.flatMap((r) => journalShortTrades(r.headers, r.rows));
}

/** What the picker needs to draw the trade with the journal's own chart (fills as BUY / SELL, stops, target). */
export interface ChartInfo { symbol: string; date: string; dir: 'LONG' | 'SHORT'; securityId?: string; initialStop?: string; lastStop?: string; target?: string; fills: { time: string; side: 'BUY' | 'SELL'; qty: number; price: number }[] }
export function chartInfo(t: ShortTrade): ChartInfo {
  const inSide = t.dir === 'LONG' ? 'BUY' : 'SELL', outSide = t.dir === 'LONG' ? 'SELL' : 'BUY';
  const s = (x?: number) => (x === undefined ? undefined : String(x));
  return { symbol: t.symbol, date: t.date, dir: t.dir, securityId: t.securityId, initialStop: s(t.stop), lastStop: s(t.lastStop), target: s(t.target),
    fills: t.fills.map((f) => ({ time: f.time, side: f.kind === 'in' ? inSide : outSide, qty: f.qty, price: f.price })) };
}

export interface MysteryCandidate { id: string; date: string; symbol: string; dir: 'LONG' | 'SHORT'; entryTime: string; holdMin: number; result: { value: number; unit: 'R' | '%' }; chart: ChartInfo; hasStop: boolean }

/** Trades old enough to show with their ticker, newest first. */
export async function mysteryCandidates(now = Date.now()): Promise<MysteryCandidate[]> {
  const trades = await journalTradesBetween('2020-01', istToday(now).slice(0, 7));
  return trades.filter((t) => mysteryEligible(t, now)).reverse()
    .map((t) => ({ id: t.id, date: t.date, symbol: t.symbol, dir: t.dir, entryTime: t.entryTime.slice(0, 5), holdMin: t.holdMin, result: resultOf(t), chart: chartInfo(t), hasStop: stopFor(t) !== null }));
}

export async function findTrade(id: string, date: string): Promise<ShortTrade | undefined> {
  const trades = await journalTradesBetween(date.slice(0, 7), date.slice(0, 7));
  return trades.find((t) => t.id === id);
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
export function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) { const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); if (wd !== 0 && wd !== 6) out.push(d); }
  return out;
}

export async function algoOrders(days: string[]): Promise<AlgoOrder[]> {
  const states = await Promise.all(days.map((d) => loadState(liveStore, d).catch(() => undefined)));
  return days.flatMap((d, i) => (states[i]?.orders ?? []).map((o) => ({ date: d, symbol: o.symbol, sentAt: o.sentAt, risk: o.risk, stop: o.stop, status: o.status, avgPrice: o.avgPrice })));
}

export interface Season {
  weeks: (WeekScore & { meTrade?: ShortTrade; algoTrade?: ShortTrade & { orderRisk?: number } })[];
}

/** Every finished week since Algo Live started (Mon-Fri, the Friday already past), each scored. */
export async function season(now = Date.now()): Promise<Season> {
  const today = istToday(now);
  const firstWeek = weekOf(LIVE_FROM);
  const lastFriday = addDays(weekOf(today), today >= addDays(weekOf(today), 5) ? 4 : -3);
  if (lastFriday < LIVE_FROM) return { weeks: [] };
  const days = weekdays(firstWeek, lastFriday);
  const [trades, orders] = await Promise.all([journalTradesBetween(firstWeek.slice(0, 7), lastFriday.slice(0, 7)), algoOrders(days.filter((d) => d >= LIVE_FROM))]);
  const inRange = trades.filter((t) => t.date >= firstWeek && t.date <= lastFriday);
  const { me, algo } = splitMeAlgo(inRange, orders);
  const weeks: Season['weeks'] = [];
  for (let w = firstWeek; w <= lastFriday; w = addDays(w, 7)) {
    const end = addDays(w, 4);
    const m = me.filter((t) => t.date >= w && t.date <= end), a = algo.filter((t) => t.date >= w && t.date <= end);
    weeks.push({ ...scoreWeek(w, m, a), meTrade: tradeOfWeek(m), algoTrade: tradeOfWeek(a) });
  }
  return { weeks };
}

export function seasonBeforeAfter(weeks: WeekScore[], week: string) {
  const prev = weeks.filter((w) => w.week < week).map((w) => w.week).pop();
  return { before: prev ? seasonScore(weeks, prev) : { me: 0, algo: 0 }, after: seasonScore(weeks, week) };
}

/** The trade day's 1-minute candles: saved ones first, Dhan only when the day is not saved yet and a token was sent. */
export async function tradeDay(t: ShortTrade, dhan?: DhanClient) {
  const r = await loadTradeCandles({ store: { get: getChunk, put: putChunk }, dhan, lookupSecurityId: (s) => lookupSecurityId(s) }, { symbol: t.symbol, date: t.date, parts: ['minute'] });
  return dayCandles(r.minute, t.date);
}

