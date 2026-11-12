import type { Bar, Interval, TimeOpts } from './types';

/** Minutes in an interval ('5' -> 5); day-based intervals (D, W, M) -> 0. */
export function intervalMinutes(iv: Interval): number {
  const n = Number(iv);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
export const isIntraday = (iv: Interval) => intervalMinutes(iv) > 0;

/** Seconds a bar covers (used to step beyond the last bar). A day-based bar counts as one calendar day / week / month. */
export function intervalSeconds(iv: Interval): number {
  const m = intervalMinutes(iv);
  if (m) return m * 60;
  if (/^\d*W$/.test(iv)) return 7 * 86400 * (parseInt(iv) || 1);
  if (/^\d*M$/.test(iv)) return 30 * 86400 * (parseInt(iv) || 1);
  return 86400 * (parseInt(iv) || 1);
}

/** TradingView-style short name: 5m, 1h, 1D, 1W. */
export function intervalLabel(iv: Interval): string {
  const m = intervalMinutes(iv);
  if (m) return m % 60 === 0 ? `${m / 60}h` : `${m}m`;
  const k = parseInt(iv) || 1;
  return `${k}${iv.replace(/^\d+/, '')}`;
}

/** Local (exchange-time) parts of a Unix-second time. */
export function localParts(t: number, tz: number) {
  const d = new Date((t + tz) * 1000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes(), sec: d.getUTCSeconds() };
}
/** Unix seconds of local midnight of the day `t` falls on. */
export function localDayStart(t: number, tz: number): number {
  return Math.floor((t + tz) / 86400) * 86400 - tz;
}

/**
 * Builds bars of `iv` from finer bars (1-minute -> 10-minute, daily -> weekly). Intraday buckets start at the session
 * open (NSE hourly bars are 09:15, 10:15, ... like TradingView's); weeks start on Monday; months on the 1st.
 * Bars must be in time order. A bar is kept even when it covers a minute or two that never traded.
 */
export function aggregate(src: Bar[], iv: Interval, time: TimeOpts): Bar[] {
  const m = intervalMinutes(iv);
  const tz = time.tzOffsetSec;
  const keyOf = (t: number): number => {
    if (m) {
      const day = localDayStart(t, tz);
      const min = Math.floor((t - day) / 60);
      const off = min - time.sessionOpenMin;
      const b = off >= 0 ? Math.floor(off / m) * m : -Math.ceil(-off / m) * m;
      return day + (time.sessionOpenMin + b) * 60;
    }
    const day = localDayStart(t, tz);
    if (/W$/.test(iv)) { const wd = (localParts(t, tz).wd + 6) % 7; return day - wd * 86400; }
    if (/M$/.test(iv)) { const p = localParts(t, tz); return Date.UTC(p.y, p.mo, 1) / 1000 - tz; }
    return day;
  };
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of src) {
    const k = keyOf(b.t);
    if (cur && cur.t === k) {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c; cur.v += b.v;
    } else {
      cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      out.push(cur);
    }
  }
  return out;
}

/** Heikin Ashi candles (TradingView's formula). */
export function heikinAshi(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const c = (b.o + b.h + b.l + b.c) / 4;
    const o = i ? (out[i - 1].o + out[i - 1].c) / 2 : (b.o + b.c) / 2;
    out.push({ t: b.t, o, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c), c, v: b.v });
  }
  return out;
}

/** Index of the last bar with time <= t (binary search); -1 when t is before every bar. */
export function indexAtOrBefore(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Joins two sorted bar lists (newer wins on equal times). */
export function mergeBars(a: Bar[], b: Bar[]): Bar[] {
  const m = new Map<number, Bar>();
  for (const x of a) m.set(x.t, x);
  for (const x of b) m.set(x.t, x);
  return [...m.values()].sort((x, y) => x.t - y.t);
}

/**
 * Volume candles: each bar's body as a share of its slot (0..1). A bar is measured against the TYPICAL volume around it
 * (the average of the `window` bars up to it), so a sudden huge bar reaches full width without making the others
 * thinner, and nothing changes as the chart scrolls. `full` x typical = the whole share. `effect` up to 1 scales the
 * share; above 1 it is a contrast curve (share^effect). `base` is every bar's minimum.
 */
export function volumeFractions(vol: number[], base: number, effect: number, window = 50, full = 2.5): Float64Array {
  const n = vol.length, pre = new Float64Array(n + 1), out = new Float64Array(n);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (vol[i] || 0);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - window + 1), typical = (pre[i + 1] - pre[a]) / (i + 1 - a);
    const share0 = typical > 0 ? Math.min(1, (vol[i] || 0) / typical / full) : 0.5;
    const share = effect <= 1 ? effect * share0 : Math.pow(share0, effect);
    out[i] = base + (1 - base) * share;
  }
  return out;
}
