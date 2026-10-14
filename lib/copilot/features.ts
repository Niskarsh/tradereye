import type { Candles } from '../dhan';
import { computeEnrichment, tenMinuteBars, toSessions, type Bar, type Bar10, type Session } from '../live/enrich';
import { istParts, SESSION_OPEN_MIN } from '../live/time';
import type { Direction } from '../live/types';

/**
 * Co-pilot facts. Pure functions: no network, no clock (the "as of" moment is passed in).
 *
 * The same rules as the journal enrichment (lib/live/enrich.ts) apply, because those were checked against the chart:
 *  - only 1-minute candles that STARTED before the as-of minute are used (no hindsight; the forming bar is built
 *    from completed candles, exactly like ATR and VWAP in the journal);
 *  - bars are session-aligned at 09:15 (5- and 10-minute bars the way TradingView draws them on NSE);
 *  - relative volume, ATR(10m), VWAP and the Nifty 500 moves come straight from computeEnrichment, so a number here
 *    is the same number the journal shows for a trade entered at that moment;
 *  - if the 09:15 candle is missing, values measured from the open are left blank, never guessed.
 */

export type Setup = 'MOMENTUM' | 'REVERSAL';

export interface FactsInput {
  date: string;            // IST session date being read
  nowMs: number;           // as-of moment
  price: number;           // live price (or the entry price when backfilling)
  direction: Direction;
  setup: Setup;
  stock1m: Candles;        // 1-minute candles: prior ~28 calendar days + the session
  nifty1m: Candles;        // 1-minute Nifty 500 candles for the session
  daily: Candles;          // daily candles BEFORE `date` (Dhan's toDate is exclusive), ideally ~5 years
  plannedStop?: number;
  riskInr: number;
  niftyDirPct: number;     // first-5-minute Nifty move that counts as directional, in %
  emaReachAtr: number;     // a 200 EMA within this many ATR in the trade's path counts as "in reach"
  pocRows: number;         // volume profile rows across the day's range (TradingView "Number of rows")
  chargeRate?: number;     // your average charges per rupee of turnover
}

export type NiftyState = 'OPENING' | 'TRENDING_UP' | 'TRENDING_DOWN' | 'FADING_UP' | 'FADING_DOWN' | 'FLAT' | 'FLIPPED' | 'UNKNOWN';

export interface Facts {
  NiftyFirst5Pct?: number; NiftyNowPct?: number; NiftyLast10Pct?: number; NiftyState: NiftyState;
  RvolDay?: number; Atr10m?: number; Atr2?: number;
  Ema200_5mAtr?: number; Ema200_10mAtr?: number; Ema200_1dAtr?: number; Ema200InPath: string;
  OrHigh?: number; OrLow?: number; EntryVsOr?: 'ABOVE' | 'INSIDE' | 'BELOW';
  PdhDistAtr?: number; PdlDistAtr?: number;
  VwapSide?: 'BUYERS' | 'SELLERS'; VwapHeldMin?: number;
  RsVsNiftyPct?: number; Rs15mPct?: number; ExtAdrPct?: number;
  PocPrice?: number; PocDistAtr?: number;
  PullbackNo?: number; VolTrend?: 'RISING' | 'FALLING' | 'FLAT'; PushVsPullVol?: number;
  Climax: string; FailedBreak: string;
  StopDist?: number; StopVsAtr2?: number; SizeQty?: number; RiskInr?: number;
  RoomAtr?: number; RoomVsStop?: number; EstChargesInr?: number;
  /** Hard rules of yours that are broken (shown red on the page). */
  flags: string[];
  /** Values that could not be computed, and why. */
  missing: string[];
}

const r2 = (n: number) => Number(n.toFixed(2));
const r4 = (n: number) => Number(n.toFixed(4));
const minuteOf = (b: { t: number }) => istParts(b.t * 1000).minuteOfDay;
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Session-aligned N-minute bars (09:15, 09:15+N ...) from 1-minute sessions; the last bar may still be forming. */
export function nMinuteBars(sessions: Session[], n: number): Bar10[] {
  if (n === 10) return tenMinuteBars(sessions);
  const out: Bar10[] = [];
  for (const s of sessions) {
    const buckets = new Map<number, Bar[]>();
    for (const b of s.bars) {
      const k = Math.floor((minuteOf(b) - SESSION_OPEN_MIN) / n);
      const arr = buckets.get(k) ?? []; arr.push(b); buckets.set(k, arr);
    }
    for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
      const bs = buckets.get(k)!;
      const dayStartSec = bs[0].t - (minuteOf(bs[0]) - SESSION_OPEN_MIN) * 60;
      const startSec = dayStartSec + k * n * 60;
      out.push({
        start: startSec, end: startSec + n * 60,
        o: bs[0].o, h: Math.max(...bs.map((x) => x.h)), l: Math.min(...bs.map((x) => x.l)), c: bs[bs.length - 1].c,
        v: bs.reduce((sum, x) => sum + x.v, 0),
      });
    }
  }
  return out;
}

/**
 * EMA as TradingView's ta.ema computes it (seeded with the first value). Returns undefined unless there are at least
 * 3x `len` values, so a short history can never show a half-converged number that disagrees with the chart.
 */
export function ema(values: number[], len: number): number | undefined {
  if (values.length < len * 3) return undefined;
  const a = 2 / (len + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = a * values[i] + (1 - a) * e;
  return e;
}

/** True if the daily history holds a one-day move over 30% (likely an unadjusted split or bonus). */
export function hasSuspectGap(daily: Candles): boolean {
  for (let i = 1; i < daily.c.length; i++) {
    const p = daily.c[i - 1], c = daily.c[i];
    if (p > 0 && Math.abs(c / p - 1) > 0.3) return true;
  }
  return false;
}

/** Volume profile of the bars: each bar's volume is spread over the rows its high-low range covers. Returns the POC. */
export function pointOfControl(bars: Bar[], rows: number): number | undefined {
  if (!bars.length || rows < 2) return undefined;
  const hi = Math.max(...bars.map((b) => b.h)), lo = Math.min(...bars.map((b) => b.l));
  if (!(hi > lo)) return bars[0].c;
  const size = (hi - lo) / rows;
  const vol = new Array<number>(rows).fill(0);
  for (const b of bars) {
    if (b.v <= 0) continue;
    if (b.h <= b.l) { vol[Math.min(rows - 1, Math.floor((b.c - lo) / size))] += b.v; continue; }
    for (let i = 0; i < rows; i++) {
      const rLo = lo + i * size, rHi = rLo + size;
      const overlap = Math.min(b.h, rHi) - Math.max(b.l, rLo);
      if (overlap > 0) vol[i] += b.v * (overlap / (b.h - b.l));
    }
  }
  let best = 0;
  for (let i = 1; i < rows; i++) if (vol[i] > vol[best]) best = i;
  return lo + (best + 0.5) * size;
}

/**
 * How many pullbacks the move has had. `dir` is the move being followed (UP or DOWN). A pullback is a retracement
 * of at least `minDepth` from the move's extreme; it counts as done when a new extreme is made. Returns the number of
 * the pullback in progress (or the last one, if price is at a new extreme now), 0 if there has been none.
 */
export function pullbackNumber(bars: Bar[], dir: 1 | -1, minDepth: number): number {
  if (!bars.length || !(minDepth > 0)) return 0;
  let ext = dir === 1 ? bars[0].h : bars[0].l;
  let inPullback = false, count = 0;
  for (const b of bars) {
    const newExt = dir === 1 ? b.h > ext : b.l < ext;
    // the bar that makes a new extreme is the move itself; only LATER bars can pull back from it
    if (newExt) { ext = dir === 1 ? b.h : b.l; inPullback = false; continue; }
    const depth = dir === 1 ? ext - b.l : b.h - ext;
    if (!inPullback && depth >= minDepth) { inPullback = true; count++; }
  }
  return count;
}

/** The most recent climax bar in `bars`: volume at least 3x `medianVol` and a wick of at least half its range. */
export function climax(bars: Bar[], medianVol: number, nowSec: number): string {
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    const range = b.h - b.l;
    if (!(range > 0) || !(medianVol > 0) || b.v < 3 * medianVol) continue;
    const upper = b.h - Math.max(b.o, b.c), lower = Math.min(b.o, b.c) - b.l;
    const ago = Math.max(0, Math.round((nowSec - (b.t + 60)) / 60));
    if (upper >= 0.5 * range) return `TOP ${ago}m ago`;
    if (lower >= 0.5 * range) return `BOTTOM ${ago}m ago`;
  }
  return '';
}

/**
 * A failed break in the last `lookback` bars: a bar made a new high (low) beyond everything before it, and within 3
 * bars a close came back inside, and price is still back inside now. `prior` = the bars before the window.
 */
export function failedBreak(prior: Bar[], window: Bar[], price: number, which: 'HIGH' | 'LOW' | 'BOTH' = 'BOTH'): string {
  const all = [...prior, ...window];
  const off = prior.length;
  let found = '';
  for (let i = 0; i < window.length; i++) {
    const idx = off + i;
    if (idx === 0) continue;
    const before = all.slice(0, idx);
    const hi = Math.max(...before.map((b) => b.h)), lo = Math.min(...before.map((b) => b.l));
    const b = all[idx];
    const next = all.slice(idx, Math.min(all.length, idx + 4));
    if (which !== 'LOW' && b.h > hi && next.some((x) => x.c < hi) && price < hi) found = 'HIGH';
    if (which !== 'HIGH' && b.l < lo && next.some((x) => x.c > lo) && price > lo) found = 'LOW';
  }
  return found;
}

/** Running VWAP the way a 10-minute chart draws it, evaluated after each 1-minute bar. */
function vwap10At(bars: Bar[], uptoIdx: number): number | undefined {
  const tens = tenMinuteBars([{ date: '', bars: bars.slice(0, uptoIdx + 1) }]);
  let pv = 0, vv = 0;
  for (const t of tens) { pv += ((t.h + t.l + t.c) / 3) * t.v; vv += t.v; }
  return vv > 0 ? pv / vv : undefined;
}

export function niftyState(first5: number | undefined, now: number | undefined, last10: number | undefined, th: number, asOfMin: number): NiftyState {
  if (asOfMin < SESSION_OPEN_MIN + 5) return 'OPENING';
  if (first5 === undefined || now === undefined) return 'UNKNOWN';
  if (Math.abs(first5) < th) return 'FLAT';
  const dir = Math.sign(first5);
  if (Math.sign(now) !== dir) return 'FLIPPED';
  const fading = last10 !== undefined && last10 * dir < 0;
  if (dir > 0) return fading ? 'FADING_UP' : 'TRENDING_UP';
  return fading ? 'FADING_DOWN' : 'TRENDING_DOWN';
}

export function computeFacts(inp: FactsInput): Facts {
  const f: Facts = { NiftyState: 'UNKNOWN', Ema200InPath: '', Climax: '', FailedBreak: '', flags: [], missing: [] };
  const stock = toSessions(inp.stock1m);
  const nifty = toSessions(inp.nifty1m);
  const day = stock.find((s) => s.date === inp.date);
  if (!day || !day.bars.length) { f.missing.push('stock candles for the session'); return f; }

  const asOfMs = Math.floor(inp.nowMs / 60000) * 60000;
  const asOfMin = istParts(inp.nowMs).minuteOfDay;
  const nowSec = asOfMs / 1000;
  const bars = day.bars.filter((b) => b.t * 1000 < asOfMs);
  if (!bars.length) { f.missing.push('no completed candle yet'); return f; }
  const sign = inp.direction === 'LONG' ? 1 : -1;
  const price = inp.price;
  const startsAtOpen = minuteOf(bars[0]) === SESSION_OPEN_MIN;

  const daily = inp.daily;
  const prevClose = daily.c.length ? daily.c[daily.c.length - 1] : undefined;

  // ---- everything the journal already computes, at this moment
  const enr = computeEnrichment({
    date: inp.date, entryMs: inp.nowMs, exitMs: inp.nowMs, direction: inp.direction, entryPrice: price,
    stock, nifty, prevClose,
  });
  for (const m of enr.missing) if (m !== 'previous close') f.missing.push(m);
  f.NiftyFirst5Pct = enr.nifty500First5Pct;
  f.NiftyNowPct = enr.nifty500AtEntryPct;
  f.RvolDay = enr.rvolDayAtEntry;
  f.Atr10m = enr.atr10m;
  f.Atr2 = enr.atr2;
  const atr = enr.atr10m;

  // ---- Nifty
  const nDay = nifty.find((s) => s.date === inp.date);
  const nBars = nDay ? nDay.bars.filter((b) => b.t * 1000 < asOfMs) : [];
  if (nBars.length > 10) f.NiftyLast10Pct = r4((nBars[nBars.length - 1].c / nBars[nBars.length - 11].c - 1) * 100);
  f.NiftyState = niftyState(f.NiftyFirst5Pct, f.NiftyNowPct, f.NiftyLast10Pct, inp.niftyDirPct, asOfMin);

  // ---- 200 EMAs (5m, 10m: built from prior sessions + this session so far; 1D: daily closes + today's price)
  const upto = stock.filter((s) => s.date <= inp.date)
    .map((s) => (s.date === inp.date ? { ...s, bars } : s));
  const e5 = ema(nMinuteBars(upto, 5).map((b) => b.c), 200);
  const e10 = ema(tenMinuteBars(upto).map((b) => b.c), 200);
  const suspect = hasSuspectGap(daily);
  const e1d = suspect ? undefined : ema([...daily.c, price], 200);
  if (suspect) f.missing.push('daily 200 EMA (a one-day move over 30% in the history: split or bonus?)');
  const inPath: string[] = [];
  const emaDist = (e: number | undefined, label: string) => {
    if (e === undefined) { if (!(label === '1D' && suspect)) f.missing.push(`${label} 200 EMA (not enough history)`); return undefined; }
    if (!atr) return undefined;
    const d = (e - price) / atr; // + = EMA above price
    if (d * sign > 0 && Math.abs(d) <= inp.emaReachAtr) inPath.push(`${label} ${r2(Math.abs(d))}`);
    return r2(d);
  };
  f.Ema200_5mAtr = emaDist(e5, '5m');
  f.Ema200_10mAtr = emaDist(e10, '10m');
  f.Ema200_1dAtr = emaDist(e1d, '1D');
  f.Ema200InPath = inPath.join(', ');
  if (inPath.length) f.flags.push(`200 EMA in the path within ${inp.emaReachAtr} ATR (${f.Ema200InPath})`);

  // ---- opening range (the first 5-minute candle, complete only after 09:20)
  const orBars = bars.filter((b) => minuteOf(b) < SESSION_OPEN_MIN + 5);
  if (startsAtOpen && orBars.length >= 4 && asOfMin >= SESSION_OPEN_MIN + 5) {
    f.OrHigh = Math.max(...orBars.map((b) => b.h));
    f.OrLow = Math.min(...orBars.map((b) => b.l));
    f.EntryVsOr = price > f.OrHigh ? 'ABOVE' : price < f.OrLow ? 'BELOW' : 'INSIDE';
  } else f.missing.push('opening range (needs the 09:15-09:19 candles, complete after 09:20)');

  // ---- previous day high / low (official daily candle)
  const n = daily.c.length;
  if (n && atr) {
    f.PdhDistAtr = r2((daily.h[n - 1] - price) / atr);
    f.PdlDistAtr = r2((daily.l[n - 1] - price) / atr);
  } else f.missing.push('previous day high/low');

  // ---- VWAP: who has been in control, and for how long
  if (enr.vwapDistPct !== undefined) {
    f.VwapSide = enr.vwapDistPct >= 0 ? 'BUYERS' : 'SELLERS';
    let held = 0;
    for (let i = bars.length - 1; i >= 0; i--) {
      const v = vwap10At(bars, i);
      if (v === undefined) break;
      const side = bars[i].c >= v ? 'BUYERS' : 'SELLERS';
      if (side !== f.VwapSide) break;
      held++;
    }
    f.VwapHeldMin = held;
  }

  // ---- relative strength vs Nifty 500
  const open = startsAtOpen ? bars[0].o : undefined;
  if (open !== undefined && f.NiftyNowPct !== undefined) f.RsVsNiftyPct = r4((price / open - 1) * 100 - f.NiftyNowPct);
  if (bars.length > 15 && nBars.length > 15) {
    const s15 = (bars[bars.length - 1].c / bars[bars.length - 16].c - 1) * 100;
    const n15 = (nBars[nBars.length - 1].c / nBars[nBars.length - 16].c - 1) * 100;
    f.Rs15mPct = r4(s15 - n15);
  }

  // ---- extension from the open as a share of the 10-day average daily range
  if (n >= 10 && open !== undefined) {
    const last10 = Array.from({ length: 10 }, (_, i) => daily.h[n - 10 + i] - daily.l[n - 10 + i]);
    const adr = last10.reduce((a, b) => a + b, 0) / 10;
    if (adr > 0) f.ExtAdrPct = r2(((price - open) / adr) * 100);
  }

  // ---- session POC
  const poc = pointOfControl(bars, inp.pocRows);
  if (poc !== undefined) {
    f.PocPrice = r2(poc);
    if (atr) f.PocDistAtr = r2((poc - price) / atr);
  }

  // ---- move structure: pullbacks follow the trade for momentum, the stock's own run for reversal
  if (atr) {
    const legDir = (inp.setup === 'MOMENTUM' ? sign : -sign) as 1 | -1;
    f.PullbackNo = pullbackNumber(bars, legDir, 0.5 * atr);
  }

  // ---- volume behaviour
  const fives = nMinuteBars([{ date: day.date, bars }], 5).filter((b) => b.end <= nowSec);
  if (fives.length >= 6) {
    const last = fives.slice(-3).reduce((s, b) => s + b.v, 0), before = fives.slice(-6, -3).reduce((s, b) => s + b.v, 0);
    if (before > 0) { const ratio = last / before; f.VolTrend = ratio > 1.2 ? 'RISING' : ratio < 0.8 ? 'FALLING' : 'FLAT'; }
  }
  const withBars = bars.filter((b) => (b.c - b.o) * sign > 0), againstBars = bars.filter((b) => (b.c - b.o) * sign < 0);
  const avgV = (a: Bar[]) => (a.length ? a.reduce((s, b) => s + b.v, 0) / a.length : 0);
  if (withBars.length >= 3 && againstBars.length >= 3 && avgV(againstBars) > 0) f.PushVsPullVol = r2(avgV(withBars) / avgV(againstBars));

  // ---- climax and failed break in the last 10 minutes
  const med = median(bars.map((b) => b.v));
  f.Climax = climax(bars.slice(-10), med, nowSec);
  f.FailedBreak = failedBreak(bars.slice(0, -10), bars.slice(-10), price);

  // ---- plan
  if (inp.plannedStop !== undefined && inp.plannedStop > 0) {
    const wrongSide = (inp.plannedStop - price) * sign >= 0;
    if (wrongSide) f.flags.push('Stop is on the wrong side of the price');
    else f.StopDist = r2(Math.abs(price - inp.plannedStop));
  }
  if (f.StopDist === undefined && f.Atr2) f.StopDist = r2(f.Atr2);
  if (f.StopDist && f.Atr2) {
    f.StopVsAtr2 = r2(f.StopDist / f.Atr2);
    if (f.StopVsAtr2 > 1.0001) f.flags.push('Stop wider than 2x ATR');
  }
  if (f.StopDist && f.StopDist > 0) {
    f.SizeQty = Math.floor(inp.riskInr / f.StopDist);
    f.RiskInr = r2(f.SizeQty * f.StopDist);
    if (f.SizeQty === 0) f.flags.push(`Even 1 share risks more than ${inp.riskInr} INR`);
    if (inp.chargeRate && inp.chargeRate > 0) f.EstChargesInr = r2(inp.chargeRate * 2 * f.SizeQty * price);
  }

  // ---- room to the next obstacle (reversal: distance to the POC, the target)
  if (atr) {
    let room: number | undefined;
    if (inp.setup === 'REVERSAL') {
      if (poc !== undefined && (poc - price) * sign > 0) room = Math.abs(poc - price);
      else room = 0;
    } else {
      // the day's own high/low only counts when price is well away from it (at the extreme it IS the breakout)
      const dayHi = Math.max(...bars.map((b) => b.h)), dayLo = Math.min(...bars.map((b) => b.l));
      const levels = [
        Math.abs(dayHi - price) > 0.5 * atr ? dayHi : NaN, Math.abs(price - dayLo) > 0.5 * atr ? dayLo : NaN,
        n ? daily.h[n - 1] : NaN, n ? daily.l[n - 1] : NaN,
        f.OrHigh ?? NaN, f.OrLow ?? NaN, e5 ?? NaN, e10 ?? NaN, e1d ?? NaN,
      ].filter((x) => Number.isFinite(x) && (x - price) * sign > atr * 0.05);
      if (levels.length) room = Math.min(...levels.map((x) => Math.abs(x - price)));
      else f.missing.push('room: no level (day extreme, PDH/PDL, opening range, 200 EMA) in the trade\'s path');
    }
    if (room !== undefined) {
      f.RoomAtr = r2(room / atr);
      if (f.StopDist) f.RoomVsStop = r2(room / f.StopDist);
    }
  }
  return f;
}

/* ----------------------------------------------------------------------------------------------------------- */

export interface ManageInput {
  date: string; nowMs: number; price: number; direction: Direction;
  stock1m: Candles; nifty1m: Candles;
  avgEntry: number; entryMs: number;
  initialStop?: number; currentStop?: number; stopMoves?: number;
  atr10m?: number;
}

export interface ManageFacts {
  AvgEntry: number; CurrentStop?: number;
  OpenR?: number; BestR?: number; GivebackR?: number; StopDistAtr?: number;
  CounterVolRatio?: number; ClimaxAgainst: string; FailedExtreme: string;
  NiftySinceEntryPct?: number; MinInTrade: number; StopMoves?: number;
  missing: string[];
}

/** In-trade facts for "Re-check my trade". */
export function computeManageFacts(inp: ManageInput): ManageFacts {
  const out: ManageFacts = { AvgEntry: r2(inp.avgEntry), CurrentStop: inp.currentStop, ClimaxAgainst: '', FailedExtreme: '', MinInTrade: 0, StopMoves: inp.stopMoves, missing: [] };
  const sign = inp.direction === 'LONG' ? 1 : -1;
  const asOfMs = Math.floor(inp.nowMs / 60000) * 60000;
  const entryMin = Math.floor(inp.entryMs / 60000) * 60000;
  out.MinInTrade = Math.max(0, Math.round((inp.nowMs - inp.entryMs) / 60000));
  const day = toSessions(inp.stock1m).find((s) => s.date === inp.date);
  const bars = day ? day.bars.filter((b) => b.t * 1000 < asOfMs) : [];
  const since = bars.filter((b) => b.t * 1000 >= entryMin);
  const before = bars.filter((b) => b.t * 1000 < entryMin);

  const ref = inp.initialStop ?? inp.currentStop;
  const dist = ref !== undefined && Math.abs(inp.avgEntry - ref) > 0 ? Math.abs(inp.avgEntry - ref) : inp.atr10m ? inp.atr10m * 2 : undefined;
  if (!dist) out.missing.push('stop distance (no stop found and no ATR)');
  const openMove = (inp.price - inp.avgEntry) * sign;
  if (dist) {
    out.OpenR = r2(openMove / dist);
    const fav = since.length ? (sign === 1 ? Math.max(...since.map((b) => b.h)) - inp.avgEntry : inp.avgEntry - Math.min(...since.map((b) => b.l))) : 0;
    out.BestR = r2(Math.max(fav, openMove, 0) / dist);
    out.GivebackR = r2(out.BestR - out.OpenR);
  }
  if (inp.currentStop !== undefined && inp.atr10m) out.StopDistAtr = r2(Math.abs(inp.price - inp.currentStop) / inp.atr10m);

  const withV = since.filter((b) => (b.c - b.o) * sign > 0).reduce((s, b) => s + b.v, 0);
  const againstV = since.filter((b) => (b.c - b.o) * sign < 0).reduce((s, b) => s + b.v, 0);
  if (withV > 0) out.CounterVolRatio = r2(againstV / withV);
  else if (since.length >= 3) out.missing.push('counter-volume (no candle has moved your way yet)');

  const med = median(bars.map((b) => b.v));
  const c = climax(since, med, asOfMs / 1000);
  if (c && ((sign === 1 && c.startsWith('TOP')) || (sign === -1 && c.startsWith('BOTTOM')))) out.ClimaxAgainst = c;
  out.FailedExtreme = failedBreak(before, since, inp.price, sign === 1 ? 'HIGH' : 'LOW');

  const nDay = toSessions(inp.nifty1m).find((s) => s.date === inp.date);
  const nBars = nDay ? nDay.bars.filter((b) => b.t * 1000 < asOfMs) : [];
  const nAtEntry = [...nBars].reverse().find((b) => b.t * 1000 < entryMin);
  if (nAtEntry && nBars.length) out.NiftySinceEntryPct = r4((nBars[nBars.length - 1].c / nAtEntry.c - 1) * 100 * sign);
  return out;
}
