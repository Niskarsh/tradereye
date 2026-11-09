import type { BookModel } from './model';
import { computeCharges } from '../live/pnl';

/**
 * The slow read: who has been ahead over the last hour, for someone holding a position. The "right now" label reacts
 * to the book's every change; this one is built ONLY from closed 10-minute candles, so it cannot change between closes.
 *
 * Each close gets up to three votes, over the last 6 closed candles (1 hour):
 *   structure  the last 3 candles' highs and lows against the 3 before them
 *   flow       shares bought vs sold aggressively
 *   VWAP       which side of the day's average price the close is on
 * Two votes the same way = buyers / sellers. To change, the new reading must hold for 2 closes in a row (not the same
 * = two-way). One exception: a close beyond the level the leading side had to defend ends its lead at once.
 */

export interface OpenPosition {
  symbol: string; securityId: string; direction: 'LONG' | 'SHORT'; qty: number; avgCost: number; entryTs: number; stop?: number; target?: number;
  /** already booked on part exits, and the trade's buy and sell values so far (for the charges) */
  realized?: number; buyVal?: number; sellVal?: number;
}

/** The trade's P&L at a price, before and after Dhan's charges (open quantity closed at that price, plus anything already booked). */
export function pnlAt(p: OpenPosition, price: number): { gross: number; net: number } {
  const dir = p.direction === 'LONG' ? 1 : -1;
  const gross = (p.realized ?? 0) + (price - p.avgCost) * dir * p.qty;
  const closeVal = p.qty * price;
  const buy = (p.buyVal ?? (dir === 1 ? p.qty * p.avgCost : 0)) + (dir === -1 ? closeVal : 0);
  const sell = (p.sellVal ?? (dir === -1 ? p.qty * p.avgCost : 0)) + (dir === 1 ? closeVal : 0);
  return { gross: Math.round(gross * 100) / 100, net: Math.round((gross - computeCharges(buy, sell).totalCharges) * 100) / 100 };
}

/** The next 10-minute close after a moment. */
export function nextClose(tMs: number): number { return slotStart(tMs) + 600_000; }

export interface Situation {
  stance: 1 | 0 | -1;
  label: string;
  /** still ahead, but the latest closes no longer agree */
  weakening: boolean;
  /** when the current reading began (the close that confirmed it) */
  since?: number;
  /** not enough closed candles yet: says how many it has */
  building?: string;
  structure: string; flow: string; vwap?: string;
  /** a 10-minute close beyond these changes the reading */
  changeAbove?: number; changeBelow?: number;
  /** with a position: is the reading with it or against it, and how it has gone since the entry */
  forYou?: 'with' | 'against' | 'neutral';
  sinceEntry?: string;
}

interface Bar { t0: number; h: number; l: number; c: number; buy: number; sell: number; atp?: number; firstT: number; lastT: number }

const SLOT = 600_000;
/** a candle with less data than this is skipped (recording started or stopped inside it) */
const MIN_BAR_MS = 5 * 60_000;
const NEED = 4, LOOK = 6;
const FLOW_EDGE = 0.12, VWAP_EDGE = 0.001, STRUCT_EDGE = 0.001;

function slotStart(tMs: number): number {
  const t = Math.floor(tMs / 1000);
  const day = Math.floor((t + 19800) / 86400) * 86400 - 19800;
  const open = day + 9 * 3600 + 15 * 60;
  return (open + Math.floor((t - open) / 600) * 600) * 1000;
}

function buildBars(m: BookModel, closedEnd: number): Bar[] {
  const out = new Map<number, Bar>();
  for (const q of m.quotes) {
    if (q.t >= closedEnd) break;
    if (q.bid === undefined || q.ask === undefined || q.ask <= q.bid) continue;
    const mid = (q.bid + q.ask) / 2, k = slotStart(q.t);
    const b = out.get(k);
    if (!b) out.set(k, { t0: k, h: mid, l: mid, c: mid, buy: 0, sell: 0, atp: q.atp, firstT: q.t, lastT: q.t });
    else { b.h = Math.max(b.h, mid); b.l = Math.min(b.l, mid); b.c = mid; b.lastT = q.t; if (q.atp) b.atp = q.atp; }
  }
  for (const tr of m.trades) {
    const t = tr.t * 1000;
    if (t >= closedEnd) continue;
    const b = out.get(slotStart(t));
    if (b) { b.buy += tr.buy; b.sell += tr.sell; }
  }
  return [...out.values()].filter((b) => b.lastT - b.firstT >= MIN_BAR_MS).sort((a, b) => a.t0 - b.t0);
}

const max = (xs: number[]) => Math.max(...xs), min = (xs: number[]) => Math.min(...xs);
const net = (bars: Bar[]) => { const b = bars.reduce((a, x) => a + x.buy, 0), s = bars.reduce((a, x) => a + x.sell, 0); return b + s > 0 ? (b - s) / (b + s) : 0; };
const heavier = (n: number) => (Math.abs(n) < FLOW_EDGE ? 'buying and selling about even' : `${n > 0 ? 'buyers' : 'sellers'} ${Math.round(((1 + Math.abs(n)) / 2) * 100)}% of the volume`);

interface Votes { raw: 1 | 0 | -1; struct: number; flow: number; vwap: number; tol: number }

function votes(bars: Bar[], i: number, tick: number): Votes {
  const last = bars.slice(i - 2, i + 1), prev = bars.slice(Math.max(0, i - 5), i - 2);
  const c = bars[i].c, tol = Math.max(2 * tick, c * STRUCT_EDGE);
  const hi = max(last.map((b) => b.h)) - max(prev.map((b) => b.h)), lo = min(last.map((b) => b.l)) - min(prev.map((b) => b.l));
  const struct = (lo > tol && hi >= -tol) || (hi > tol && lo >= -tol) ? 1 : (hi < -tol && lo <= tol) || (lo < -tol && hi <= tol) ? -1 : 0;
  const n = net(bars.slice(Math.max(0, i - LOOK + 1), i + 1));
  const flow = n >= FLOW_EDGE ? 1 : n <= -FLOW_EDGE ? -1 : 0;
  const atp = bars[i].atp;
  const vwap = !atp ? 0 : c > atp * (1 + VWAP_EDGE) ? 1 : c < atp * (1 - VWAP_EDGE) ? -1 : 0;
  const sum = struct + flow + vwap;
  return { raw: sum >= 2 ? 1 : sum <= -2 ? -1 : 0, struct, flow, vwap, tol };
}

const STRUCT_TEXT: Record<number, string> = { 1: 'highs and lows rising', [-1]: 'highs and lows falling', 0: 'no clear direction in highs and lows' };

type Base = Omit<Situation, 'forYou' | 'sinceEntry'> & { bars: Bar[] };

function readBars(bars: Bar[], tick: number): Base {
  const n = bars.length;
  if (n < NEED) return { stance: 0, label: 'Building the read', weakening: false, building: `needs ${NEED} closed 10-minute candles, has ${n}`, structure: '', flow: '', bars };
  let cur: 1 | 0 | -1 = 0, since = 0, miss = 0, lastRaw: number | undefined;
  for (let i = NEED - 1; i < n; i++) {
    const v = votes(bars, i, tick), end = bars[i].t0 + SLOT, c = bars[i].c;
    if (i === NEED - 1) { cur = v.raw; since = end; continue; }
    const before = bars.slice(Math.max(0, i - 3), i);
    if ((cur === -1 && c > max(before.map((b) => b.h)) + v.tol) || (cur === 1 && c < min(before.map((b) => b.l)) - v.tol)) { cur = 0; since = end; miss = 0; lastRaw = v.raw; continue; }
    if (v.raw === cur) { miss = 0; lastRaw = v.raw; continue; }
    miss++;
    if (miss >= 2) { const next: 1 | 0 | -1 = lastRaw === v.raw ? v.raw : 0; if (next !== cur) { cur = next; since = end; } miss = 0; }
    lastRaw = v.raw;
  }
  const v = votes(bars, n - 1, tick), recent = net(bars.slice(-2));
  const weakening = cur !== 0 && (v.raw !== cur || recent * cur <= -FLOW_EDGE);
  const label = cur === 0 ? 'Two-way' : `${cur === 1 ? 'Buyers' : 'Sellers'} ahead${weakening ? ', weakening' : ''}`;
  const last3 = bars.slice(-3), last6 = bars.slice(-LOOK);
  const atp = bars[n - 1].atp;
  return {
    stance: cur, label, weakening, since, bars,
    structure: STRUCT_TEXT[v.struct], flow: heavier(net(last6)),
    vwap: atp ? `${v.vwap > 0 ? 'above' : v.vwap < 0 ? 'below' : 'at'} VWAP ${atp.toFixed(2)}` : undefined,
    changeAbove: cur === 1 ? undefined : cur === -1 ? max(last3.map((b) => b.h)) : max(last6.map((b) => b.h)),
    changeBelow: cur === -1 ? undefined : cur === 1 ? min(last3.map((b) => b.l)) : min(last6.map((b) => b.l)),
  };
}

const memo = new WeakMap<BookModel, { key: string; base: Base }>();

export function situation(m: BookModel, now: number, pos?: OpenPosition): Situation {
  const closedEnd = slotStart(now);
  const key = `${closedEnd}|${m.firstEventAt}|${m.trimmedBefore}|${m.tick}`;
  let hit = memo.get(m);
  if (!hit || hit.key !== key) { hit = { key, base: readBars(buildBars(m, closedEnd), m.tick / 100) }; memo.set(m, hit); }
  const { bars, ...out } = hit.base;
  if (!pos || out.building) return out;
  const dir = pos.direction === 'LONG' ? 1 : -1;
  const res: Situation = { ...out, forYou: out.stance === 0 ? 'neutral' : out.stance === dir ? 'with' : 'against' };
  const held = bars.filter((b) => b.t0 + SLOT > pos.entryTs);
  const ltp = m.ltp ?? bars[bars.length - 1]?.c;
  if (ltp === undefined) return res;
  const pct = ((ltp - pos.avgCost) / pos.avgCost) * 100;
  const parts = [`price ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(1)}%`];
  const withAtp = held.filter((b) => b.atp);
  if (withAtp.length) parts.push(`${withAtp.filter((b) => (b.c - b.atp!) * dir > 0).length} of ${withAtp.length} closes on your side of VWAP`);
  let buy = 0, sell = 0;
  for (const tr of m.trades) if (tr.t * 1000 >= pos.entryTs && tr.t * 1000 <= now) { buy += tr.buy; sell += tr.sell; }
  if (buy + sell > 0) parts.push(heavier((buy - sell) / (buy + sell)));
  const first = m.quotes[0]?.t;
  if (first && first > pos.entryTs + SLOT) parts.push(`from ${new Date(first + 19800_000).toISOString().slice(11, 16)}, when recording began`);
  res.sinceEntry = parts.join(' · ');
  return res;
}
