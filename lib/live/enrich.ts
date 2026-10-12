import type { Candles } from '../dhan';
import type { Direction } from './types';
import { istParts, SESSION_OPEN_MIN, SESSION_CLOSE_MIN } from './time';

/**
 * Market context for a trade, computed from 1-minute candles using ONLY information that existed
 * before the entry minute (so it can be filled in later without hindsight leaking in).
 *
 * Definitions (identical to the analysis that was run on the journal):
 *  - Nifty500First5Pct   Nifty 500 move from the 09:15 open to the 09:19 close, in %
 *  - Nifty500AtEntryPct  Nifty 500 move from the 09:15 open to the last candle before entry, in %
 *  - RvolDay5            TradingView-style: volume 09:15-09:19 / average FULL-DAY volume of the previous 10 sessions
 *  - RvolDayAtEntry      the same, volume up to the entry minute
 *  - Rvol5               stock volume 09:15-09:19 / average of the same window over the previous 10 sessions
 *  - RvolAtEntry         stock volume 09:15..entry / average of the same window over the previous 10 sessions
 *  - Atr10m / Atr2       Wilder ATR(14) on 10-minute bars as the chart shows it at entry, including the bar still forming (2xATR is the app's max-stop yardstick)
 *  - VwapDistPct         entry price vs session VWAP (hlc3-weighted) of candles completed before entry, in %
 *  - MfePct/MaePct       best / worst excursion from entry price to the exit moment, in % of entry (>= 0)
 *  - MfeR/MaeR           the same in R, where R = your initial stop distance if known, else 2xATR
 */

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number } // t = unix seconds (candle start)
export interface Session { date: string; bars: Bar[] }

export function toSessions(c: Candles): Session[] {
  const byDate = new Map<string, Bar[]>();
  for (let i = 0; i < c.t.length; i++) {
    const p = istParts(c.t[i] * 1000);
    if (p.minuteOfDay < SESSION_OPEN_MIN || p.minuteOfDay >= SESSION_CLOSE_MIN) continue; // ignore pre-open / post-close prints
    const arr = byDate.get(p.dateKey) ?? [];
    arr.push({ t: c.t[i], o: c.o[i], h: c.h[i], l: c.l[i], c: c.c[i], v: c.v[i] });
    byDate.set(p.dateKey, arr);
  }
  return [...byDate.entries()]
    .map(([date, bars]) => ({ date, bars: bars.sort((a, b) => a.t - b.t) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

const mod = (b: Bar) => istParts(b.t * 1000).minuteOfDay;

function windowVolume(s: Session, fromMin: number, toMinExcl: number): number {
  let v = 0;
  for (const b of s.bars) { const m = mod(b); if (m >= fromMin && m < toMinExcl) v += b.v; }
  return v;
}

/** today's window volume / mean of the window volume over up to 10 prior sessions (needs >= 5 of them). */
function relVolume(sessions: Session[], date: string, toMinExcl: number): number | undefined {
  if (toMinExcl <= SESSION_OPEN_MIN) return undefined;
  const today = sessions.find((s) => s.date === date);
  if (!today) return undefined;
  const priors = sessions.filter((s) => s.date < date).slice(-10)
    .map((s) => windowVolume(s, SESSION_OPEN_MIN, toMinExcl)).filter((v) => v > 0);
  if (priors.length < 5) return undefined;
  const base = priors.reduce((a, b) => a + b, 0) / priors.length;
  return base > 0 ? windowVolume(today, SESSION_OPEN_MIN, toMinExcl) / base : undefined;
}

/**
 * TradingView-style "Relative Volume": volume so far today / average FULL-DAY volume of the previous
 * 10 sessions. Early in the day this is small (about 0.1 at 09:20 on a normal day), which is why a
 * ">0.1 at the open" rule means "busier than usual". Needs >= 5 prior sessions.
 */
function relVolumeDay(sessions: Session[], date: string, toMinExcl: number): number | undefined {
  if (toMinExcl <= SESSION_OPEN_MIN) return undefined;
  const today = sessions.find((s) => s.date === date);
  if (!today) return undefined;
  const priors = sessions.filter((s) => s.date < date).slice(-10)
    .map((s) => windowVolume(s, SESSION_OPEN_MIN, SESSION_CLOSE_MIN)).filter((v) => v > 0);
  if (priors.length < 5) return undefined;
  const base = priors.reduce((a, b) => a + b, 0) / priors.length;
  return base > 0 ? windowVolume(today, SESSION_OPEN_MIN, toMinExcl) / base : undefined;
}

interface Bar10 { start: number; end: number; o: number; h: number; l: number; c: number }

function tenMinuteBars(sessions: Session[]): Bar10[] {
  const out: Bar10[] = [];
  for (const s of sessions) {
    const buckets = new Map<number, Bar[]>();
    for (const b of s.bars) {
      const k = Math.floor((mod(b) - SESSION_OPEN_MIN) / 10);
      const arr = buckets.get(k) ?? []; arr.push(b); buckets.set(k, arr);
    }
    for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
      const bs = buckets.get(k)!;
      const dayStartSec = bs[0].t - (mod(bs[0]) - SESSION_OPEN_MIN) * 60; // unix seconds of that day's 09:15
      const startSec = dayStartSec + k * 600;
      out.push({
        start: startSec, end: startSec + 600,
        o: bs[0].o, h: Math.max(...bs.map((x) => x.h)), l: Math.min(...bs.map((x) => x.l)), c: bs[bs.length - 1].c,
      });
    }
  }
  return out;
}

/** Wilder ATR(14) over consecutive bars (previous close carries across days), NaN until 14 bars exist. */
function wilderAtr(bars: Bar10[], n = 14): number[] {
  const out: number[] = [];
  const a = 1 / n;
  let prev = NaN;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    let tr = b.h - b.l;
    if (i > 0) { const pc = bars[i - 1].c; tr = Math.max(tr, Math.abs(b.h - pc), Math.abs(b.l - pc)); }
    prev = i === 0 ? tr : (1 - a) * prev + a * tr;
    out.push(i + 1 >= n ? prev : NaN);
  }
  return out;
}

export interface EnrichInput {
  date: string;
  entryMs: number;
  exitMs: number;
  direction: Direction;
  entryPrice: number;      // average entry of the trade
  stock: Session[];        // prior sessions + the trade day
  nifty: Session[];        // at least the trade day
  stopDist?: number;       // per-share initial stop distance, when known
  prevClose?: number;      // official previous-day close (from daily candles). Falls back to the last 1-min close.
}

export interface Enrichment {
  nifty500First5Pct?: number;
  nifty500AtEntryPct?: number;
  rvol5?: number;
  rvolAtEntry?: number;
  rvolDay5?: number;
  rvolDayAtEntry?: number;
  atr10m?: number;
  atr2?: number;
  chgPrevClosePct?: number;
  gapPct?: number;
  vwapDistPct?: number;
  mfePct?: number;
  maePct?: number;
  mfeR?: number;
  maeR?: number;
  rBasis?: 'STOP' | '2ATR';
  missing: string[];
}

const r4 = (n: number) => Number(n.toFixed(4));
const r2 = (n: number) => Number(n.toFixed(2));

export function computeEnrichment(inp: EnrichInput): Enrichment {
  const out: Enrichment = { missing: [] };
  const entryMinuteMs = Math.floor(inp.entryMs / 60000) * 60000;
  const entryMinOfDay = istParts(inp.entryMs).minuteOfDay;

  const day = inp.stock.find((s) => s.date === inp.date);
  if (!day || day.bars.length === 0) { out.missing.push('stock candles'); return out; }

  // ---- Nifty 500
  const nDay = inp.nifty.find((s) => s.date === inp.date);
  if (nDay && nDay.bars.length) {
    // Dhan's index candles are not always labelled the same way: some days start at 09:16 (shifted by a
    // minute), others carry an extra bar. So take the first five bars of the day, not a fixed clock window.
    const first5 = nDay.bars.slice(0, 5);
    if (first5.length === 5 && mod(first5[0]) <= SESSION_OPEN_MIN + 2 && mod(first5[4]) <= SESSION_OPEN_MIN + 8) {
      out.nifty500First5Pct = r4((first5[4].c / first5[0].o - 1) * 100);
    } else out.missing.push('nifty first 5 min');
    const before = nDay.bars.filter((b) => b.t * 1000 < entryMinuteMs);
    if (before.length) out.nifty500AtEntryPct = r4((before[before.length - 1].c / nDay.bars[0].o - 1) * 100);
  } else out.missing.push('nifty candles');

  // ---- stock context
  const prevSession = [...inp.stock].reverse().find((s) => s.date < inp.date);
  const pc = inp.prevClose && inp.prevClose > 0
    ? inp.prevClose
    : prevSession && prevSession.bars.length ? prevSession.bars[prevSession.bars.length - 1].c : undefined;
  if (pc !== undefined) {
    out.chgPrevClosePct = r4((inp.entryPrice / pc - 1) * 100);
    out.gapPct = r4((day.bars[0].o / pc - 1) * 100);
  } else out.missing.push('previous close');

  const rv5 = relVolume(inp.stock, inp.date, SESSION_OPEN_MIN + 5);
  if (rv5 !== undefined) out.rvol5 = r4(rv5); else out.missing.push('rvol5');
  const rvE = relVolume(inp.stock, inp.date, entryMinOfDay);
  if (rvE !== undefined) out.rvolAtEntry = r4(rvE);
  const rd5 = relVolumeDay(inp.stock, inp.date, SESSION_OPEN_MIN + 5);
  if (rd5 !== undefined) out.rvolDay5 = r4(rd5);
  const rdE = relVolumeDay(inp.stock, inp.date, entryMinOfDay);
  if (rdE !== undefined) out.rvolDayAtEntry = r4(rdE);

  const before = day.bars.filter((b) => b.t * 1000 < entryMinuteMs);
  if (before.length) {
    let pv = 0, vv = 0;
    for (const b of before) { const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vv += b.v; }
    if (vv > 0) out.vwapDistPct = r4((inp.entryPrice / (pv / vv) - 1) * 100);
  }

  // ---- ATR(14) on 10-minute bars, the way the chart shows it at the moment you enter:
  // the bar that is still forming counts (built from the 1-minute candles completed before entry), and the
  // overnight gap is part of the first bar's true range. Nothing after the entry minute is used.
  const stockAtEntry = inp.stock.filter((s) => s.date <= inp.date)
    .map((s) => (s.date === inp.date ? { ...s, bars: s.bars.filter((b) => b.t * 1000 < entryMinuteMs) } : s))
    .filter((s) => s.bars.length > 0);
  const atr = wilderAtr(tenMinuteBars(stockAtEntry));
  const atrNow = atr.length ? atr[atr.length - 1] : NaN;
  if (Number.isFinite(atrNow)) { out.atr10m = r4(atrNow); out.atr2 = r4(atrNow * 2); } else out.missing.push('atr');

  // ---- excursions during the trade
  const win = day.bars.filter((b) => b.t * 1000 >= entryMinuteMs && b.t * 1000 <= inp.exitMs);
  if (win.length) {
    const hi = Math.max(...win.map((b) => b.h)), lo = Math.min(...win.map((b) => b.l));
    const fav = inp.direction === 'LONG' ? hi - inp.entryPrice : inp.entryPrice - lo;
    const adv = inp.direction === 'LONG' ? inp.entryPrice - lo : hi - inp.entryPrice;
    const mfe = Math.max(fav, 0), mae = Math.max(adv, 0);
    out.mfePct = r4((mfe / inp.entryPrice) * 100);
    out.maePct = r4((mae / inp.entryPrice) * 100);
    const basis = inp.stopDist && inp.stopDist > 0 ? inp.stopDist : out.atr2;
    if (basis && basis > 0) {
      out.rBasis = inp.stopDist && inp.stopDist > 0 ? 'STOP' : '2ATR';
      out.mfeR = r2(mfe / basis);
      out.maeR = r2(mae / basis);
    }
  }
  return out;
}

/** Calendar days of 1-minute history to request so ~10 prior sessions (plus ATR warm-up) are covered. */
export const LOOKBACK_CALENDAR_DAYS = 28;
