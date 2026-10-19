import type { Candles } from '../dhan';
import { tenMinuteBars, toSessions, wilderAtr, type Bar, type Session } from '../live/enrich';
import { pointOfControl } from '../copilot/features';
import type { TradeMark } from '../book/marks';

/**
 * What the journal charts draw, worked out from saved candles (browser and server alike, no network):
 *  - 10-minute bars for every loaded session, session VWAP (hlc3, the way a 10-minute TradingView chart draws it,
 *    same as the journal's VwapDistPct), 200 EMA, the Nifty 500 % move on the same bars, the trade day's volume profile
 *  - daily bars with 20 / 50 / 200 EMAs (today's bar built from the minutes while the day is still running)
 *  - for the trade: average entry, 1R (the stop distance, or 2 x ATR(10m) when there was no stop, exactly like MfeR),
 *    best open profit (MFE) and when it happened, and the exit signals that fired while he was in.
 */

export interface CBar { t: number; o: number; h: number; l: number; c: number; v: number; date: string }
export type Series = (number | undefined)[];
const IST = 19800_000;
export const istDate = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
export const istHHMM = (ms: number) => new Date(ms + IST).toISOString().slice(11, 16);

/** EMA drawn like TradingView (seeded with the first value), blank for the first `len` bars while it warms up. */
export function emaSeries(values: number[], len: number): Series {
  const a = 2 / (len + 1);
  const out: Series = [];
  let e = NaN;
  values.forEach((v, i) => { e = i === 0 ? v : a * v + (1 - a) * e; out.push(i + 1 >= len ? e : undefined); });
  return out;
}

/** Session VWAP from 10-minute bars, (H+L+C)/3 weighted by volume, restarting each day. */
export function sessionVwap(bars: CBar[]): Series {
  const out: Series = [];
  let day = '', pv = 0, vv = 0;
  for (const b of bars) {
    if (b.date !== day) { day = b.date; pv = 0; vv = 0; }
    pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v;
    out.push(vv > 0 ? pv / vv : undefined);
  }
  return out;
}

export interface ProfileRow { lo: number; hi: number; v: number }
/** Volume profile of some bars (each bar's volume spread over the rows its range covers) and its POC. */
export function volumeProfile(bars: CBar[], rows = 30): { rows: ProfileRow[]; poc?: number } {
  if (!bars.length) return { rows: [] };
  const hi = Math.max(...bars.map((b) => b.h)), lo = Math.min(...bars.map((b) => b.l));
  if (!(hi > lo)) return { rows: [], poc: bars[0].c };
  const size = (hi - lo) / rows;
  const out: ProfileRow[] = Array.from({ length: rows }, (_, i) => ({ lo: lo + i * size, hi: lo + (i + 1) * size, v: 0 }));
  for (const b of bars) {
    if (b.v <= 0) continue;
    if (b.h <= b.l) { out[Math.min(rows - 1, Math.floor((b.c - lo) / size))].v += b.v; continue; }
    for (const r of out) { const ov = Math.min(b.h, r.hi) - Math.max(b.l, r.lo); if (ov > 0) r.v += b.v * (ov / (b.h - b.l)); }
  }
  const asBars: Bar[] = bars.map((b) => ({ t: b.t / 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  return { rows: out, poc: pointOfControl(asBars, rows) };
}

const tenOf = (sessions: Session[]): CBar[] => tenMinuteBars(sessions).map((b) => ({ t: b.start * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, date: istDate(b.start * 1000) }));

export interface Intraday {
  bars: CBar[];
  vwap: Series;
  ema200: Series;
  /** Nifty 500 % vs its previous session's close, on the stock's bars */
  niftyPct: Series;
  /** index range of each session */
  sessions: { date: string; from: number; to: number }[];
  /** the shown day's volume profile (30 rows, like the co-pilot) */
  profile: { rows: ProfileRow[]; poc?: number };
  minuteSessions: Session[];
  niftySessions: Session[];
}

export function buildIntraday(minute: Candles, nifty: Candles, day: string): Intraday {
  const minuteSessions = toSessions(minute);
  const niftySessions = toSessions(nifty);
  const bars = tenOf(minuteSessions);
  const sessions: Intraday['sessions'] = [];
  bars.forEach((b, i) => { const s = sessions[sessions.length - 1]; if (s?.date === b.date) s.to = i; else sessions.push({ date: b.date, from: i, to: i }); });
  // Nifty: each 10-minute close against the previous session's last close
  const nBars = tenOf(niftySessions);
  const nPct = new Map<number, number>();
  let prevClose: number | undefined, curDay = '', lastClose: number | undefined;
  for (const b of nBars) {
    if (b.date !== curDay) { prevClose = lastClose; curDay = b.date; }
    if (prevClose) nPct.set(b.t, (b.c / prevClose - 1) * 100);
    lastClose = b.c;
  }
  const dayBars = bars.filter((b) => b.date === day);
  return {
    bars, sessions, minuteSessions, niftySessions,
    vwap: sessionVwap(bars),
    ema200: emaSeries(bars.map((b) => b.c), 200),
    niftyPct: bars.map((b) => nPct.get(b.t)),
    profile: volumeProfile(dayBars, 30),
  };
}

export interface Daily { bars: CBar[]; ema20: Series; ema50: Series; ema200: Series }

/** Daily bars; if the day itself is not in the daily candles yet (still trading), it is built from its minutes. */
export function buildDaily(daily: Candles | undefined, minute: Candles, day: string): Daily {
  const bars: CBar[] = [];
  const d = daily ?? { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < d.t.length; i++) bars.push({ t: d.t[i] * 1000, o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i], v: d.v[i], date: istDate(d.t[i] * 1000) });
  if (!bars.some((b) => b.date === day)) {
    const s = toSessions(minute).find((x) => x.date === day);
    if (s?.bars.length) {
      const b = s.bars;
      bars.push({ t: Date.parse(`${day}T00:00:00Z`) - IST, o: b[0].o, h: Math.max(...b.map((x) => x.h)), l: Math.min(...b.map((x) => x.l)), c: b[b.length - 1].c, v: b.reduce((a, x) => a + x.v, 0), date: day });
    }
  }
  bars.sort((a, b) => a.t - b.t);
  const closes = bars.map((b) => b.c);
  return { bars, ema20: emaSeries(closes, 20), ema50: emaSeries(closes, 50), ema200: emaSeries(closes, 200) };
}

/* ---- the trade --------------------------------------------------------------------------------------------------- */

export type SignalKind = 'MFE' | 'R08' | 'VWAP_RECLAIM' | 'GIVEBACK';
export interface Signal { kind: SignalKind; t: number; price: number; label: string; detail: string }

export interface TradeInput {
  date: string;
  direction: 'LONG' | 'SHORT';
  marks: TradeMark[];
  initialStop?: number;
  /** per-share distance to the first stop (the sheet's InitialStopDist) */
  stopDist?: number;
  lastStop?: number;
  target?: number;
}

export interface TradeFacts {
  entryAt: number; exitAt?: number; avgEntry: number; avgExit?: number; qty: number;
  /** 1R per share and what it is based on (like the sheet's RBasis) */
  oneR?: number; rBasis?: 'STOP' | '2ATR';
  oneRPrice?: number;
  mfe?: { t: number; price: number; perShare: number; inr: number; r?: number };
  mae?: { t: number; price: number; perShare: number; inr: number; r?: number };
  niftyDuringPct?: number;
  signals: Signal[];
}

const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Nifty close at (the last minute at or before) `ms`. */
function niftyAt(sessions: Session[], ms: number): number | undefined {
  let best: number | undefined;
  for (const s of sessions) for (const b of s.bars) { if (b.t * 1000 <= ms) best = b.c; else return best; }
  return best;
}

/**
 * Average entry, 1R, best / worst open price, and the exit signals:
 *  - R08: open profit first reached 0.8R (noting when Nifty was moving against the trade then: protect the gain)
 *  - VWAP_RECLAIM: a completed 10-minute bar closed back across VWAP against him on heavy volume (1.5x the day's
 *    median 10-minute volume so far): the move he was in has failed
 *  - GIVEBACK: after at least 0.5R, half of the best open profit was given back
 */
export function tradeFacts(intra: Intraday, t: TradeInput): TradeFacts | undefined {
  const entries = t.marks.filter((m) => m.role !== 'EXIT'), exits = t.marks.filter((m) => m.role === 'EXIT');
  if (!entries.length) return undefined;
  const qty = entries.reduce((a, m) => a + m.qty, 0);
  const avgEntry = entries.reduce((a, m) => a + m.qty * m.price, 0) / qty;
  const exitQty = exits.reduce((a, m) => a + m.qty, 0);
  const avgExit = exitQty ? exits.reduce((a, m) => a + m.qty * m.price, 0) / exitQty : undefined;
  const entryAt = entries[0].t, exitAt = exits.length ? exits[exits.length - 1].t : undefined;
  const long = t.direction === 'LONG', dir = long ? 1 : -1;
  const entryMinute = Math.floor(entryAt / 60_000) * 60_000;
  const day = intra.minuteSessions.find((s) => s.date === t.date);
  const out: TradeFacts = { entryAt, exitAt, avgEntry, avgExit, qty, signals: [] };

  // 1R: the stop distance, else 2 x ATR(10m) from the bars completed before the entry (same as MfeR)
  const stopDist = t.stopDist && t.stopDist > 0 ? t.stopDist : t.initialStop ? Math.abs(avgEntry - t.initialStop) : undefined;
  if (stopDist && stopDist > 0) { out.oneR = stopDist; out.rBasis = 'STOP'; }
  else {
    const before = intra.minuteSessions.filter((s) => s.date <= t.date)
      .map((s) => (s.date === t.date ? { ...s, bars: s.bars.filter((b) => b.t * 1000 < entryMinute) } : s)).filter((s) => s.bars.length);
    const atr = wilderAtr(tenMinuteBars(before));
    const a = atr[atr.length - 1];
    if (Number.isFinite(a) && a > 0) { out.oneR = 2 * a; out.rBasis = '2ATR'; }
  }
  if (out.oneR) out.oneRPrice = avgEntry + dir * out.oneR;
  if (!day) return out;

  const end = exitAt ?? day.bars[day.bars.length - 1].t * 1000;
  const win = day.bars.filter((b) => b.t * 1000 >= entryMinute && b.t * 1000 <= end);
  if (!win.length) return out;
  const fav = (b: Bar) => (long ? b.h - avgEntry : avgEntry - b.l);
  const adv = (b: Bar) => (long ? avgEntry - b.l : b.h - avgEntry);
  let best = win[0], worst = win[0];
  for (const b of win) { if (fav(b) > fav(best)) best = b; if (adv(b) > adv(worst)) worst = b; }
  const R = (x: number) => (out.oneR ? r2(x / out.oneR) : undefined);
  if (fav(best) > 0) out.mfe = { t: best.t * 1000, price: long ? best.h : best.l, perShare: fav(best), inr: fav(best) * qty, r: R(fav(best)) };
  if (adv(worst) > 0) out.mae = { t: worst.t * 1000, price: long ? worst.l : worst.h, perShare: adv(worst), inr: adv(worst) * qty, r: R(adv(worst)) };
  const nE = niftyAt(intra.niftySessions, entryAt), nX = niftyAt(intra.niftySessions, end);
  if (nE && nX) out.niftyDuringPct = r2((nX / nE - 1) * 100);

  if (out.mfe) out.signals.push({ kind: 'MFE', t: out.mfe.t, price: out.mfe.price, label: `Peak ${out.mfe.r !== undefined ? `${out.mfe.r}R` : `₹${Math.round(out.mfe.inr)}`}`, detail: `Best open profit ≈ ₹${Math.round(out.mfe.inr)} (${out.mfe.perShare.toFixed(2)}/share${out.mfe.r !== undefined ? `, ${out.mfe.r}R` : ''}) at ${istHHMM(out.mfe.t)}` });

  if (out.oneR) {
    const hit = win.find((b) => fav(b) >= 0.8 * out.oneR!);
    if (hit) {
      const ms = hit.t * 1000;
      const n0 = niftyAt(intra.niftySessions, ms - 10 * 60_000), n1 = niftyAt(intra.niftySessions, ms);
      const nMove = n0 && n1 ? (n1 / n0 - 1) * 100 : undefined;
      const against = nMove !== undefined && dir * nMove < -0.05;
      out.signals.push({
        kind: 'R08', t: ms, price: avgEntry + dir * 0.8 * out.oneR,
        label: against ? '0.8R · Nifty against' : '0.8R',
        detail: `Open profit reached 0.8R at ${istHHMM(ms)}${nMove !== undefined ? `; Nifty ${nMove >= 0 ? '+' : ''}${nMove.toFixed(2)}% in the last 10 min` : ''}${against ? ' (moving against the trade: protect the gain)' : ''}`,
      });
    }
    if (out.mfe && out.mfe.perShare >= 0.5 * out.oneR) {
      const after = win.filter((b) => b.t * 1000 > out.mfe!.t);
      const give = after.find((b) => (long ? b.l - avgEntry : avgEntry - b.h) <= 0.5 * out.mfe!.perShare);
      if (give) out.signals.push({ kind: 'GIVEBACK', t: give.t * 1000, price: avgEntry + dir * 0.5 * out.mfe.perShare, label: 'Half the peak given back', detail: `At ${istHHMM(give.t * 1000)} half of the best open profit was gone` });
    }
  }

  // VWAP reclaimed against the trade on heavy volume (completed 10-minute bars from the entry bar to the exit)
  const bars = intra.bars;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1], v = intra.vwap[i], pv = intra.vwap[i - 1];
    if (b.date !== t.date || prev.date !== t.date || v === undefined || pv === undefined) continue;
    const barEnd = b.t + 10 * 60_000;
    if (barEnd <= entryAt || b.t > end) continue;
    const crossed = long ? prev.c >= pv && b.c < v : prev.c <= pv && b.c > v;
    if (!crossed) continue;
    const med = median(bars.slice(0, i).filter((x) => x.date === t.date).map((x) => x.v));
    if (med > 0 && b.v >= 1.5 * med) {
      out.signals.push({ kind: 'VWAP_RECLAIM', t: barEnd, price: b.c, label: `VWAP lost · ${(b.v / med).toFixed(1)}x vol`, detail: `The ${istHHMM(b.t)} bar closed back ${long ? 'below' : 'above'} VWAP on ${(b.v / med).toFixed(1)}x the day's usual 10-min volume: the move had failed` });
      break;
    }
  }
  out.signals.sort((a, b) => a.t - b.t);
  return out;
}
