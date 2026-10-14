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
  /** Volume so far vs the average for the SAME time of day over the last 10 sessions (1 = normal). */
  RvolSameTime?: number;
  /** Busier than usual? At the open (before 09:35) his TradingView rule RvolDay > 0.1; later RvolSameTime > 1. */
  RvolBusy?: 'YES' | 'NO'; RvolBasis?: string;
  Ema200_5mAtr?: number; Ema200_10mAtr?: number; Ema200_1dAtr?: number; Ema200InPath: string;
  OrHigh?: number; OrLow?: number; EntryVsOr?: 'ABOVE' | 'INSIDE' | 'BELOW';
  PdhDistAtr?: number; PdlDistAtr?: number;
  VwapSide?: 'BUYERS' | 'SELLERS'; VwapHeldMin?: number;
  RsVsNiftyPct?: number; Rs20mPct?: number; ExtAdrPct?: number;
  PocPrice?: number; PocDistAtr?: number;
  PullbackNo?: number; VolTrend?: 'RISING' | 'FALLING' | 'FLAT'; PushVsPullVol?: number;
  Climax: string; FailedBreak: string;
  StopDist?: number; StopVsAtr2?: number; SizeQty?: number; RiskInr?: number;
  /**
   * A stop taken from the 10-minute chart: just beyond the last two 10-min candles' high (short) or low (long)
   * plus 0.1 ATR, at least 0.25 ATR from price, capped at his 2x ATR. Used for the "better fit" suggestion.
   */
  StopIdea?: number; StopIdeaAtr?: number; StopIdeaCapped?: 'YES';
  /** YES when he typed no stop: StopDist is then his 2x ATR cap (worst case), not his real stop. */
  StopAssumed?: 'YES';
  RoomAtr?: number; RoomVsStop?: number; RoomTo?: string; EstChargesInr?: number;
  /** Raw price levels, so the card can be read straight against the chart. */
  Ema200_5m?: number; Ema200_10m?: number; Ema200_1d?: number; DayHigh?: number; DayLow?: number;
  /** Today's move on the 10-minute chart (from the open, in % of the average daily range): UP / DOWN / FLAT. */
  MoveToday?: 'UP' | 'DOWN' | 'FLAT';
  /** What this trade is by today's move: with it = MOMENTUM, against it = REVERSAL. */
  SetupByMove?: 'MOMENTUM' | 'REVERSAL';
  /** Whether the chosen setup's core conditions are there (computed by the app, not by Claude). */
  CoreMet?: 'YES' | 'NO'; CoreMissing?: string;
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
export function climax(bars: Bar[], medianVol: number, nowSec: number, barSec = 60): string {
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    const range = b.h - b.l;
    if (!(range > 0) || !(medianVol > 0) || b.v < 3 * medianVol) continue;
    const upper = b.h - Math.max(b.o, b.c), lower = Math.min(b.o, b.c) - b.l;
    const ago = Math.max(0, Math.round((nowSec - (b.t + barSec)) / 60));
    if (upper >= 0.5 * range) return `TOP ${ago}m ago`;
    if (lower >= 0.5 * range) return `BOTTOM ${ago}m ago`;
  }
  return '';
}

/**
 * A failed break in `window`: a bar made a new high (low) beyond everything before it, and within `within` more
 * bars a close came back inside, and price is still back inside now. `prior` = the bars before the window.
 */
export function failedBreak(prior: Bar[], window: Bar[], price: number, which: 'HIGH' | 'LOW' | 'BOTH' = 'BOTH', within = 3): string {
  const all = [...prior, ...window];
  const off = prior.length;
  let found = '';
  for (let i = 0; i < window.length; i++) {
    const idx = off + i;
    if (idx === 0) continue;
    const before = all.slice(0, idx);
    const hi = Math.max(...before.map((b) => b.h)), lo = Math.min(...before.map((b) => b.l));
    const b = all[idx];
    const next = all.slice(idx, Math.min(all.length, idx + within + 1));
    if (which !== 'LOW' && b.h > hi && next.some((x) => x.c < hi) && price < hi) found = 'HIGH';
    if (which !== 'HIGH' && b.l < lo && next.some((x) => x.c > lo) && price > lo) found = 'LOW';
  }
  return found;
}

/** A 10-minute bar in the shape the helpers above take (t = bar start). */
export const asBar = (b: Bar10): Bar => ({ t: b.start, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });


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
  f.RvolSameTime = enr.rvolAtEntry;
  // TradingView's rvol grows all day (a full normal day ends near 1), so his ">0.1" rule only means something at the
  // open. Later in the day "busy" is judged against the same time of day.
  if (asOfMin < SESSION_OPEN_MIN + 20) {
    if (f.RvolDay !== undefined) { f.RvolBusy = f.RvolDay > 0.1 ? 'YES' : 'NO'; f.RvolBasis = 'open: TradingView rvol > 0.1'; }
  } else if (f.RvolSameTime !== undefined) {
    f.RvolBusy = f.RvolSameTime > 1 ? 'YES' : 'NO'; f.RvolBasis = 'vs the same time of day (1 = normal)';
  }
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
  if (e5 !== undefined) f.Ema200_5m = r2(e5);
  if (e10 !== undefined) f.Ema200_10m = r2(e10);
  if (e1d !== undefined) f.Ema200_1d = r2(e1d);
  f.Ema200_5mAtr = emaDist(e5, '5m');
  f.Ema200_10mAtr = emaDist(e10, '10m');
  f.Ema200_1dAtr = emaDist(e1d, '1D');
  f.Ema200InPath = inPath.join(', ');
  if (inPath.length) f.flags.push(`200 EMA in the path within ${inp.emaReachAtr} ATR (${f.Ema200InPath})`);

  // ---- the first 10-minute candle of the session (09:15-09:24, complete from 09:25), as on his 10-minute chart
  // (the Nifty first-5-minute test above stays: that is his rule, not a chart candle)
  const orBars = bars.filter((b) => minuteOf(b) < SESSION_OPEN_MIN + 10);
  if (startsAtOpen && orBars.length >= 8 && asOfMin >= SESSION_OPEN_MIN + 10) {
    f.OrHigh = Math.max(...orBars.map((b) => b.h));
    f.OrLow = Math.min(...orBars.map((b) => b.l));
    f.EntryVsOr = price > f.OrHigh ? 'ABOVE' : price < f.OrLow ? 'BELOW' : 'INSIDE';
  } else f.missing.push('first 10-min candle (09:15-09:24, complete from 09:25)');

  // ---- today's 10-minute bars, as the chart shows them (the last one may still be forming)
  const tens = tenMinuteBars([{ date: day.date, bars }]);
  const tensDone = tens.filter((b) => b.end <= nowSec);
  const tenBars = tens.map(asBar), doneBars = tensDone.map(asBar);

  // ---- previous day high / low (official daily candle)
  const n = daily.c.length;
  if (n && atr) {
    f.PdhDistAtr = r2((daily.h[n - 1] - price) / atr);
    f.PdlDistAtr = r2((daily.l[n - 1] - price) / atr);
  } else f.missing.push('previous day high/low');

  // ---- VWAP: who has been in control, and for how long
  if (enr.vwapDistPct !== undefined) {
    f.VwapSide = enr.vwapDistPct >= 0 ? 'BUYERS' : 'SELLERS';
    // how long price has closed on that side, counted in 10-minute candles (shown in minutes)
    let held = 0, pv = 0, vv = 0;
    const sides = tens.map((t) => { pv += ((t.h + t.l + t.c) / 3) * t.v; vv += t.v; return vv > 0 && t.c >= pv / vv ? 'BUYERS' : 'SELLERS'; });
    for (let i = sides.length - 1; i >= 0 && sides[i] === f.VwapSide; i--) held++;
    f.VwapHeldMin = held * 10;
  }

  // ---- relative strength vs Nifty 500
  const open = startsAtOpen ? bars[0].o : undefined;
  if (open !== undefined && f.NiftyNowPct !== undefined) f.RsVsNiftyPct = r4((price / open - 1) * 100 - f.NiftyNowPct);
  // last 20 minutes = the last two 10-minute candles
  if (bars.length > 20 && nBars.length > 20) {
    const s20 = (bars[bars.length - 1].c / bars[bars.length - 21].c - 1) * 100;
    const n20 = (nBars[nBars.length - 1].c / nBars[nBars.length - 21].c - 1) * 100;
    f.Rs20mPct = r4(s20 - n20);
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
    f.PullbackNo = pullbackNumber(tenBars, legDir, 0.5 * atr);
  }

  // ---- volume behaviour
  // last two completed 10-minute candles vs the two before (needs four: from 09:55)
  if (tensDone.length >= 4) {
    const last = tensDone.slice(-2).reduce((s, b) => s + b.v, 0), before = tensDone.slice(-4, -2).reduce((s, b) => s + b.v, 0);
    if (before > 0) { const ratio = last / before; f.VolTrend = ratio > 1.2 ? 'RISING' : ratio < 0.8 ? 'FALLING' : 'FLAT'; }
  } else f.missing.push('volume trend (needs four completed 10-min candles, from 09:55)');
  const withBars = tenBars.filter((b) => (b.c - b.o) * sign > 0), againstBars = tenBars.filter((b) => (b.c - b.o) * sign < 0);
  const avgV = (a: Bar[]) => (a.length ? a.reduce((s, b) => s + b.v, 0) / a.length : 0);
  if (withBars.length >= 2 && againstBars.length >= 2 && avgV(againstBars) > 0) f.PushVsPullVol = r2(avgV(withBars) / avgV(againstBars));

  // ---- climax (last 3 completed 10-min candles, against the median 10-min volume of the last two sessions and
  // today) and a failed break of the day's high/low (last 3 candles, closed back inside on that candle or the next)
  const prevSessions = stock.filter((x) => x.date < inp.date).slice(-2);
  const med = median([...tenMinuteBars(prevSessions).map((b) => b.v), ...tensDone.map((b) => b.v)]);
  f.Climax = climax(doneBars.slice(-3), med, nowSec, 600);
  f.FailedBreak = failedBreak(tenBars.slice(0, -3), tenBars.slice(-3), price, 'BOTH', 1);

  // ---- a stop from the 10-minute chart (for the "better fit" suggestion; never instead of his own stop)
  if (atr && tenBars.length) {
    const recent = tenBars.slice(-3); // the last two completed candles and the one forming
    let idea = sign === -1 ? Math.max(...recent.map((b) => b.h)) + 0.1 * atr : Math.min(...recent.map((b) => b.l)) - 0.1 * atr;
    if ((idea - price) * -sign < 0.25 * atr) idea = price - sign * 0.25 * atr; // price beyond those candles: a minimum distance
    if (Math.abs(idea - price) > 2 * atr) { idea = price - sign * 2 * atr; f.StopIdeaCapped = 'YES'; }
    f.StopIdea = r2(idea);
    f.StopIdeaAtr = r2(Math.abs(idea - price) / atr);
  }

  // ---- plan
  if (inp.plannedStop !== undefined && inp.plannedStop > 0) {
    const wrongSide = (inp.plannedStop - price) * sign >= 0;
    if (wrongSide) f.flags.push('Stop is on the wrong side of the price');
    else f.StopDist = r2(Math.abs(price - inp.plannedStop));
  }
  if (f.StopDist === undefined && f.Atr2) { f.StopDist = r2(f.Atr2); f.StopAssumed = 'YES'; }
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
  // Only real levels count: the day's high/low, the previous day's high/low and the 200 EMAs. The first 5-minute
  // candle's edges are NOT obstacles (often a small candle, and usually already crossed). The level's name and price
  // go to Claude and onto the card, so it can never be mislabelled.
  const dayHi = Math.max(...bars.map((b) => b.h)), dayLo = Math.min(...bars.map((b) => b.l));
  f.DayHigh = r2(dayHi); f.DayLow = r2(dayLo);
  if (atr) {
    let room: number | undefined;
    if (inp.setup === 'REVERSAL') {
      if (poc !== undefined && (poc - price) * sign > 0) { room = Math.abs(poc - price); f.RoomTo = `POC ${r2(poc)}`; }
      else { room = 0; f.RoomTo = poc !== undefined ? `POC ${r2(poc)} is behind the trade` : 'no POC'; }
    } else {
      // at the day's extreme (within 0.5 ATR) that level IS the breakout, not an obstacle
      const levels: { name: string; px: number }[] = [
        { name: 'day high', px: Math.abs(dayHi - price) > 0.5 * atr ? dayHi : NaN },
        { name: 'day low', px: Math.abs(price - dayLo) > 0.5 * atr ? dayLo : NaN },
        { name: 'prev day high', px: n ? daily.h[n - 1] : NaN },
        { name: 'prev day low', px: n ? daily.l[n - 1] : NaN },
        { name: '5m 200 EMA', px: e5 ?? NaN }, { name: '10m 200 EMA', px: e10 ?? NaN }, { name: 'daily 200 EMA', px: e1d ?? NaN },
      ].filter((x) => Number.isFinite(x.px) && (x.px - price) * sign > atr * 0.05);
      if (levels.length) {
        const near = levels.reduce((a, b) => (Math.abs(b.px - price) < Math.abs(a.px - price) ? b : a));
        room = Math.abs(near.px - price);
        f.RoomTo = `${near.name} ${r2(near.px)}`;
      } else {
        const atExtreme = sign === 1 ? Math.abs(dayHi - price) <= 0.5 * atr : Math.abs(price - dayLo) <= 0.5 * atr;
        f.RoomTo = atExtreme ? `none: price is at the day's ${sign === 1 ? 'high' : 'low'} (breakout)` : 'none in the data';
      }
    }
    if (room !== undefined) {
      f.RoomAtr = r2(room / atr);
      // against an assumed 2x ATR stop the ratio is meaningless (his real stops are much tighter): room in ATR only
      if (f.StopDist && !f.StopAssumed) f.RoomVsStop = r2(room / f.StopDist);
    }
  }
  // ---- what kind of trade this is by TODAY's move, and whether the setup's core conditions are there
  if (f.ExtAdrPct !== undefined) {
    f.MoveToday = f.ExtAdrPct >= 10 ? 'UP' : f.ExtAdrPct <= -10 ? 'DOWN' : 'FLAT';
    if (f.MoveToday !== 'FLAT') f.SetupByMove = (f.ExtAdrPct * sign > 0) ? 'MOMENTUM' : 'REVERSAL';
  }
  const core = coreCheck(f, inp.setup, inp.direction);
  f.CoreMet = core.missing.length ? 'NO' : 'YES';
  f.CoreMissing = core.missing.join('; ');
  return f;
}

/**
 * The core of each setup, decided by the app (so the label can never be argued away):
 *  Momentum = with today's move: the stock moving his way today (at least 10% of the average daily range),
 *    Nifty 500 not against him, VWAP control on his side, and room to the next obstacle (0.5 ATR or more,
 *    or price breaking out at the day's extreme).
 *  Reversal = against today's move, back to the POC: the stock moved at least 30% of its daily range the
 *    other way, the POC at least 1 ATR away in his direction, not busier than usual, and Nifty not pushing
 *    hard in the stock's direction.
 */
export function coreCheck(f: Facts, setup: Setup, direction: Direction): { missing: string[] } {
  const sign = direction === 'LONG' ? 1 : -1;
  const up = direction === 'LONG';
  const missing: string[] = [];
  const ext = f.ExtAdrPct;
  const n = f.NiftyState;
  if (setup === 'MOMENTUM') {
    if (ext === undefined) missing.push('today\'s move unknown');
    else if (ext * sign < 10) missing.push(`stock not moving ${up ? 'up' : 'down'} today (${ext > 0 ? '+' : ''}${ext}% of daily range)`);
    if (n === 'OPENING' || n === 'UNKNOWN' || n === undefined) missing.push('Nifty direction not known yet');
    else if (n === 'FLAT' || n === 'FLIPPED') missing.push(`Nifty 500 ${n.toLowerCase()}`);
    else if (up ? n.endsWith('_DOWN') : n.endsWith('_UP')) missing.push(`Nifty 500 moving ${up ? 'down' : 'up'}`);
    if (f.VwapSide && f.VwapSide !== (up ? 'BUYERS' : 'SELLERS')) missing.push(`${f.VwapSide.toLowerCase()} in control (VWAP)`);
    const breakout = (f.RoomTo ?? '').startsWith('none: price is at the day');
    if (!breakout && f.RoomAtr !== undefined && f.RoomAtr < 0.5) missing.push(`little room: ${f.RoomTo} ${f.RoomAtr} ATR away`);
  } else {
    if (ext === undefined) missing.push('today\'s move unknown');
    else if (ext * sign > -30) missing.push(`no ${up ? 'down' : 'up'}-move to fade (${ext > 0 ? '+' : ''}${ext}% of daily range today)`);
    const toPoc = f.PocDistAtr !== undefined ? f.PocDistAtr * sign : undefined;
    if (toPoc === undefined) missing.push('POC unknown');
    else if (toPoc < 1) missing.push(`POC ${toPoc <= 0 ? 'is behind the trade' : `only ${r2(toPoc)} ATR away`}`);
    if (f.RvolBusy === 'YES') missing.push('busier than usual');
    if (up ? n === 'TRENDING_DOWN' : n === 'TRENDING_UP') missing.push(`Nifty 500 pushing ${up ? 'down' : 'up'}`);
  }
  return { missing };
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

  // candle-by-candle checks on the 10-minute chart: the candle he entered in, and every one after
  const tens = tenMinuteBars([{ date: inp.date, bars }]);
  const entryBarStart = Math.floor((entryMin / 1000 - (tens[0]?.start ?? 0)) / 600) * 600 + (tens[0]?.start ?? 0);
  const sinceT = tens.filter((b) => b.start >= entryBarStart).map(asBar);
  const beforeT = tens.filter((b) => b.start < entryBarStart).map(asBar);
  const withV = sinceT.filter((b) => (b.c - b.o) * sign > 0).reduce((s, b) => s + b.v, 0);
  const againstV = sinceT.filter((b) => (b.c - b.o) * sign < 0).reduce((s, b) => s + b.v, 0);
  if (withV > 0) out.CounterVolRatio = r2(againstV / withV);
  else if (sinceT.length >= 1) out.missing.push('counter-volume (no 10-min candle has closed your way yet)');

  const med = median(tens.map((b) => b.v));
  const c = climax(sinceT, med, asOfMs / 1000, 600);
  if (c && ((sign === 1 && c.startsWith('TOP')) || (sign === -1 && c.startsWith('BOTTOM')))) out.ClimaxAgainst = c;
  out.FailedExtreme = failedBreak(beforeT, sinceT, inp.price, sign === 1 ? 'HIGH' : 'LOW', 1);

  const nDay = toSessions(inp.nifty1m).find((s) => s.date === inp.date);
  const nBars = nDay ? nDay.bars.filter((b) => b.t * 1000 < asOfMs) : [];
  const nAtEntry = [...nBars].reverse().find((b) => b.t * 1000 < entryMin);
  if (nAtEntry && nBars.length) out.NiftySinceEntryPct = r4((nBars[nBars.length - 1].c / nAtEntry.c - 1) * 100 * sign);
  return out;
}
