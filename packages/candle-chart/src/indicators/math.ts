import type { Bar } from '../types';

/** Series maths. Every function returns an array as long as its input; a value that cannot be worked out yet is NaN. */

export type Src = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4' | 'volume';
export const SOURCES: Src[] = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];

export function source(bars: Bar[], s: Src | string): number[] {
  switch (s) {
    case 'open': return bars.map((b) => b.o);
    case 'high': return bars.map((b) => b.h);
    case 'low': return bars.map((b) => b.l);
    case 'hl2': return bars.map((b) => (b.h + b.l) / 2);
    case 'hlc3': return bars.map((b) => (b.h + b.l + b.c) / 3);
    case 'ohlc4': return bars.map((b) => (b.o + b.h + b.l + b.c) / 4);
    case 'volume': return bars.map((b) => b.v);
    default: return bars.map((b) => b.c);
  }
}

const nan = (n: number) => new Array<number>(n).fill(NaN);

export function sma(x: number[], n: number): number[] {
  const out = nan(x.length);
  let sum = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (Number.isFinite(v)) { sum += v; cnt++; }
    if (i >= n) { const o = x[i - n]; if (Number.isFinite(o)) { sum -= o; cnt--; } }
    if (i >= n - 1 && cnt === n) out[i] = sum / n;
  }
  return out;
}

/** EMA seeded with the SMA of the first n values (TradingView's ta.ema). Leading NaNs are skipped. */
export function ema(x: number[], n: number): number[] {
  const out = nan(x.length);
  const k = 2 / (n + 1);
  let prev = NaN, seed = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) { if (Number.isFinite(prev)) out[i] = prev; continue; }
    if (!Number.isFinite(prev)) {
      seed += v; cnt++;
      if (cnt === n) { prev = seed / n; out[i] = prev; }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (TradingView's ta.rma). */
export function rma(x: number[], n: number): number[] {
  const out = nan(x.length);
  let prev = NaN, seed = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) { if (Number.isFinite(prev)) out[i] = prev; continue; }
    if (!Number.isFinite(prev)) { seed += v; cnt++; if (cnt === n) { prev = seed / n; out[i] = prev; } continue; }
    prev = (prev * (n - 1) + v) / n;
    out[i] = prev;
  }
  return out;
}

export function wma(x: number[], n: number): number[] {
  const out = nan(x.length);
  const den = (n * (n + 1)) / 2;
  for (let i = n - 1; i < x.length; i++) {
    let s = 0, ok = true;
    for (let j = 0; j < n; j++) { const v = x[i - j]; if (!Number.isFinite(v)) { ok = false; break; } s += v * (n - j); }
    if (ok) out[i] = s / den;
  }
  return out;
}

export function hma(x: number[], n: number): number[] {
  const a = wma(x, Math.max(1, Math.floor(n / 2))), b = wma(x, n);
  return wma(a.map((v, i) => 2 * v - b[i]), Math.max(1, Math.round(Math.sqrt(n))));
}

export function vwma(x: number[], vol: number[], n: number): number[] {
  const pv = sma(x.map((v, i) => v * vol[i]), n), vv = sma(vol, n);
  return pv.map((v, i) => (vv[i] > 0 ? v / vv[i] : NaN));
}

export function stdev(x: number[], n: number): number[] {
  const m = sma(x, n);
  const out = nan(x.length);
  for (let i = n - 1; i < x.length; i++) {
    if (!Number.isFinite(m[i])) continue;
    let s = 0;
    for (let j = 0; j < n; j++) { const d = x[i - j] - m[i]; s += d * d; }
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

export function highest(x: number[], n: number): number[] {
  const out = nan(x.length);
  for (let i = n - 1; i < x.length; i++) { let m = -Infinity; for (let j = 0; j < n; j++) m = Math.max(m, x[i - j]); out[i] = m; }
  return out;
}
export function lowest(x: number[], n: number): number[] {
  const out = nan(x.length);
  for (let i = n - 1; i < x.length; i++) { let m = Infinity; for (let j = 0; j < n; j++) m = Math.min(m, x[i - j]); out[i] = m; }
  return out;
}

export function trueRange(bars: Bar[]): number[] {
  return bars.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l));
}
export const atr = (bars: Bar[], n: number) => rma(trueRange(bars), n);

export function change(x: number[], n = 1): number[] {
  return x.map((v, i) => (i >= n ? v - x[i - n] : NaN));
}

export function rsi(x: number[], n: number): number[] {
  const ch = change(x);
  const up = rma(ch.map((v) => (Number.isFinite(v) ? Math.max(v, 0) : NaN)), n);
  const dn = rma(ch.map((v) => (Number.isFinite(v) ? Math.max(-v, 0) : NaN)), n);
  return up.map((u, i) => (dn[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / dn[i])));
}

export function stoch(src: number[], hi: number[], lo: number[], n: number): number[] {
  const h = highest(hi, n), l = lowest(lo, n);
  return src.map((v, i) => (h[i] - l[i] > 0 ? (100 * (v - l[i])) / (h[i] - l[i]) : NaN));
}

/** Session VWAP (resets at each new local day), with standard-deviation bands. */
export function sessionVwap(bars: Bar[], src: number[], tz: number) {
  const vwap = nan(bars.length), sd = nan(bars.length);
  let day = NaN, pv = 0, v = 0, p2v = 0;
  for (let i = 0; i < bars.length; i++) {
    const d = Math.floor((bars[i].t + tz) / 86400);
    if (d !== day) { day = d; pv = 0; v = 0; p2v = 0; }
    pv += src[i] * bars[i].v; v += bars[i].v; p2v += src[i] * src[i] * bars[i].v;
    if (v > 0) { const m = pv / v; vwap[i] = m; sd[i] = Math.sqrt(Math.max(0, p2v / v - m * m)); }
    else if (i && Number.isFinite(vwap[i - 1]) && Math.floor((bars[i - 1].t + tz) / 86400) === d) { vwap[i] = vwap[i - 1]; sd[i] = sd[i - 1]; }
  }
  return { vwap, sd };
}

/** One value per bar from the PREVIOUS local day's high / low / close (for pivots and the prior-day levels). */
export function prevDay(bars: Bar[], tz: number) {
  const ph = nan(bars.length), pl = nan(bars.length), pc = nan(bars.length);
  let day = NaN, h = -Infinity, l = Infinity, c = NaN, lh = NaN, ll = NaN, lc = NaN;
  for (let i = 0; i < bars.length; i++) {
    const d = Math.floor((bars[i].t + tz) / 86400);
    if (d !== day) {
      if (Number.isFinite(day)) { lh = h; ll = l; lc = c; }
      day = d; h = -Infinity; l = Infinity;
    }
    h = Math.max(h, bars[i].h); l = Math.min(l, bars[i].l); c = bars[i].c;
    ph[i] = lh; pl[i] = ll; pc[i] = lc;
  }
  return { ph, pl, pc };
}
