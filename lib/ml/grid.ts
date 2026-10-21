import type { Candles } from '../dhan';
import { tenMinuteBars, type Bar, type Session } from '../live/enrich';
import { istParts, SESSION_OPEN_MIN } from '../live/time';
import { hasSuspectGap, nMinuteBars, pointOfControl } from '../copilot/features';
import { Atr, Ema, Zone, barOf, median, toSlots, valueArea, type B10 } from '../setups/engine';
import { follow, onTick, TICK } from '../study/mine';
import { roundTripCharges, sizeFor } from '../setups/costs';

/**
 * Algo Lab, step 1: the dataset. For every stock in the universe, on every day, at every 10-minute close from 09:35
 * to 14:45: ~47 facts known at that moment (only candles that closed by then), and what a trade taken right there
 * would have made, long and short, after Dhan's charges and slippage.
 *
 * The trade (the label): entry 1 tick worse than the 10-minute close, stop 1 ATR away, target 1.5 ATR away, both on
 * the tick grid; the target fills only when traded through; stop and target in the same minute = stop; anything open
 * is closed at 15:00. Sized at ₹300 risk. (The same fill rules as the Reversal Study: lib/study/mine.ts follow().)
 *
 * Iteration 2 adds two wider trades (costs are ~0.13% of the position per round trip, so a tight stop pays a big cost
 * tax in R): the wide bracket (stop ½ the usual daily range, target ¾ of it, out by 15:15) and the ride to the close
 * (a safety stop ¾ of the usual daily range, no target, out at 15:15). Each also carries its result before costs.
 *
 * Facts are from the stock's point of view (up = positive), so one model can learn both sides.
 * Cross-sectional ranks (this stock vs every other stock at the same minute) are added in the Python step.
 */

export const ML_FEATURES = [
  ['minute', 'Minutes since 09:15'],
  ['retOpenPct', 'Move since the open (%)'],
  ['retOpenAdr', 'Move since the open (× usual daily range)'],
  ['gapPct', 'Gap at the open (%)'],
  ['prevDayRet', 'Yesterday\'s move (%)'],
  ['ret10Atr', 'Last 10-min candle\'s move (ATR)'],
  ['ret30Atr', 'Move over the last 30 min (ATR)'],
  ['ret60Atr', 'Move over the last 60 min (ATR)'],
  ['distVwapAtr', 'Price vs VWAP (ATR; + = above)'],
  ['distHiAtr', 'Below the day high by (ATR)'],
  ['distLoAtr', 'Above the day low by (ATR)'],
  ['rangeAdr', 'Day range so far (× usual daily range)'],
  ['posInRange', 'Where price is in the day\'s range (0 = low, 1 = high)'],
  ['minSinceHi', 'Minutes since the day high'],
  ['minSinceLo', 'Minutes since the day low'],
  ['testsHi', 'Tests of the day high'],
  ['testsLo', 'Tests of the day low'],
  ['tBody', 'Last candle\'s body (÷ its range; + = green)'],
  ['tUpWick', 'Last candle\'s upper wick (÷ its range)'],
  ['tLoWick', 'Last candle\'s lower wick (÷ its range)'],
  ['tRangeAtr', 'Last candle\'s range (ATR)'],
  ['tVol', 'Last candle\'s volume ÷ normal'],
  ['volTrend', 'Last two candles\' volume ÷ the two before'],
  ['climax3', 'Biggest of the last 3 candles\' volume ÷ normal'],
  ['rvolSame', 'Volume so far ÷ usual at this time'],
  ['rvolDay', 'TradingView relative volume'],
  ['openBusy', 'Rvol above 0.1 at 09:20 (1 / 0)'],
  ['atrPct', '10-min ATR (% of price)'],
  ['adrPct', 'Usual daily range (% of price)'],
  ['nFirst5', 'Nifty 500 first 5 min (%)'],
  ['nDay', 'Nifty 500 open → now (%)'],
  ['nRecent30', 'Nifty 500 last 30 min (%)'],
  ['nRecent10', 'Nifty 500 last 10 min (%)'],
  ['nPosInRange', 'Where Nifty 500 is in its day range (0 = low, 1 = high)'],
  ['rsDay', 'Stock vs Nifty since the open (%)'],
  ['rs30', 'Stock vs Nifty over the last 30 min (%)'],
  ['ema10Atr', '10-min 200 EMA vs price (ATR; + = above price)'],
  ['ema5Atr', '5-min 200 EMA vs price (ATR; + = above price)'],
  ['ema1dAtr', 'Daily 200 EMA vs price (ATR; + = above price)'],
  ['pdhAtr', 'Previous day high vs price (ATR; + = above)'],
  ['pdlAtr', 'Previous day low vs price (ATR; + = above)'],
  ['vaHiAtr', 'Yesterday\'s value area high vs price (ATR)'],
  ['vaLoAtr', 'Yesterday\'s value area low vs price (ATR)'],
  ['pocAtr', 'Today\'s POC vs price (ATR; + = above)'],
  ['upCandles', '10-min candles in a row closing up'],
  ['downCandles', '10-min candles in a row closing down'],
  ['priceRs', 'Price (₹)'],
  // iteration 3: memory beyond today (the stock's habits over its last 20 sessions, and the multi-day picture)
  ['habitClose', 'This stock\'s usual move from this time to 15:15, last 20 days (%)'],
  ['habitCloseUp', 'How often it rose from this time to 15:15, last 20 days (0-1)'],
  ['habitNext30', 'This stock\'s usual move in the next 30 min from this time, last 20 days (%)'],
  ['habitTrend', 'How often the rest of the day kept the day\'s direction so far, at this time, last 20 days (0-1)'],
  ['ret5d', 'Move over the last 5 days (%)'],
  ['ret20d', 'Move over the last 20 days (%)'],
  ['hi20Adr', 'Below the 20-day high by (× usual daily range)'],
  ['lo20Adr', 'Above the 20-day low by (× usual daily range)'],
  ['prevCloseLoc', 'Where yesterday closed in its range (0 = low, 1 = high)'],
  ['prevLast30', 'Yesterday\'s last 30 minutes (%)'],
  ['gapVsUsual', 'Today\'s gap ÷ its usual gap (last 10 days)'],
] as const;
export const ML_KEYS = ML_FEATURES.map((f) => f[0]);
/**
 * what each row carries after the facts: the trade results, long and short (R after charges; ...g = before charges):
 *   netL/netS/rL/rS        the tight bracket (stop 1 ATR, target 1.5 ATR, out by 15:00)
 *   wbL/wbS/wbLg/wbSg      the wide bracket (stop ½ usual daily range, target ¾, out by 15:15)
 *   ccL/ccS/ccLg/ccSg      the ride to the close (safety stop ¾ usual daily range, out at 15:15)
 *   ccRet                  the plain move from this close to the 15:15 close (%; for the market-neutral ranking)
 */
export const ML_LABELS = ['netL', 'netS', 'rL', 'rS', 'wbL', 'wbS', 'wbLg', 'wbSg', 'ccL', 'ccS', 'ccLg', 'ccSg', 'ccRet',
  'wbL1', 'wbS1', 'wbL3', 'wbS3', 'ccL1', 'ccS1', 'ccL3', 'ccS3'] as const;
/**
 * (iteration 5) the same wide-bracket / ride-to-close trades with bigger positions, market orders as before, R after
 * charges (Dhan's brokerage is capped at ₹20 an order, so charges fall as a share of the trade):
 *   ...1   a ~₹1 lakh position        ...3   a ~₹3 lakh position
 * (Iteration 4 also tried limit orders at the 10-min close: worse than market orders, because the orders that never
 * filled were the winners. `ride` keeps the limit option for tests.)
 */
export const LIMIT_WINDOW = 10, MID_NOTIONAL = 100_000, BIG_NOTIONAL = 300_000;
export const ML_COLS = ['sym', 'date', 'slot', ...ML_KEYS, ...ML_LABELS];
export const ML_WIDTH = ML_COLS.length;

export const STOP_ATR = 1, TARGET_ATR = 1.5;
/** the wider trades, in units of the usual daily range (10-day average high - low) */
export const WIDE_STOP_ADR = 0.5, WIDE_TARGET_ADR = 0.75, CLOSE_STOP_ADR = 0.75;
const FIRST = 20, LAST = 330, END = 345;
/** the wider trades are closed at 15:15 (the close of the 15:14 minute) */
export const LATE_END = 360;

/**
 * One trade with the same cautious fills as the study (lib/study/mine.ts follow): entry 1 tick worse than the close,
 * the stop fills 1 tick worse, the target only when traded through by a tick, stop and target in the same minute =
 * stop, anything open closed at the close of minute end-1 (1 tick worse). Sized at `risk` rupees.
 * Returns R after charges and before.
 */
export function ride(day: NonNullable<ReturnType<typeof toSlots>>, k: number, d: 1 | -1, close: number, stopPx: number, target: number | undefined, end: number, risk: number,
  ex: { limit?: boolean; notional?: number } = {}): { net: number; r: number } {
  // a limit order rests at the close: filled (at the close) in the first minute that trades through it by a tick
  let from = k;
  if (ex.limit) {
    from = -1;
    for (let s = k; s < Math.min(end, k + LIMIT_WINDOW); s++) if (d === 1 ? day.l[s] <= close - TICK : day.h[s] >= close + TICK) { from = s; break; }
    if (from < 0) return { net: NaN, r: NaN };
  }
  const entry = ex.limit ? close : close + d * TICK;
  let stopAt = -1, targetAt = -1;
  for (let s = from; s < end; s++) {
    if (stopAt < 0 && (d === 1 ? day.l[s] <= stopPx : day.h[s] >= stopPx)) stopAt = s;
    if (target !== undefined && targetAt < 0 && (d === 1 ? day.h[s] >= target + TICK : day.l[s] <= target - TICK)) targetAt = s;
    if (stopAt >= 0 && (targetAt >= 0 || target === undefined)) break;
  }
  const win = target !== undefined && targetAt >= 0 && (stopAt < 0 || targetAt < stopAt);
  const exit = win ? target! : stopAt >= 0 ? stopPx - d * TICK : day.c[end - 1] - d * TICK;
  const dist = (entry - stopPx) * d;
  if (!(dist > 0)) return { net: NaN, r: NaN };
  const qty = ex.notional ? Math.max(1, Math.floor(ex.notional / entry)) : sizeFor(risk, dist);
  const r = ((exit - entry) * d) / dist;
  return { net: Math.round((r - roundTripCharges(qty, entry, exit, d) / (qty * dist)) * 1000) / 1000, r: Math.round(r * 1000) / 1000 };
}

export interface GridInput { date: string; history: Session[]; day: Bar[]; nifty: Bar[]; daily: Candles; riskInr?: number; pocRows?: number }

/** The rows of one stock-day: [slot, ...facts, ...labels] (sym / date are added by the writer). NaN = unknown. */
export function gridDay(inp: GridInput): number[][] {
  const risk = inp.riskInr ?? 300, rows = inp.pocRows ?? 30;
  const day = toSlots(inp.day), nifty = toSlots(inp.nifty);
  if (!day || !nifty || day.n < LATE_END || nifty.n < LAST) return [];
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
  // memory: the last 20 sessions as minute slots (only full days count for the habits)
  const past = hist.map((h) => toSlots(h.bars)).filter((x): x is NonNullable<typeof x> => !!x && x.n >= LATE_END);
  const habit = (k: number) => {
    let close = 0, up = 0, next = 0, trend = 0, n = 0;
    for (const p of past) {
      const at = p.c[k - 1], fin = p.c[LATE_END - 1];
      if (!(at > 0)) continue;
      close += (fin / at - 1) * 100; up += fin > at ? 1 : 0; next += (p.c[Math.min(k + 29, LATE_END - 1)] / at - 1) * 100;
      trend += Math.sign(fin - at) === Math.sign(at - p.o[0]) && fin !== at ? 1 : 0;
      n++;
    }
    return n >= 8 ? { habitClose: close / n, habitCloseUp: up / n, habitNext30: next / n, habitTrend: trend / n } : { habitClose: NaN, habitCloseUp: NaN, habitNext30: NaN, habitTrend: NaN };
  };
  const back = (n: number) => (nd > n ? (daily.c[nd - 1] / daily.c[nd - 1 - n] - 1) * 100 : NaN);
  const ret5d = back(5), ret20d = back(20);
  const hi20 = Math.max(...daily.h.slice(-20)), lo20 = Math.min(...daily.l.slice(-20));
  const prevCloseLoc = pdh > pdl ? (prevClose - pdl) / (pdh - pdl) : 0.5;
  const lastPast = past.at(-1);
  const prevLast30 = lastPast && lastPast.n >= 375 ? (lastPast.c[374] / lastPast.c[344] - 1) * 100 : NaN;
  const gaps: number[] = [];
  for (let i = Math.max(1, nd - 10); i < nd; i++) gaps.push(Math.abs(daily.o[i] / daily.c[i - 1] - 1) * 100);
  const usualGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : NaN;
  const gapVsUsual = usualGap > 0 ? Math.abs(gapPct) / usualGap : NaN;

  const tens: B10[] = [];
  const lowZone = new Zone(-1), highZone = new Zone(1);
  let pv = 0, vv = 0, cumV = 0, dayHi = -Infinity, dayLo = Infinity, hiSlot = 0, loSlot = 0, nHi = -Infinity, nLo = Infinity, openBusy = 0;
  let medV = median(medBase);
  const out: number[][] = [];

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
    if (k < FIRST || k % 10 !== 0) continue;

    const atr = atrC.peek();
    if (!atr || !(atr > 0) || !(vv > 0)) continue;
    const price = day.c[k - 1], vwap = pv / vv;
    const L = tens.length, T = tens[L - 1];
    const rng = T.h - T.l;
    let up = 0, dn = 0;
    for (let i = L - 1; i >= 0 && tens[i].c > tens[i].o; i--) up++;
    for (let i = L - 1; i >= 0 && tens[i].c < tens[i].o; i--) dn++;
    const e10 = ema10.peek(), e5 = ema5.peek(), e1d = ema1d.peek(price);
    const nNow = nifty.c[k - 1];
    const poc = pointOfControl(day.bars.slice(0, k), rows);
    const pct = (a: number, b: number) => (a / b - 1) * 100;
    const x: Record<string, number> = {
      minute: k, retOpenPct: pct(price, open), retOpenAdr: (price - open) / adr, gapPct, prevDayRet,
      ret10Atr: (price - day.c[k - 11]) / atr, ret30Atr: (price - day.c[k - 31 >= 0 ? k - 31 : 0]) / atr, ret60Atr: k >= 61 ? (price - day.c[k - 61]) / atr : NaN,
      distVwapAtr: (price - vwap) / atr, distHiAtr: (dayHi - price) / atr, distLoAtr: (price - dayLo) / atr,
      rangeAdr: (dayHi - dayLo) / adr, posInRange: dayHi > dayLo ? (price - dayLo) / (dayHi - dayLo) : 0.5,
      minSinceHi: k - 1 - hiSlot, minSinceLo: k - 1 - loSlot, testsHi: highZone.tests.length, testsLo: lowZone.tests.length,
      tBody: rng > 0 ? (T.c - T.o) / rng : 0, tUpWick: rng > 0 ? (T.h - Math.max(T.o, T.c)) / rng : 0, tLoWick: rng > 0 ? (Math.min(T.o, T.c) - T.l) / rng : 0,
      tRangeAtr: rng / atr, tVol: medV > 0 ? T.v / medV : NaN,
      volTrend: L >= 4 ? (tens[L - 1].v + tens[L - 2].v) / Math.max(1, tens[L - 3].v + tens[L - 4].v) : NaN,
      climax3: medV > 0 ? Math.max(...tens.slice(-3).map((b) => b.v)) / medV : NaN,
      rvolSame: cumV / sameAvg(k), rvolDay: cumV / fullAvg, openBusy, atrPct: (atr / price) * 100, adrPct: (adr / price) * 100,
      nFirst5, nDay: pct(nNow, nOpen), nRecent30: pct(nNow, nifty.c[k - 31 >= 0 ? k - 31 : 0]), nRecent10: pct(nNow, nifty.c[k - 11]),
      nPosInRange: nHi > nLo ? (nNow - nLo) / (nHi - nLo) : 0.5,
      rsDay: pct(price, open) - pct(nNow, nOpen), rs30: pct(price, day.c[k - 31 >= 0 ? k - 31 : 0]) - pct(nNow, nifty.c[k - 31 >= 0 ? k - 31 : 0]),
      ema10Atr: e10 !== undefined ? (e10 - price) / atr : NaN, ema5Atr: e5 !== undefined ? (e5 - price) / atr : NaN, ema1dAtr: e1d !== undefined ? (e1d - price) / atr : NaN,
      pdhAtr: (pdh - price) / atr, pdlAtr: (pdl - price) / atr,
      vaHiAtr: pva ? (pva.vah - price) / atr : NaN, vaLoAtr: pva ? (pva.val - price) / atr : NaN, pocAtr: poc !== undefined ? (poc - price) / atr : NaN,
      upCandles: up, downCandles: dn, priceRs: price,
      ...habit(k), ret5d, ret20d, hi20Adr: (hi20 - price) / adr, lo20Adr: (price - lo20) / adr, prevCloseLoc, prevLast30, gapVsUsual,
    };
    const trade = (d: 1 | -1) => follow(day, k, d, price, onTick(price - d * STOP_ATR * atr, (-d) as 1 | -1), onTick(price + d * TARGET_ATR * atr, d), atr, risk);
    const lg = trade(1), sh = trade(-1);
    const wide = (d: 1 | -1) => ride(day, k, d, price, onTick(price - d * WIDE_STOP_ADR * adr, (-d) as 1 | -1), onTick(price + d * WIDE_TARGET_ADR * adr, d), LATE_END, risk);
    const toClose = (d: 1 | -1) => ride(day, k, d, price, onTick(price - d * CLOSE_STOP_ADR * adr, (-d) as 1 | -1), undefined, LATE_END, risk);
    const wl = wide(1), ws = wide(-1), cl = toClose(1), cs = toClose(-1);
    const cheap = (d: 1 | -1, big: boolean) => {
      const ex = { notional: big ? BIG_NOTIONAL : MID_NOTIONAL };
      return [ride(day, k, d, price, onTick(price - d * WIDE_STOP_ADR * adr, (-d) as 1 | -1), onTick(price + d * WIDE_TARGET_ADR * adr, d), LATE_END, risk, ex).net,
        ride(day, k, d, price, onTick(price - d * CLOSE_STOP_ADR * adr, (-d) as 1 | -1), undefined, LATE_END, risk, ex).net];
    };
    const [wLl, cLl] = cheap(1, false), [wSl, cSl] = cheap(-1, false), [wLb, cLb] = cheap(1, true), [wSb, cSb] = cheap(-1, true);
    out.push([k, ...ML_KEYS.map((f) => (Number.isFinite(x[f]) ? x[f] : NaN)), lg.net, sh.net, lg.r, sh.r,
      wl.net, ws.net, wl.r, ws.r, cl.net, cs.net, cl.r, cs.r, pct(day.c[LATE_END - 1], price),
      wLl, wSl, wLb, wSb, cLl, cSl, cLb, cSb]);
  }
  return out;
}
