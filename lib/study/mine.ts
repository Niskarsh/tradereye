import type { Candles } from '../dhan';
import { tenMinuteBars, type Bar, type Session } from '../live/enrich';
import { istParts, SESSION_OPEN_MIN } from '../live/time';
import { hasSuspectGap, nMinuteBars, pointOfControl } from '../copilot/features';
import { Atr, Ema, Zone, barOf, median, toSlots, valueArea, type B10 } from '../setups/engine';
import { roundTripCharges, sizeFor } from '../setups/costs';

/**
 * The reversal study, step 1: every moment that COULD have been a reversal entry, labelled with what happened next
 * and described by what was visible at that moment. No rule is decided in advance: the moments are taken loosely,
 * and the analysis (analyze.ts) finds which of the facts separate the clean winners from the failures.
 *
 * A candidate (long; shorts are the mirror) = any 10-minute close from 09:25 to 14:55 where:
 *  - the stock is down from the open (its day low is at least 0.2 of its usual daily range below the open),
 *  - price is still below VWAP (there is a move left to capture) and within 1.5 ATR of the day's low.
 * The trade it is scored as: entry at that close, stop 0.1 ATR beyond the day's low so far (at least 0.25 ATR, more
 * than 2 ATR away = not a candidate), two targets tracked separately: VWAP (as it stood at entry) and the day's open.
 * Labels per target:
 *  CLEAN  the target was reached before the stop (a stop under the low survived),
 *  MESSY  the stop was hit first, but price still reached the target before 15:00,
 *  FAIL   the target was not reached by 15:00 (whatever the stop did).
 * R before / after Dhan's charges at his risk for the "stop at the low" trade, plus the same trade with a 2 ATR stop.
 */

export const FEATURES = [
  ['runAdr', 'How far the day\'s low is from the open (× usual daily range)'],
  ['runPct', 'How far the day\'s low is from the open (%)'],
  ['offExtAtr', 'How far price has come back off the low (ATR)'],
  ['toVwapAtr', 'Room to VWAP (ATR)'],
  ['toOpenAtr', 'Room to the open (ATR)'],
  ['stopAtr', 'Stop distance: entry to beyond the low (ATR)'],
  ['rrVwap', 'Room to VWAP ÷ stop distance'],
  ['rrOpen', 'Room to the open ÷ stop distance'],
  ['minSinceExt', 'Minutes since the low was made'],
  ['minute', 'Minutes since 09:15'],
  ['gapRun', 'Gap the way of the fall (%)'],
  ['rangeAdr', 'Day range so far (× usual daily range)'],
  ['run30Atr', 'Move the way of the fall in the last 30 min (ATR)'],
  ['runCandles', '10-min candles in a row closing the way of the fall (before this one)'],
  ['tBody', 'This candle\'s body your way (÷ its range)'],
  ['tWick', 'This candle\'s wick at the low (÷ its range)'],
  ['tClosePos', 'Where this candle closed in its range (1 = your end)'],
  ['tRangeAtr', 'This candle\'s range (ATR)'],
  ['tBeyondPrev', 'This candle closed beyond the previous candle\'s high (low for shorts): 1 / 0'],
  ['tVsPrevAtr', 'Close vs the previous close, your way (ATR)'],
  ['tVol', 'This candle\'s volume ÷ normal 10-min volume'],
  ['volTrend', 'Last two candles\' volume ÷ the two before'],
  ['climax3', 'Biggest of the last 3 candles\' volume ÷ normal'],
  ['rvolSame', 'Volume so far ÷ usual at this time'],
  ['rvolDay', 'TradingView relative volume (so far ÷ full-day average)'],
  ['tests', 'Tests of the day\'s low so far'],
  ['extInT', 'The low was made in this candle: 1 / 0'],
  ['nFirst5', 'Nifty 500 first 5 min, your way (%)'],
  ['nDay', 'Nifty 500 open → now, your way (%)'],
  ['nRecent', 'Nifty 500 last 30 min, your way (%)'],
  ['nOffExt', 'Nifty 500 off its own day low, your way (%)'],
  ['rsRun', 'Stock weaker than Nifty since the open (%, the way of the fall)'],
  ['ema10Atr', '10-min 200 EMA vs price, your way (ATR; + = above you as a target)'],
  ['ema5Atr', '5-min 200 EMA vs price, your way (ATR)'],
  ['ema1dAtr', 'Daily 200 EMA vs price, your way (ATR)'],
  ['pdAtr', 'Day low vs previous day low (ATR; − = broke below it)'],
  ['vaAtr', 'Day low vs yesterday\'s value area low (ATR; − = below it)'],
  ['pocAtr', 'Today\'s POC vs price, your way (ATR)'],
  ['openBusy', 'Rvol above 0.1 at 09:20: 1 / 0'],
  ['atrPct', '10-min ATR (% of price)'],
  ['adrPct', 'Usual daily range (% of price)'],
  ['prevDayRun', 'Yesterday\'s move the way of the fall (%)'],
] as const;
export type FeatureKey = typeof FEATURES[number][0];
export const FEATURE_KEYS = FEATURES.map((f) => f[0]) as FeatureKey[];

export type Label = 'C' | 'M' | 'F';
export interface Moment {
  symbol: string; date: string; slot: number; dir: 1 | -1;
  entry: number; stop: number; vwap: number; open: number;
  /** facts at that moment, in FEATURE_KEYS order (NaN = unknown) */
  x: number[];
  /** per target (VWAP, open): label, R before charges, R after charges (stop at the low), R after charges (2 ATR stop) */
  v: { label: Label; r: number; net: number; netWide: number; min: number };
  o: { label: Label; r: number; net: number; netWide: number; min: number };
}

export interface MineInput {
  symbol: string; date: string; history: Session[]; day: Bar[]; nifty: Bar[]; daily: Candles; riskInr?: number; pocRows?: number;
}

const LAST = 340, END = 345;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function mineDay(inp: MineInput): Moment[] {
  const risk = inp.riskInr ?? 300, rows = inp.pocRows ?? 30;
  const day = toSlots(inp.day), nifty = toSlots(inp.nifty);
  if (!day || !nifty || day.n < END) return [];
  const daily = inp.daily, nd = daily.c.length;
  if (nd < 12) return [];
  const hist = inp.history.filter((s) => s.date < inp.date && s.bars.length).slice(-20);
  const atrC = new Atr(), ema10 = new Ema(200), ema5 = new Ema(200), ema1d = new Ema(200);
  for (const b of tenMinuteBars(hist)) { atrC.push(b); ema10.push(b.c); }
  for (const b of nMinuteBars(hist, 5)) ema5.push(b.c);
  if (!hasSuspectGap(daily)) for (const c of daily.c) ema1d.push(c);
  const adr = daily.h.slice(-10).reduce((a, h, i) => a + h - daily.l[nd - 10 + i], 0) / 10;
  const prevClose = daily.c[nd - 1], pdh = daily.h[nd - 1], pdl = daily.l[nd - 1];
  const prevDayRet = (daily.c[nd - 1] / daily.c[nd - 2] - 1) * 100;
  const open = day.o[0], nOpen = nifty.o[0];
  const gapPct = (open / prevClose - 1) * 100;
  if (!(adr > 0) || Math.abs(gapPct) > 20) return [];
  const priors = hist.slice(-10).map((s) => {
    const cum = new Array<number>(376).fill(0);
    for (const b of s.bars) { const k = istParts(b.t * 1000).minuteOfDay - SESSION_OPEN_MIN; if (k >= 0 && k < 375) cum[k + 1] += b.v; }
    for (let k = 1; k <= 375; k++) cum[k] += cum[k - 1];
    return cum;
  }).filter((c) => c[375] > 0);
  if (priors.length < 5) return [];
  const sameAvg = (k: number) => priors.reduce((a, c) => a + c[k], 0) / priors.length;
  const fullAvg = priors.reduce((a, c) => a + c[375], 0) / priors.length;
  const prevSession = hist.at(-1);
  const pva = prevSession ? valueArea(prevSession.bars, rows) : undefined;
  const medBase = tenMinuteBars(hist.slice(-2)).map((b) => b.v);
  const nFirst5 = (nifty.c[4] / nOpen - 1) * 100;

  const tens: B10[] = [];
  const lowZone = new Zone(-1), highZone = new Zone(1);
  let pv = 0, vv = 0, cumV = 0, dayHi = -Infinity, dayLo = Infinity, hiSlot = 0, loSlot = 0, nHi = -Infinity, nLo = Infinity, openBusy = 0;
  let medV = median(medBase);
  const out: Moment[] = [];

  for (let k = 1; k <= LAST; k++) {
    const s = k - 1;
    if (day.h[s] > dayHi) { dayHi = day.h[s]; hiSlot = s; }
    if (day.l[s] < dayLo) { dayLo = day.l[s]; loSlot = s; }
    nHi = Math.max(nHi, nifty.h[s]); nLo = Math.min(nLo, nifty.l[s]);
    cumV += day.v[s];
    if (k === 5) openBusy = cumV / fullAvg > 0.1 ? 1 : 0;
    if ((s + 1) % 10 === 0) {
      const b = barOf(day, s - 9, s + 1);
      tens.push(b); atrC.push(b); ema10.push(b.c);
      pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v;
      medV = median([...medBase, ...tens.map((x) => x.v)]);
      const a = atrC.peek();
      if (a) { lowZone.push(b, s - 9, a); highZone.push(b, s - 9, a); }
    }
    if ((s + 1) % 5 === 0) ema5.push(day.c[s]);
    if (k < 10 || k % 10 !== 0) continue;

    const atr = atrC.peek();
    if (!atr || !(atr > 0) || !(vv > 0)) continue;
    const price = day.c[k - 1], vwap = pv / vv;
    const L = tens.length, T = tens[L - 1], P = tens[L - 2];
    for (const d of [1, -1] as const) {
      const r = -d as 1 | -1;              // the run being faded: down for a long
      const ext = d === 1 ? dayLo : dayHi;
      const run = (ext - open) * r;        // > 0: the extreme is beyond the open the way of the run
      if (run < 0.2 * adr) continue;
      if ((vwap - price) * d <= 0) continue;               // price must still be on the far side of VWAP
      const off = (price - ext) * d;                       // how far price has come back
      if (off > 1.5 * atr) continue;
      let stop = ext - d * 0.1 * atr;
      if ((price - stop) * d < 0.25 * atr) stop = price - d * 0.25 * atr;
      const dist = (price - stop) * d;
      if (dist > 2 * atr) continue;
      const toV = (vwap - price) * d, toO = (open - price) * d;
      let runCandles = 0;
      for (let i = L - 2; i >= 0 && (tens[i].c - tens[i].o) * r > 0; i--) runCandles++;
      const rng = T.h - T.l;
      const wick = rng > 0 ? (d === 1 ? Math.min(T.o, T.c) - T.l : T.h - Math.max(T.o, T.c)) / rng : 0;
      const closePos = rng > 0 ? (d === 1 ? (T.c - T.l) / rng : (T.h - T.c) / rng) : 0.5;
      const e10 = ema10.peek(), e5 = ema5.peek(), e1d = ema1d.peek(price);
      const nNow = nifty.c[k - 1];
      const poc = pointOfControl(day.bars.slice(0, k), rows);
      const zone = d === 1 ? lowZone : highZone;
      const x: Record<FeatureKey, number> = {
        runAdr: run / adr, runPct: (run / open) * 100, offExtAtr: off / atr, toVwapAtr: toV / atr, toOpenAtr: toO / atr,
        stopAtr: dist / atr, rrVwap: toV / dist, rrOpen: toO / dist,
        minSinceExt: k - 1 - (d === 1 ? loSlot : hiSlot), minute: k, gapRun: gapPct * r, rangeAdr: (dayHi - dayLo) / adr,
        run30Atr: k >= 31 ? ((price - day.c[k - 31]) * r) / atr : NaN, runCandles,
        tBody: rng > 0 ? ((T.c - T.o) * d) / rng : 0, tWick: wick, tClosePos: closePos, tRangeAtr: rng / atr,
        tBeyondPrev: P ? ((d === 1 ? T.c > P.h : T.c < P.l) ? 1 : 0) : NaN, tVsPrevAtr: P ? ((T.c - P.c) * d) / atr : NaN,
        tVol: medV > 0 ? T.v / medV : NaN, volTrend: L >= 4 ? (tens[L - 1].v + tens[L - 2].v) / Math.max(1, tens[L - 3].v + tens[L - 4].v) : NaN,
        climax3: medV > 0 ? Math.max(...tens.slice(-3).map((b) => b.v)) / medV : NaN,
        rvolSame: cumV / sameAvg(k), rvolDay: cumV / fullAvg,
        tests: zone.testOf(T, atr) || zone.tests.length, extInT: (d === 1 ? loSlot : hiSlot) >= k - 10 ? 1 : 0,
        nFirst5: nFirst5 * d, nDay: (nNow / nOpen - 1) * 100 * d, nRecent: k >= 31 ? (nNow / nifty.c[k - 31] - 1) * 100 * d : NaN,
        nOffExt: d === 1 ? (nNow / nLo - 1) * 100 : (1 - nNow / nHi) * 100,
        rsRun: ((price / open - 1) - (nNow / nOpen - 1)) * 100 * r,
        ema10Atr: e10 !== undefined ? ((e10 - price) * d) / atr : NaN, ema5Atr: e5 !== undefined ? ((e5 - price) * d) / atr : NaN,
        ema1dAtr: e1d !== undefined ? ((e1d - price) * d) / atr : NaN,
        pdAtr: ((ext - (d === 1 ? pdl : pdh)) * d) / atr, vaAtr: pva ? ((ext - (d === 1 ? pva.val : pva.vah)) * d) / atr : NaN,
        pocAtr: poc !== undefined ? ((poc - price) * d) / atr : NaN, openBusy, atrPct: (atr / price) * 100, adrPct: (adr / price) * 100,
        prevDayRun: prevDayRet * r,
      };
      out.push({
        symbol: inp.symbol, date: inp.date, slot: k, dir: d, entry: r2(price), stop: r2(stop), vwap: r2(vwap), open: r2(open),
        x: FEATURE_KEYS.map((f) => (Number.isFinite(x[f]) ? r3(x[f]) : NaN)),
        v: follow(day, k, d, price, stop, vwap, atr, risk), o: follow(day, k, d, price, stop, open, atr, risk),
      });
    }
  }
  return out;
}

/** What happened next for one target: stop at the low (checked first in each minute) and a 2 ATR stop. */
function follow(day: NonNullable<ReturnType<typeof toSlots>>, k: number, d: 1 | -1, entry: number, stop: number, target: number, atr: number, risk: number) {
  const dist = (entry - stop) * d, wide = entry - d * 2 * atr;
  let stopAt = -1, targetAt = -1, wideAt = -1;
  for (let s = k; s < END; s++) {
    const h = day.h[s], l = day.l[s];
    if (stopAt < 0 && (d === 1 ? l <= stop : h >= stop)) stopAt = s;
    if (wideAt < 0 && (d === 1 ? l <= wide : h >= wide)) wideAt = s;
    if (targetAt < 0 && (d === 1 ? h >= target : l <= target)) { targetAt = s; if (stopAt === s) stopAt = s; } // same minute: the stop counts first
    if (targetAt >= 0 && stopAt >= 0 && wideAt >= 0) break;
  }
  const last = day.c[END - 1];
  const label: Label = targetAt >= 0 && (stopAt < 0 || targetAt < stopAt) ? 'C' : targetAt >= 0 ? 'M' : 'F';
  const exit = label === 'C' ? target : stopAt >= 0 ? stop : last;
  const qty = sizeFor(risk, dist);
  const r = ((exit - entry) * d) / dist;
  const net = r - roundTripCharges(qty, entry, exit, d) / (qty * dist);
  const wDist = 2 * atr, wQty = sizeFor(risk, wDist);
  const wExit = targetAt >= 0 && (wideAt < 0 || targetAt < wideAt) ? target : wideAt >= 0 ? wide : last;
  const netWide = ((wExit - entry) * d) / wDist - roundTripCharges(wQty, entry, wExit, d) / (wQty * wDist);
  const end = label === 'C' ? targetAt : stopAt >= 0 ? stopAt : END - 1;
  return { label, r: r2(r), net: r2(net), netWide: r2(netWide), min: end - k + 1 };
}
