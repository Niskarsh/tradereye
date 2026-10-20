import type { Candles } from '../dhan';
import { deliveryCharges, sizeFor } from './costs';
import { EXIT_KEYS, type CaseId, type Outcome, type Signal, type TargetResult } from './cases';
import type { ScreenerFilter } from './universe';
import type { Params } from './engine';

/**
 * Delivery strategies: daily candles, bought at a day's close, sold at a later close. Long only (a delivery short is
 * not possible). Every trade is sized at his risk per trade from its stop, and Dhan's delivery charges at that size
 * are taken off (no brokerage; STT 0.1% on both sides; DP charge on the sell; see costs.ts).
 *
 *  S1  5-day reversal: down 7%+ in 5 sessions and 4%+ worse than Nifty 500; held 5 sessions; stop 2x daily ATR.
 *  D1  Momentum (Nifty200 Momentum 30 style): each month-end, the 10 stocks with the best 6- and 12-month returns
 *      per unit of volatility; held to the next month-end; stop 3x daily ATR.
 *  D2  Near the 52-week high (George & Hwang): each month-end, the 10 stocks closest to their 52-week high (within
 *      10%); held to the next month-end; stop 3x daily ATR.
 *  D3  RSI(2) pullback in an uptrend (Connors): close above the 200-day average and 2-day RSI under 10; out on the
 *      first close above the 5-day average or after 10 sessions; stop 3x daily ATR.
 *  D4  Trend breakout (Donchian / turtle style): close above the 55-day high and above the 200-day average; out on a
 *      close below the 20-day low or after 60 sessions; stop 2x daily ATR.
 * A stock is only bought when its close is in his price range and its 10-day average volume clears the floor.
 * One open trade per stock and strategy at a time. A gap through the stop exits at that day's open.
 */

const IST = 19800_000;
const dateOf = (sec: number) => new Date(sec * 1000 + IST).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;

export const HOLD_DAYS = 5;

export interface DailyStock { symbol: string; c: Candles; dates: string[]; atr: number[]; idx: Map<string, number> }

export function prepare(symbol: string, daily: Candles): DailyStock {
  const n = daily.c.length;
  const atr: number[] = [];
  for (let i = 0; i < n; i++) {
    const tr = i ? Math.max(daily.h[i] - daily.l[i], Math.abs(daily.h[i] - daily.c[i - 1]), Math.abs(daily.l[i] - daily.c[i - 1])) : daily.h[i] - daily.l[i];
    atr.push(i ? (13 / 14) * atr[i - 1] + tr / 14 : tr);
  }
  const dates = daily.t.map(dateOf);
  return { symbol, c: daily, dates, atr, idx: new Map(dates.map((d, i) => [d, i])) };
}

function tradable(st: DailyStock, i: number, f: ScreenerFilter): boolean {
  const px = st.c.c[i];
  if (!(px >= f.priceMin && px <= f.priceMax) || i < 10) return false;
  let v = 0;
  for (let j = i - 9; j <= i; j++) v += st.c.v[j];
  return v / 10 >= f.avgVolMin;
}
/** a one-day move over 25% in the window = a split / bonus in the data, not a real move */
function clean(st: DailyStock, from: number, to: number): boolean {
  for (let j = Math.max(1, from); j <= to; j++) if (Math.abs(st.c.c[j] / st.c.c[j - 1] - 1) > 0.25) return false;
  return true;
}
const sma = (a: number[], i: number, n: number) => { if (i + 1 < n) return NaN; let s = 0; for (let j = i - n + 1; j <= i; j++) s += a[j]; return s / n; };
function rsi2(c: number[], i: number): number {
  // Wilder RSI(2) over the last ~20 closes
  if (i < 20) return NaN;
  let up = 0, dn = 0;
  for (let j = i - 19; j <= i; j++) {
    const ch = c[j] - c[j - 1];
    const u = Math.max(ch, 0), d = Math.max(-ch, 0);
    if (j === i - 19) { up = u; dn = d; } else { up = (up + u) / 2; dn = (dn + d) / 2; }
  }
  return dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
}

function baseSignal(id: CaseId, st: DailyStock, i: number, stop: number, stretch = 0): Signal {
  const px = st.c.c[i], dist = px - stop;
  return {
    case: id, symbol: st.symbol, date: st.dates[i], slot: 370, dir: 1, entry: r2(px), stop: r2(stop), target: r2(px + 2 * dist),
    stopAtr: r2(dist / st.atr[i]), atr: r2(st.atr[i]), capped: true, stopType: 'ATR2',
    time: '13:00-15:00', nFirst5: 'FLAT', nDay: 'EARLY', nRecent: 'EARLY', rvol: 'NORMAL', openBusy: false,
    stretch: Math.round(stretch), emaInWay: false, gapPct: 0, testNo: 0, tests: [], level: '', pullbackNo: 0, with: [],
  };
}

/**
 * Follow a delivery trade day by day: the stop is checked first each day (a gap below it exits at the open); 1R /
 * 1.5R / 2R targets on the day's high; held (TC) until `exitAt(j)` says so or `maxDays` sessions have passed.
 * Returns the outcome and the index of the exit day.
 */
export function holdOutcome(st: DailyStock, i: number, stop: number, maxDays: number, riskInr: number, exitAt?: (j: number) => boolean): { out: Outcome; exitIdx: number } | undefined {
  const d = st.c, entry = d.c[i], dist = entry - stop;
  if (!(dist > 0) || i + 1 >= d.c.length) return undefined;
  const lv = { T1: entry + dist, T15: entry + 1.5 * dist, TS: entry + 2 * dist };
  const res: Partial<Record<'T1' | 'T15' | 'TS' | 'TC', { exit: number; day: number; target?: boolean }>> = {};
  let mfe = 0, mae = 0, exitIdx = Math.min(d.c.length - 1, i + maxDays);
  for (let j = i + 1; j <= Math.min(d.c.length - 1, i + maxDays); j++) {
    const o = d.o[j], h = d.h[j], l = d.l[j];
    if (l <= stop) {
      const exit = o < stop ? o : stop;
      for (const key of ['T1', 'T15', 'TS', 'TC'] as const) if (!res[key]) res[key] = { exit, day: j - i };
      mae = Math.max(mae, (entry - exit) / dist); exitIdx = j;
      break;
    }
    mfe = Math.max(mfe, (h - entry) / dist); mae = Math.max(mae, (entry - l) / dist);
    for (const key of ['T1', 'T15', 'TS'] as const) if (!res[key] && h >= lv[key]) res[key] = { exit: Math.max(lv[key], o), day: j - i, target: true };
    if (exitAt?.(j)) { res.TC ??= { exit: d.c[j], day: j - i }; exitIdx = j; break; }
  }
  // not enough days left in the data to finish the trade: leave it out (it is still open)
  if (!res.TC && i + maxDays > d.c.length - 1) return undefined;
  const last = d.c[exitIdx];
  const qty = sizeFor(riskInr, dist);
  const one = (key: 'T1' | 'T15' | 'TS' | 'TC'): TargetResult => {
    const x = res[key] ?? { exit: key === 'TC' ? last : res.TC?.exit ?? last, day: res.TC?.day ?? exitIdx - i };
    const r = (x.exit - entry) / dist;
    const net = r2(r - deliveryCharges(qty, entry, x.exit) / (qty * dist));
    return { hit: key === 'TC' ? net > 0 : !!x.target, r: r2(r), net, min: Math.max(1, x.day) * 375 };
  };
  const tc = one('TC');
  const out = { T1: one('T1'), T15: one('T15'), TS: one('TS'), TC: tc, mfe: r2(mfe), mae: r2(Math.min(mae, 3)), costR: r2(deliveryCharges(qty, entry, entry) / (qty * dist)) } as Outcome;
  for (const k of EXIT_KEYS) out[k] = { ...tc }; // no intraday exits on a multi-day hold: the same as holding
  return { out, exitIdx };
}

/** S1, the 5-day reversal, for one stock. */
export function runSwing(symbol: string, daily: Candles, niftyClose: Map<string, number>, from: string, to: string, f: ScreenerFilter, P: Pick<Params, 'riskInr'>): Signal[] {
  const st = prepare(symbol, daily);
  const n = daily.c.length, out: Signal[] = [];
  let busyUntil = -1;
  for (let i = 15; i < n; i++) {
    const d = st.dates[i];
    if (d < from || d > to || i <= busyUntil || !tradable(st, i, f) || !clean(st, i - 5, i)) continue;
    const ret5 = (daily.c[i] / daily.c[i - 5] - 1) * 100;
    const n0 = niftyClose.get(st.dates[i - 5]), n1 = niftyClose.get(d);
    if (n0 === undefined || n1 === undefined) continue;
    if (!(ret5 <= -7 && ret5 - (n1 / n0 - 1) * 100 <= -4)) continue;
    const stop = daily.c[i] - 2 * st.atr[i];
    const h = holdOutcome(st, i, stop, HOLD_DAYS, P.riskInr);
    if (!h) continue;
    const sig = baseSignal('S1', st, i, stop, -ret5);
    sig.out = h.out; busyUntil = h.exitIdx;
    out.push(sig);
  }
  return out;
}

/** D3 and D4: rules on one stock's own candles. */
export function runSingle(st: DailyStock, from: string, to: string, f: ScreenerFilter, P: Pick<Params, 'riskInr'>): Signal[] {
  const d = st.c, n = d.c.length, out: Signal[] = [];
  let busy3 = -1, busy4 = -1;
  for (let i = 200; i < n; i++) {
    const date = st.dates[i];
    if (date < from || date > to || !tradable(st, i, f) || !clean(st, i - 200, i)) continue;
    const ma200 = sma(d.c, i, 200);
    if (!(d.c[i] > ma200)) continue;
    if (i > busy3 && rsi2(d.c, i) < 10) {
      const stop = d.c[i] - 3 * st.atr[i];
      const h = holdOutcome(st, i, stop, 10, P.riskInr, (j) => d.c[j] > sma(d.c, j, 5));
      if (h) { const s = baseSignal('D3', st, i, stop, rsi2(d.c, i)); s.out = h.out; out.push(s); busy3 = h.exitIdx; }
    }
    if (i > busy4 && i >= 56) {
      let hi55 = -Infinity;
      for (let j = i - 55; j < i; j++) hi55 = Math.max(hi55, d.h[j]);
      if (d.c[i] > hi55) {
        const stop = d.c[i] - 2 * st.atr[i];
        const low20 = (j: number) => { let lo = Infinity; for (let k = j - 20; k < j; k++) lo = Math.min(lo, d.l[k]); return lo; };
        const h = holdOutcome(st, i, stop, 60, P.riskInr, (j) => d.c[j] < low20(j));
        if (h) { const s = baseSignal('D4', st, i, stop, (d.c[i] / hi55 - 1) * 100); s.out = h.out; out.push(s); busy4 = h.exitIdx; }
      }
    }
  }
  return out;
}

/**
 * D1 and D2: ranked across all stocks at each month-end, the top 10 bought, held to the next month-end.
 * `monthEnds` = the last trading day of each month (from Nifty 500's sessions).
 */
export function runMonthly(stocks: DailyStock[], monthEnds: string[], from: string, to: string, f: ScreenerFilter, P: Pick<Params, 'riskInr'>, top = 10): Signal[] {
  const out: Signal[] = [];
  for (let m = 0; m < monthEnds.length - 1; m++) {
    const date = monthEnds[m], next = monthEnds[m + 1];
    if (date < from || date > to) continue;
    const cands: { st: DailyStock; i: number; mom?: [number, number]; near?: number }[] = [];
    for (const st of stocks) {
      const i = st.idx.get(date);
      if (i === undefined || i < 253 || !tradable(st, i, f) || !clean(st, i - 252, i)) continue;
      const c = st.c.c;
      let s = 0, s2 = 0;
      for (let j = i - 251; j <= i; j++) { const r = c[j] / c[j - 1] - 1; s += r; s2 += r * r; }
      const vol = Math.sqrt(Math.max(1e-12, s2 / 252 - (s / 252) ** 2)) * Math.sqrt(252);
      const r6 = c[i] / c[i - 126] - 1, r12 = c[i] / c[i - 252] - 1;
      let hi = -Infinity;
      for (let j = i - 251; j <= i; j++) hi = Math.max(hi, st.c.h[j]);
      cands.push({ st, i, mom: r12 > 0 ? [r6 / vol, r12 / vol] : undefined, near: c[i] / hi });
    }
    // D1: average of the two z-scores (6- and 12-month return per unit of volatility)
    const withMom = cands.filter((x) => x.mom);
    const z = (k: 0 | 1) => { const v = withMom.map((x) => x.mom![k]); const mu = v.reduce((a, b) => a + b, 0) / (v.length || 1); const sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / (v.length || 1)) || 1; return (x: number) => (x - mu) / sd; };
    const z6 = z(0), z12 = z(1);
    const d1 = withMom.map((x) => ({ x, score: (z6(x.mom![0]) + z12(x.mom![1])) / 2 })).sort((a, b) => b.score - a.score).slice(0, top);
    const d2 = cands.filter((x) => (x.near ?? 0) >= 0.9).sort((a, b) => (b.near ?? 0) - (a.near ?? 0)).slice(0, top);
    const take = (id: CaseId, x: { st: DailyStock; i: number }, stretch: number) => {
      const stop = x.st.c.c[x.i] - 3 * x.st.atr[x.i];
      const h = holdOutcome(x.st, x.i, stop, 30, P.riskInr, (j) => x.st.dates[j] >= next);
      if (!h) return;
      const s = baseSignal(id, x.st, x.i, stop, stretch); s.out = h.out; out.push(s);
    };
    for (const { x, score } of d1) take('D1', x, score * 10);
    for (const x of d2) take('D2', x, (x.near ?? 0) * 100);
  }
  return out;
}

/** the last trading day of each month in a list of session dates */
export function monthEndsOf(sessions: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < sessions.length; i++) if (i === sessions.length - 1 || sessions[i + 1].slice(0, 7) !== sessions[i].slice(0, 7)) out.push(sessions[i]);
  return out;
}
