import type { Candles } from '../dhan';
import { tenMinuteBars, type Bar, type Session } from '../live/enrich';
import { istParts, SESSION_OPEN_MIN } from '../live/time';
import { hasSuspectGap, nMinuteBars, pointOfControl, pullbackNumber } from '../copilot/features';
import { roundTripCharges, sizeFor } from './costs';
import { CASE_BY_ID, EXIT_KEYS, TARGET_KEYS, timeBucket, type CaseId, type ExitKey, type OutKey, type Outcome, type Rel, type RvolBucket, type Signal, type TargetResult } from './cases';

/**
 * The setup engine: one stock, one day, replayed on the 10-minute chart. Pure code (no network, no clock), so the
 * backtest and the live alerts run exactly the same rules on exactly the same numbers.
 *
 * Decisions happen only when a 10-minute candle closes (09:25, 09:35 ... 14:55), using only the candles closed by
 * then; the entry is that close. Bars are aligned at 09:15; ATR(14) / the 200 EMAs / VWAP / POC are computed the same
 * way as the co-pilot. The stop goes beyond a solid swing (tested, rejected, unbroken; see swingStop) and is never
 * wider than 2x ATR. 1-minute candles are used only to follow a trade (which came first inside a 10-minute candle,
 * the stop or the target). Anything still open is closed at 15:00 (he never trades the last 30 minutes).
 */

export interface Params {
  /** his max risk per trade (sizes every trade, so charges are counted at his real size) */
  riskInr: number;
  /** Nifty 500 move (%) that counts as directional: first 5 minutes and open -> now */
  niftyDirPct: number;
  /** Nifty 500 move (%) over the 30 minutes before a trade that counts as moving */
  niftyRecentPct: number;
  /** a 200 EMA this close (in ATR) in the trade's path is "in the way" */
  emaReachAtr: number;
  /** volume profile rows (TradingView "Number of rows") */
  pocRows: number;
}
export const DEFAULT_PARAMS: Params = { riskInr: 300, niftyDirPct: 0.15, niftyRecentPct: 0.05, emaReachAtr: 2, pocRows: 30 };

export const FIRST_DECISION = 10;  // 09:25, the first 10-minute close
export const LAST_DECISION = 340;  // 14:55, the close of the 14:45-14:54 candle
export const EXIT_SLOT = 345;      // 15:00: anything open is closed at the 14:59 close
/** the research cases decided at 15:00 (last half hour) are held to the 15:29 close */
export const LATE_SLOT = 345;
export const CLOSE_SLOT = 375;

export interface DayInput {
  symbol: string;
  date: string;
  /** 1-minute sessions BEFORE `date`, oldest first (the last 20 are used) */
  history: Session[];
  /** today's 1-minute bars (only the ones that are complete) */
  day: Bar[];
  /** Nifty 500's 1-minute bars today */
  nifty: Bar[];
  /** daily candles strictly BEFORE `date` (about 5 years: the daily 200 EMA needs 600) */
  daily: Candles;
  params?: Partial<Params>;
  /** backtest: follow every signal to its outcome (needs the whole day). Live: false. */
  simulate?: boolean;
}

/* ---- minute slots ---------------------------------------------------------------------------------------- */

export interface Slots { o: number[]; h: number[]; l: number[]; c: number[]; v: number[]; n: number; bars: Bar[] }

/**
 * Today's bars by minute of the session. The first must be the 09:15 candle (otherwise every number measured from the
 * open would be wrong, and the day is skipped). A minute with no trades is filled flat at the last close, volume 0.
 */
export function toSlots(bars: Bar[]): Slots | undefined {
  if (!bars.length) return undefined;
  const slotOf = (b: Bar) => istParts(b.t * 1000).minuteOfDay - SESSION_OPEN_MIN;
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  if (slotOf(sorted[0]) !== 0) return undefined;
  const t0 = sorted[0].t;
  const s: Slots = { o: [], h: [], l: [], c: [], v: [], n: 0, bars: [] };
  for (const b of sorted) {
    const k = slotOf(b);
    if (k < 0 || k >= 375 || k < s.n) continue;
    while (s.n < k) { // gap: flat at the last close
      const pc = s.c[s.n - 1];
      s.o.push(pc); s.h.push(pc); s.l.push(pc); s.c.push(pc); s.v.push(0);
      s.bars.push({ t: t0 + s.n * 60, o: pc, h: pc, l: pc, c: pc, v: 0 });
      s.n++;
    }
    s.o.push(b.o); s.h.push(b.h); s.l.push(b.l); s.c.push(b.c); s.v.push(b.v);
    s.bars.push({ t: t0 + k * 60, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    s.n++;
  }
  return s;
}

/* ---- small helpers ---------------------------------------------------------------------------------------- */

export interface B10 { o: number; h: number; l: number; c: number; v: number }

export const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const dirOf = (pct: number | undefined, th: number): 1 | -1 | 0 => (pct === undefined ? 0 : pct >= th ? 1 : pct <= -th ? -1 : 0);
const rel = (d: 1 | -1, x: 1 | -1 | 0): Rel => (x === 0 ? 'FLAT' : x === d ? 'WITH' : 'AGAINST');
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Yesterday's value area (70% of the volume around the POC) from its 1-minute bars, TradingView-style rows. */
export function valueArea(bars: Bar[], rows: number): { vah: number; val: number; poc: number } | undefined {
  if (!bars.length || rows < 2) return undefined;
  const hi = Math.max(...bars.map((b) => b.h)), lo = Math.min(...bars.map((b) => b.l));
  if (!(hi > lo)) return undefined;
  const size = (hi - lo) / rows;
  const vol = new Array<number>(rows).fill(0);
  for (const b of bars) {
    if (b.v <= 0) continue;
    if (b.h <= b.l) { vol[Math.min(rows - 1, Math.floor((b.c - lo) / size))] += b.v; continue; }
    for (let i = 0; i < rows; i++) {
      const rLo = lo + i * size, ov = Math.min(b.h, rLo + size) - Math.max(b.l, rLo);
      if (ov > 0) vol[i] += b.v * (ov / (b.h - b.l));
    }
  }
  const total = vol.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return undefined;
  let p = 0;
  for (let i = 1; i < rows; i++) if (vol[i] > vol[p]) p = i;
  let a = p, z = p, inside = vol[p];
  while (inside < 0.7 * total && (a > 0 || z < rows - 1)) {
    const up = z < rows - 1 ? vol[z + 1] : -1, dn = a > 0 ? vol[a - 1] : -1;
    if (up >= dn) { z++; inside += vol[z]; } else { a--; inside += vol[a]; }
  }
  return { val: lo + a * size, vah: lo + (z + 1) * size, poc: lo + (p + 0.5) * size };
}

/** EMA as TradingView's ta.ema (seeded with the first value), carried bar by bar. */
export class Ema {
  n = 0; e = NaN;
  constructor(private len: number) {}
  get a() { return 2 / (this.len + 1); }
  push(x: number) { this.e = this.n === 0 ? x : this.a * x + (1 - this.a) * this.e; this.n++; }
  /** the value with one more (forming) bar at `x`; undefined until there are 3x len values, like the co-pilot */
  peek(x?: number): number | undefined {
    const n = this.n + (x === undefined ? 0 : 1);
    if (n < this.len * 3) return undefined;
    return x === undefined ? this.e : this.n === 0 ? x : this.a * x + (1 - this.a) * this.e;
  }
}

/** Wilder ATR(14) as lib/live/enrich.ts computes it (first value = the first true range), carried bar by bar. */
export class Atr {
  n = 0; v = NaN; lastClose = NaN;
  private tr(b: B10) { let tr = b.h - b.l; if (this.n > 0) tr = Math.max(tr, Math.abs(b.h - this.lastClose), Math.abs(b.l - this.lastClose)); return tr; }
  push(b: B10) { const tr = this.tr(b); this.v = this.n === 0 ? tr : (13 / 14) * this.v + tr / 14; this.n++; this.lastClose = b.c; }
  peek(forming?: B10): number | undefined {
    if (!forming) return this.n >= 14 ? this.v : undefined;
    if (this.n + 1 < 14) return undefined;
    const tr = this.tr(forming);
    return this.n === 0 ? tr : (13 / 14) * this.v + tr / 14;
  }
}

export function barOf(s: Slots, from: number, toExcl: number): B10 {
  let h = -Infinity, l = Infinity, v = 0;
  for (let i = from; i < toExcl; i++) { if (s.h[i] > h) h = s.h[i]; if (s.l[i] < l) l = s.l[i]; v += s.v[i]; }
  return { o: s.o[from], h, l, c: s.c[toExcl - 1], v };
}

/* ---- solid swings (the stop) ------------------------------------------------------------------------------ */

/**
 * The stop the way he sets it: just beyond the nearest SOLID swing on the stop side, on the 10-minute chart.
 * Solid = all of:
 *  - a swing: a 10-min low (high) at or below the two candles before it and the one after it;
 *  - with width: price moved at least 0.75 ATR away from it afterwards;
 *  - tested: a later candle came back within 0.25 ATR of it and closed back above (below) it (the rejection), which
 *    can be the entry candle itself;
 *  - unbroken: no candle since closed beyond it or traded more than 0.15 ATR through it, up to the entry.
 * Stop = 0.1 ATR beyond it (at least 0.25 ATR from the entry). The nearest solid swing more than 2x ATR away = no
 * trade (FAR). No solid swing at all = 2x ATR (ATR2).
 */
export function swingStop(d: 1 | -1, price: number, atr: number, bars: B10[]): { stop: number; type: 'SWING' | 'ATR2' | 'FAR' } {
  const n = bars.length;
  let best: number | undefined;
  for (let i = 2; i < n - 1; i++) {
    const S = d === 1 ? bars[i].l : bars[i].h;
    const beyond = (x: number) => (S - x) * d;           // > 0 = x is past S on the stop side
    if ((price - S) * d <= 0) continue;                   // must be on the stop side of the entry
    const ext = (b: B10) => (d === 1 ? b.l : b.h);
    if (![bars[i - 2], bars[i - 1], bars[i + 1]].every((b) => beyond(ext(b)) <= 0)) continue;
    let wide = false, tested = false, broken = false;
    for (let j = i + 1; j < n; j++) {
      const b = bars[j];
      if ((S - b.c) * d > 0 || beyond(ext(b)) > 0.15 * atr) { broken = true; break; }
      // a test: back within 0.25 ATR of the swing after the move away, and closed back (a long candle can do both)
      if (wide && -beyond(ext(b)) <= 0.25 * atr && (b.c - S) * d > 0) tested = true;
      if ((d === 1 ? b.h - S : S - b.l) >= 0.75 * atr) wide = true;
    }
    if (broken || !wide || !tested) continue;
    if (best === undefined || (S - best) * d > 0) best = S;   // the nearest one to the entry
  }
  if (best === undefined) return { stop: price - d * 2 * atr, type: 'ATR2' };
  let stop = best - d * 0.1 * atr;
  if ((price - stop) * d < 0.25 * atr) stop = price - d * 0.25 * atr;
  if ((price - stop) * d > 2 * atr) return { stop, type: 'FAR' };
  return { stop, type: 'SWING' };
}

/* ---- tests of the day's high / low ----------------------------------------------------------------------- */

/**
 * The day's high (low) zone and its tests, on 10-minute candles. The first candle to make the high is test 1; price
 * then has to pull back 0.5 ATR+ before a candle that reaches within 0.25 ATR of the high again counts as the next
 * test. A new high more than 0.25 ATR above the zone starts a new zone (test 1 again).
 */
export class Zone {
  level = NaN; tests: number[] = []; pulled = false;
  constructor(private d: 1 | -1) {} // 1 = the day's high, -1 = the day's low
  push(b: B10, slot: number, atr: number) {
    const ext = this.d === 1 ? b.h : b.l;
    const far = (x: number) => (x - this.level) * this.d; // > 0 = beyond the level
    let inZone = true;
    if (!Number.isFinite(this.level) || far(ext) > 0.25 * atr) { this.level = ext; this.tests = [slot]; this.pulled = false; }
    else if (far(ext) >= -0.25 * atr) {
      if (this.pulled) { this.tests.push(slot); this.pulled = false; }
      if (far(ext) > 0) this.level = ext;
    } else inZone = false;
    // the pullback: a candle that reached the zone counts only by its close (its low may have come before it got there)
    const away = inZone ? b.c : this.d === 1 ? b.l : b.h;
    const back = (this.level - away) * this.d;
    if (back >= 0.5 * atr) this.pulled = true;
  }
  /** the test number of a candle that is in the zone now (0 = not in the zone) */
  testOf(b: B10, atr: number) { const ext = this.d === 1 ? b.h : b.l; return (ext - this.level) * this.d >= -0.25 * atr ? this.tests.length : 0; }
}

/* ---- the day ---------------------------------------------------------------------------------------------- */

/** the breakout setups the breakout fade (FB) takes the other way */
const FADED = new Set<CaseId>(['A', 'G', 'I', 'M1', 'M2', 'M6', 'M7']);

interface ExitCtx { obstacle?: number; medV: number; adr: number; dayHi: number; dayLo: number; entryBar: B10 }
interface Draft { id: CaseId; d: 1 | -1; stop: number; stopType: 'SWING' | 'ATR2' | 'FAR'; target: number; slot: number; price: number; atr: number; ctx: DimCtx; ex: ExitCtx; testNo: number; tests: number[]; level: Signal['level']; pullbackNo: number }
interface DimCtx { nFirst5?: number; nDay?: number; nRecent?: number; rvolSame?: number; openBusy: boolean; ext?: number; e5?: number; e10?: number; e1d?: number; gapPct: number }

export function runDay(inp: DayInput): Signal[] {
  const P: Params = { ...DEFAULT_PARAMS, ...inp.params };
  const day = toSlots(inp.day), nifty = toSlots(inp.nifty);
  if (!day || !nifty) return [];
  const daily = inp.daily;
  const nd = daily.c.length;
  if (nd < 10) return [];

  // ---- from before the day
  const hist = inp.history.filter((s) => s.date < inp.date && s.bars.length).slice(-20);
  const atrC = new Atr(), ema10 = new Ema(200), ema5 = new Ema(200);
  for (const b of tenMinuteBars(hist)) { atrC.push(b); ema10.push(b.c); }
  for (const b of nMinuteBars(hist, 5)) ema5.push(b.c);
  const suspect = hasSuspectGap(daily);
  const ema1d = new Ema(200);
  if (!suspect) for (const c of daily.c) ema1d.push(c);
  const adr = daily.h.slice(-10).reduce((a, h, i) => a + h - daily.l[nd - 10 + i], 0) / 10;
  const prevClose = daily.c[nd - 1], pdh = daily.h[nd - 1], pdl = daily.l[nd - 1];
  const open = day.o[0];
  const gapPct = prevClose > 0 ? (open / prevClose - 1) * 100 : 0;
  if (!(adr > 0) || Math.abs(gapPct) > 20) return []; // a 20% gap is a corporate action, not a trading day

  // relative volume baselines: same time of day (cumulative by minute) and full day, over the last 10 sessions
  const priors = hist.slice(-10).map((s) => {
    const cum = new Array<number>(376).fill(0);
    for (const b of s.bars) { const k = istParts(b.t * 1000).minuteOfDay - SESSION_OPEN_MIN; if (k >= 0 && k < 375) cum[k + 1] += b.v; }
    for (let k = 1; k <= 375; k++) cum[k] += cum[k - 1];
    return cum;
  }).filter((cum) => cum[375] > 0);
  const sameAvg = (k: number) => (priors.length >= 5 ? priors.reduce((a, c) => a + c[k], 0) / priors.length : NaN);
  const fullAvg = priors.length >= 5 ? priors.reduce((a, c) => a + c[375], 0) / priors.length : NaN;
  const prevSession = hist.at(-1);
  const pva = prevSession ? valueArea(prevSession.bars, P.pocRows) : undefined;
  const openInVa = !!pva && open >= pva.val && open <= pva.vah;
  const medBase = tenMinuteBars(hist.slice(-2)).map((b) => b.v);
  // yesterday's 10-minute candles: a solid swing can be from yesterday
  const prevTens: B10[] = prevSession ? tenMinuteBars([prevSession]) : [];

  const K = Math.min(day.n, nifty.n);
  const lastK = Math.min(K, LATE_SLOT);
  const nOpen = nifty.o[0];
  const nPct = (i: number) => (nifty.c[i] / nOpen - 1) * 100;
  const nFirst5 = K >= 5 ? (nifty.c[4] / nOpen - 1) * 100 : undefined;

  // ---- running state for the day
  const tens: B10[] = [];
  const hiBefore: number[] = [], loBefore: number[] = []; // the day's high / low before each 10-min candle
  const hiZone = new Zone(1), loZone = new Zone(-1);
  let pv = 0, vv = 0, cumV = 0;
  let dayHi = -Infinity, dayLo = Infinity, lowSinceHi = Infinity, highSinceLo = -Infinity;
  let or10: B10 | undefined, or30: B10 | undefined, openBusy = false;
  let brkHi = -1, maxSinceBrk = -Infinity, brkLo = -1, minSinceBrk = Infinity;
  let medV = median(medBase);
  const fired = new Set<string>();
  const drafts: Draft[] = [];

  for (let k = 1; k <= lastK; k++) {
    // ---- add minute k-1
    const s = k - 1;
    if (s % 10 === 0) { hiBefore.push(dayHi); loBefore.push(dayLo); }
    if (day.h[s] > dayHi) { dayHi = day.h[s]; lowSinceHi = Infinity; } else lowSinceHi = Math.min(lowSinceHi, day.l[s]);
    if (day.l[s] < dayLo) { dayLo = day.l[s]; highSinceLo = -Infinity; } else highSinceLo = Math.max(highSinceLo, day.h[s]);
    cumV += day.v[s];
    if ((s + 1) % 10 === 0) {
      const b = barOf(day, s - 9, s + 1);
      tens.push(b); atrC.push(b); ema10.push(b.c);
      pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v;
      medV = median([...medBase, ...tens.map((x) => x.v)]);
      const a = atrC.peek();
      if (a) { hiZone.push(b, s - 9, a); loZone.push(b, s - 9, a); }
    }
    if ((s + 1) % 5 === 0) ema5.push(day.c[s]);
    if (k === 10) or10 = barOf(day, 0, 10);
    if (k === 30) or30 = barOf(day, 0, 30);
    if (k === 5) openBusy = cumV / fullAvg > 0.1;
    if (or10 && s >= 10) {
      if (brkHi < 0 && day.h[s] > or10.h) brkHi = s;
      if (brkHi >= 0) maxSinceBrk = Math.max(maxSinceBrk, day.h[s]);
      if (brkLo < 0 && day.l[s] < or10.l) brkLo = s;
      if (brkLo >= 0) minSinceBrk = Math.min(minSinceBrk, day.l[s]);
    }
    // ---- decisions only at a 10-minute close (and once at 15:00 for the last-half-hour research cases)
    const late = k === LATE_SLOT;
    if (k < FIRST_DECISION || (!late && (k % 10 !== 0 || k > LAST_DECISION))) continue;

    const L = tens.length;
    const T = tens[L - 1], Pv = tens[L - 2] as B10 | undefined;
    const price = day.c[k - 1]; // = the 10-min close (at 15:00: the 14:59 close)
    const formingBar = k % 10 ? barOf(day, Math.floor(k / 10) * 10, k) : undefined;
    const atr = atrC.peek(formingBar);
    if (!atr || !(atr > 0)) continue;
    const e10 = ema10.peek(formingBar ? price : undefined), e5 = ema5.peek(k % 5 ? price : undefined), e1d = suspect ? undefined : ema1d.peek(price);
    const vwap = vv > 0 ? pv / vv : undefined;
    const nDay = nPct(k - 1);
    const nRecent = k >= 31 ? (nifty.c[k - 1] / nifty.c[k - 31] - 1) * 100 : undefined;
    const rvolSame = cumV / sameAvg(k);
    const rvolTV = cumV / fullAvg;
    const ext = ((price - open) / adr) * 100;
    const ctxBase: DimCtx = { nFirst5, nDay: k >= 15 ? nDay : undefined, nRecent, rvolSame: Number.isFinite(rvolSame) ? rvolSame : undefined, openBusy, e5, e10, e1d, gapPct };
    const first5Dir = dirOf(nFirst5, P.niftyDirPct), dayDir = k >= 15 ? dirOf(nDay, P.niftyDirPct) : 0, recentDir = dirOf(nRecent, P.niftyRecentPct);
    /** Nifty his way: before 09:30 by the first 5 minutes (his rule), from 09:30 by open -> now */
    const niftyWith = (d: 1 | -1) => (k < 15 ? first5Dir : dayDir) === d;
    /** Nifty directional his way in the first 5 minutes and still his way open -> now */
    const niftyLed = (d: 1 | -1) => first5Dir === d && (k < 15 || dayDir === d);
    /** busier than usual: at the open his TradingView rule (rvol > 0.1), later vs the same time of day */
    const busy = k < 20 ? rvolTV > 0.1 : rvolSame > 1;
    const quiet = Number.isFinite(rvolSame) && rvolSame <= 1;
    const emaInPath = (d: 1 | -1) => [e5, e10, e1d].some((e) => e !== undefined && (e - price) * d > 0 && Math.abs(e - price) <= P.emaReachAtr * atr);
    const emaBetween = (tgt: number) => [e5, e10, e1d].some((e) => e !== undefined && (e - price) * (tgt - e) > 0);
    const swingBars = [...prevTens, ...tens];

    let pocMemo: number | undefined | null = null, poc2Memo: number | undefined | null = null;
    const pocToday = () => (pocMemo === null ? (pocMemo = pointOfControl(day.bars.slice(0, k), P.pocRows)) : pocMemo);
    const poc2d = () => (poc2Memo === null ? (poc2Memo = prevSession ? pointOfControl([...prevSession.bars, ...day.bars.slice(0, k)], P.pocRows) : undefined) : poc2Memo);
    /** reversal target: today's POC from 10:15 (six completed 10-min candles), the 2-day POC before */
    const pocTarget = () => (k >= 60 ? pocToday() : poc2d());
    /** the nearest level in the trade's way, for the "next obstacle" exit */
    const obstacleFor = (d: 1 | -1, tgt?: number) => {
      const lv = [d === 1 ? pdh : pdl, e10, e1d, pocToday(), pva?.vah, pva?.val].filter((x): x is number => x !== undefined && Number.isFinite(x) && (x - price) * d > 0.3 * atr && (tgt === undefined || (tgt - x) * d > 0));
      return lv.length ? lv.reduce((a, b) => (Math.abs(b - price) < Math.abs(a - price) ? b : a)) : undefined;
    };

    const add = (id: CaseId, d: 1 | -1, target?: number, extra: { testNo?: number; level?: Signal['level']; stop?: number } = {}): boolean => {
      const key = `${id}${d}`;
      if (fired.has(key)) return false;
      const st = extra.stop !== undefined ? { stop: extra.stop, type: 'ATR2' as const } : swingStop(d, price, atr, swingBars);
      const dist = Math.abs(price - st.stop);
      const family = CASE_BY_ID.get(id)!.family;
      let tgt = target;
      if (family === 'MOMENTUM' || id === 'FB' || id === 'L2') tgt = price + d * 2 * dist;
      if (tgt === undefined || !Number.isFinite(tgt) || (tgt - price) * d < 0.5 * dist) return false; // no room
      if (family === 'REVERSAL' && (id === 'D' || id === 'E' || id === 'F' || id === 'J') && emaBetween(tgt)) return false;
      fired.add(key);
      const zone = d === -1 ? hiZone : loZone; // a short fades the high, a long the low
      const testNo = extra.testNo ?? (family === 'REVERSAL' ? zone.testOf(T, atr) : 0);
      drafts.push({
        id, d, stop: st.stop, stopType: st.type, target: tgt, slot: k, price, atr,
        ctx: { ...ctxBase, ext: family === 'MOMENTUM' ? ext * d : ext * -d },
        ex: { obstacle: obstacleFor(d, family === 'REVERSAL' ? tgt : undefined), medV, adr, dayHi, dayLo, entryBar: T },
        testNo, tests: testNo ? [...zone.tests] : [], level: extra.level ?? '',
        pullbackNo: family === 'MOMENTUM' ? pullbackNumber(tens.map((b, i) => ({ t: i, ...b })), d, 0.5 * atr) : 0,
      });
      // the breakout fade: every breakout, taken the other way at the same close
      if (FADED.has(id)) add('FB', (-d) as 1 | -1);
      return true;
    };

    if (late) {
      // ---- 15:00: the last-half-hour research cases (held to the 15:29 close), nothing else
      const nFirst30 = (nifty.c[29] / nOpen - 1) * 100;
      const sFirst30 = (day.c[29] / open - 1) * 100, sDay = (price / open - 1) * 100;
      const d30 = dirOf(nFirst30, 0.1);
      if (d30 !== 0 && Math.sign(sFirst30) === d30 && Math.sign(sDay) === d30) add('L1', d30, undefined, { stop: price - d30 * atr });
      const relDay = sDay - nPct(k - 1);
      if (Math.abs(relDay) >= 1.5) { const d = (relDay < 0 ? 1 : -1) as 1 | -1; add('L2', d, undefined, { stop: price - d * atr }); }
      continue;
    }
    const mom = (id: CaseId, d: 1 | -1) => {
      const ok = add(id, d);
      // M9: the same moment as an opening range break with Nifty strong, entered on a pullback instead
      if (ok && (id === 'M1' || id === 'M2') && nDay * d >= 0.3) add('M9', d);
    };

    for (const d of [1, -1] as const) {
      const up = d === 1;
      const r = -d as 1 | -1; // reversal: the run being faded
      const runUp = r === 1;
      const prevHi = hiBefore[L - 1], prevLo = loBefore[L - 1]; // the day's high / low before this candle
      const turned10 = !!Pv && (up ? T.c > Pv.h : T.c < Pv.l);   // closes beyond the previous candle, his way
      const turnedRev = !!Pv && (runUp ? T.c < Pv.l : T.c > Pv.h); // closes beyond the previous candle, against the run

      /* ---- combined (his playbook) ---- */
      const momCtx = niftyLed(d) && busy && !emaInPath(d) && ext * d >= 10 && ext * d < 80;
      if (momCtx && Pv) {
        const newExt = up ? T.c > prevHi : T.c < prevLo;
        const orx = or10 && L >= 2 && (up ? T.c > or10.h && Pv.c <= or10.h : T.c < or10.l && Pv.c >= or10.l);
        if (newExt || orx) add('A', d);
        const levels = [or10 ? (up ? or10.h : or10.l) : NaN, up ? (open < pdh && dayHi > pdh ? pdh : NaN) : (open > pdl && dayLo < pdl ? pdl : NaN)];
        const pull = up ? Pv.l : Pv.h;
        const holds = (lv: number) => Number.isFinite(lv) && Math.abs(pull - lv) <= 0.3 * atr && (price - lv) * d > 0;
        if (turned10 && (up ? dayHi - Pv.l : Pv.h - dayLo) >= 0.5 * atr && (levels.some(holds) || holds(pocToday() ?? NaN))) add('B', d);
        if (k >= 40 && nRecent !== undefined && nRecent * d <= -P.niftyRecentPct && (price - day.c[k - 31]) * d >= 0) {
          const last3 = tens.slice(-3);
          if (up ? price >= Math.max(...last3.map((b) => b.h)) - 0.15 * atr : price <= Math.min(...last3.map((b) => b.l)) + 0.15 * atr) add('C', d);
        }
      }
      const niftyNotWithRun = k >= 31 ? recentDir !== r : first5Dir !== r;
      const revCtx = quiet && ext * r >= 50 && niftyNotWithRun;
      if (revCtx) {
        const inZone = runUp ? dayHi - T.h <= 0.25 * atr : T.l - dayLo <= 0.25 * atr;
        const rng = T.h - T.l;
        const rejection = rng > 0 && (runUp ? T.c <= T.l + 0.5 * rng : T.c >= T.h - 0.5 * rng);
        if (inZone && rejection) add('D', d, pocTarget());
        const lvls: [Signal['level'], number | undefined][] = [['DAY', runUp ? prevHi : prevLo], ['PD', runUp ? pdh : pdl], ['VA', pva ? (runUp ? pva.vah : pva.val) : undefined]];
        for (const [name, lv] of lvls) {
          if (lv === undefined || !Number.isFinite(lv)) continue;
          if (runUp ? T.h > lv && T.c < lv : T.l < lv && T.c > lv) {
            add('E', d, pocTarget(), { level: name, testNo: (runUp ? hiZone : loZone).testOf(T, atr) });
            break;
          }
        }
        if (Pv && L >= 2) {
          const before = runUp ? hiBefore[L - 2] : loBefore[L - 2];
          const newExt = runUp ? Pv.h >= before : Pv.l <= before;
          const stall = runUp ? T.h <= Pv.h && T.c < T.o : T.l >= Pv.l && T.c > T.o;
          if (medV > 0 && Pv.v >= 3 * medV && newExt && stall) add('F', d, pocTarget());
        }
      }
      if (k === 20 && L === 2 && tens.every((b) => (b.c - b.o) * d > 0) && ((Math.sign(gapPct) === d && Math.abs(gapPct) >= 0.3) || first5Dir === d) && busy) add('G', d);
      if (Pv && niftyWith(d) && ext * d >= 30 && ext * d < 80) {
        const narrow = Pv.h - Pv.l < 0.5 * atr;
        const nearExt = up ? hiBefore[L - 1] - Pv.h <= 0.3 * atr : Pv.l - loBefore[L - 1] <= 0.3 * atr;
        if (narrow && nearExt && (up ? T.c > Pv.h : T.c < Pv.l)) add('I', d);
      }
      if (k >= 15 && Math.abs(ext) >= 50 && Math.sign(ext) === r && dayDir === -r && recentDir !== r && turnedRev) add('J', d, pocTarget());
      if (k >= 230 && k <= 310 && Pv && ext * d >= 60 && dayDir === d && turned10 && (up ? dayHi - Pv.l : Pv.h - dayLo) >= 0.5 * atr) add('K', d);

      /* ---- building blocks ---- */
      if (or10 && Pv && niftyWith(d)) {
        const lvl = up ? or10.h : or10.l;
        if ((price - lvl) * d > 0 && (Pv.c - lvl) * d <= 0) mom('M1', d);
      }
      if (or30 && k >= 40 && Pv && niftyWith(d)) {
        const lvl = up ? or30.h : or30.l;
        if ((price - lvl) * d > 0 && (Pv.c - lvl) * d <= 0) mom('M2', d);
      }
      if (k === 10 && L === 1 && Math.abs(gapPct) >= 0.5 && Math.sign(gapPct) === d && first5Dir === d) {
        if ((T.c - T.o) * d > 0 && (up ? T.l > prevClose : T.h < prevClose)) mom('M3', d);
      }
      if (k >= 20 && ext * d >= 30 && niftyWith(d) && turned10) {
        const depth = up ? dayHi - lowSinceHi : highSinceLo - dayLo;
        const pull = up ? lowSinceHi : highSinceLo;
        if (Number.isFinite(depth) && depth >= 0.5 * atr) {
          const levels = [or10 ? (up ? or10.h : or10.l) : NaN, up ? (open < pdh && dayHi > pdh ? pdh : NaN) : (open > pdl && dayLo < pdl ? pdl : NaN)];
          const holds = (lv: number) => Number.isFinite(lv) && Math.abs(pull - lv) <= 0.3 * atr && (price - lv) * d > 0;
          if (levels.some(holds) || holds(pocToday() ?? NaN)) mom('M4', d);
        }
      }
      if (k >= 30) {
        const w0 = k - 21;
        let nExt = nifty.c[w0], sMin = day.c[w0], sMax = day.c[w0], hiW = -Infinity, loW = Infinity;
        for (let i = w0; i < k; i++) {
          nExt = up ? Math.min(nExt, nifty.c[i]) : Math.max(nExt, nifty.c[i]);
          sMin = Math.min(sMin, day.c[i]); sMax = Math.max(sMax, day.c[i]);
          hiW = Math.max(hiW, day.h[i]); loW = Math.min(loW, day.l[i]);
        }
        const dip = (nExt / nifty.c[w0] - 1) * 100 * d;
        const resume = (nifty.c[k - 1] / nExt - 1) * 100 * d;
        const held = up ? sMin >= day.c[w0] - 0.1 * atr : sMax <= day.c[w0] + 0.1 * atr;
        const atExt = up ? price >= hiW - 0.15 * atr : price <= loW + 0.15 * atr;
        if (dip <= -0.1 && resume >= 0.05 && (nifty.c[k - 1] - nifty.c[k - 11]) * d > 0 && held && atExt) mom('M5', d);
      }
      if (L >= 2 && niftyWith(d)) {
        const B = tens[L - 2], C = tens[L - 1];
        const refC = L >= 3 ? tens[L - 3].c : prevClose;
        const lvl = up ? pdh : pdl;
        if ((B.c - lvl) * d > 0 && ((refC - lvl) * d <= 0 || (B.o - lvl) * d <= 0) && (C.c - lvl) * d > 0) mom('M6', d);
      }
      if (k >= 40 && L >= 4 && niftyWith(d)) {
        const box = tens.slice(-4, -1);
        if (box.every((b) => b.h - b.l < 0.6 * atr)) {
          const lvl = up ? Math.max(...box.map((b) => b.h)) : Math.min(...box.map((b) => b.l));
          if ((price - lvl) * d > 0) mom('M7', d);
        }
      }
      if (pva && openInVa && L >= 2 && niftyWith(d)) {
        const lvl = up ? pva.vah : pva.val;
        if (tens.slice(-2).every((b) => (b.c - lvl) * d > 0)) mom('M8', d);
      }

      const extreme = runUp ? dayHi : dayLo;
      if (ext * r >= 50 && turnedRev && (extreme - (runUp ? T.h : T.l)) * r <= 0.25 * atr) add('R1', d, pocTarget());
      if (or10 && k >= 20) {
        const lvl = runUp ? or10.h : or10.l;
        const brk = runUp ? brkHi : brkLo;
        const far = runUp ? maxSinceBrk - or10.h : or10.l - minSinceBrk;
        if (brk >= 0 && k - 1 > brk && k - 1 - brk <= 20 && far >= 0.1 * atr && (price - lvl) * r < 0) add('R2', d, runUp ? or10.l : or10.h);
      }
      if (k === 10 && L === 1 && Math.abs(gapPct) >= 0.5 && Math.sign(gapPct) === r && (ctxBase.rvolSame ?? 1) < 1 && first5Dir !== r) {
        if ((T.c - T.o) * r < 0 && (price - prevClose) * r > 0) add('R3', d, prevClose);
      }
      if (L >= 2) {
        const X = tens[L - 2], S2 = tens[L - 1];
        const before = runUp ? hiBefore[L - 2] : loBefore[L - 2];
        const newExt = runUp ? X.h >= before : X.l <= before;
        const stall = runUp ? S2.h <= X.h && S2.c < S2.o : S2.l >= X.l && S2.c > S2.o;
        if (medV > 0 && X.v >= 3 * medV && newExt && stall && (runUp ? X.h > open : X.l < open)) add('R4', d, pocTarget());
      }
      if (pva && openInVa) {
        const edge = runUp ? pva.vah : pva.val;
        if ((runUp ? T.h >= edge : T.l <= edge) && (T.c - edge) * r < 0) add('R5', d, pva.poc);
      }
      {
        const lvl = runUp ? pdh : pdl;
        if ((open - lvl) * r < 0 && (runUp ? T.h > lvl : T.l < lvl) && (T.c - lvl) * r < 0) add('R6', d, pocTarget());
      }
      if (Pv && (ctxBase.rvolSame ?? 0) >= 1.5 && (extreme - open) * r >= 0.3 * adr && niftyWith(r)) {
        const lvl = extreme - r * atr;
        if ((price - lvl) * r <= 0 && (Pv.c - lvl) * r > 0) add('R7', d, pocTarget());
      }
      if (vwap !== undefined && (price - vwap) * r >= 1.5 * atr && turnedRev) add('R8', d, vwap);
    }
  }

  // ---- signals with their slices (and outcomes in the backtest)
  const out: Signal[] = drafts.map((x) => toSignal(inp.symbol, inp.date, x, P));
  out.forEach((sig, i) => {
    sig.with = out.filter((o) => o !== sig && o.dir === sig.dir && o.case !== 'M9' && sig.case !== 'M9' && o.slot <= sig.slot && o.slot >= sig.slot - 30 && o.case !== sig.case)
      .map((o) => o.case).filter((c, j, a) => a.indexOf(c) === j);
    if (inp.simulate && sig.stopType !== 'FAR') sig.out = simulate(sig, day, P, { ...drafts[i].ex, nifty });
  });
  return out;
}

function toSignal(symbol: string, date: string, x: Draft, P: Params): Signal {
  const c = x.ctx, d = x.d;
  const relPct = (pct: number | undefined, th: number) => rel(d, dirOf(pct, th));
  const rv = c.rvolSame;
  const rvol: RvolBucket = rv === undefined ? 'NORMAL' : rv < 0.8 ? 'LOW' : rv >= 1.5 ? 'HIGH' : 'NORMAL';
  const inWay = [c.e5, c.e10, c.e1d].some((e) => e !== undefined && (e - x.price) * d > 0 && Math.abs(e - x.price) <= P.emaReachAtr * x.atr);
  return {
    case: x.id, symbol, date, slot: x.slot, dir: d,
    entry: r2(x.price), stop: r2(x.stop), target: r2(x.target), stopAtr: r2(Math.abs(x.price - x.stop) / x.atr), atr: r2(x.atr),
    capped: x.stopType === 'ATR2', stopType: x.stopType,
    time: timeBucket(x.slot),
    nFirst5: relPct(c.nFirst5, P.niftyDirPct),
    nDay: c.nDay === undefined ? 'EARLY' : relPct(c.nDay, P.niftyDirPct),
    nRecent: c.nRecent === undefined ? 'EARLY' : relPct(c.nRecent, P.niftyRecentPct),
    rvol, openBusy: c.openBusy, stretch: Math.round(c.ext ?? 0), emaInWay: inWay, gapPct: r2(c.gapPct),
    testNo: x.testNo, tests: x.tests, level: x.level, pullbackNo: x.pullbackNo, with: [],
  };
}

/**
 * What happened next, minute by minute until 15:00, for every exit at once.
 *  Systematic: 1R, 1.5R, the structural target (momentum 2R).
 *  Discretionary (checked when each 10-minute candle closes, exit at that close, unless said otherwise):
 *   X1 the candle closes beyond the previous candle against the trade · X2 a candle against the trade with 2x normal
 *   volume · X3 Nifty 500 moved against the trade over the last 30 minutes · X4 the day's range reaches 95% of the
 *   usual (exit when it happens) · X5 price reaches the next obstacle (exit at the level) · X6 under 0.3R after three
 *   candles · X7 was +1R, back to +0.3R · XA whichever of those comes first.
 * The stop is checked first inside every minute, so a minute that touches both counts as the stop (cautious).
 */
export function simulate(sig: Signal, day: Slots, P: Params, ex?: ExitCtx & { nifty?: Slots }): Outcome {
  const d = sig.dir;
  let entry = sig.entry, start = sig.slot, filled: boolean | undefined;
  const stop = sig.stop;
  const none = (): TargetResult => ({ hit: false, r: 0, net: 0, min: 0 });
  if (sig.case === 'M9') {
    // a limit order 0.5 ATR back, same stop, valid 30 minutes
    const limit = sig.entry - d * 0.5 * sig.atr;
    filled = false;
    if ((limit - stop) * d >= 0.25 * sig.atr) {
      for (let s = sig.slot; s < Math.min(EXIT_SLOT, sig.slot + 30, day.n); s++) {
        if (d === 1 ? day.l[s] <= limit : day.h[s] >= limit) { filled = true; entry = limit; start = s; break; }
      }
    }
    if (!filled) {
      const o = {} as Outcome;
      for (const k of [...TARGET_KEYS, ...EXIT_KEYS]) o[k] = none();
      return { ...o, mfe: 0, mae: 0, costR: 0, filled: false };
    }
  }
  const dist = Math.abs(entry - stop);
  const levels: Record<'T1' | 'T15' | 'TS', number> = { T1: entry + d * dist, T15: entry + d * 1.5 * dist, TS: sig.case === 'M9' ? entry + d * 2 * dist : sig.target };
  const targetKeys = ['T1', 'T15', 'TS'] as const;
  const res: Partial<Record<OutKey, { exit: number; slot: number; target?: boolean }>> = {};
  const discr: ExitKey[] = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7'];
  const allKeys: OutKey[] = [...TARGET_KEYS, ...discr];
  let mfe = 0, mae = 0;
  // the last-half-hour cases are held to the 15:29 close; everything else is closed at 15:00
  const end = Math.min(sig.case === 'L1' || sig.case === 'L2' ? CLOSE_SLOT : EXIT_SLOT, day.n);
  let hi = ex?.dayHi ?? -Infinity, lo = ex?.dayLo ?? Infinity;
  const rangeStart = ex ? (hi - lo) / ex.adr : 1;
  let prevBar = ex?.entryBar, candles = 0;
  const R = (px: number) => ((px - entry) * d) / dist;
  for (let s = start; s < end; s++) {
    const h = day.h[s], l = day.l[s];
    hi = Math.max(hi, h); lo = Math.min(lo, l);
    if (d === 1 ? l <= stop : h >= stop) {
      for (const k of allKeys) if (!res[k]) res[k] = { exit: stop, slot: s };
      mae = 1; break;
    }
    mfe = Math.max(mfe, R(d === 1 ? h : l));
    mae = Math.max(mae, -R(d === 1 ? l : h));
    // on the fill minute of a limit order, only the stop counts (the high may have come before the fill)
    const canTarget = !(sig.case === 'M9' && s === start);
    if (canTarget) {
      for (const k of targetKeys) if (!res[k] && (d === 1 ? h >= levels[k] : l <= levels[k])) res[k] = { exit: levels[k], slot: s, target: true };
      if (ex) {
        if (!res.X5 && ex.obstacle !== undefined && (d === 1 ? h >= ex.obstacle : l <= ex.obstacle)) res.X5 = { exit: ex.obstacle, slot: s };
        if (!res.X4 && rangeStart < 0.95 && (hi - lo) / ex.adr >= 0.95) res.X4 = { exit: day.c[s], slot: s };
      }
    }
    if (ex && (s + 1) % 10 === 0 && s >= 9) {
      const b = barOf(day, s - 9, s + 1);
      candles++;
      const at = { exit: b.c, slot: s };
      if (!res.X1 && prevBar && (d === 1 ? b.c < prevBar.l : b.c > prevBar.h)) res.X1 = at;
      if (!res.X2 && (b.c - b.o) * d < 0 && ex.medV > 0 && b.v >= 2 * ex.medV) res.X2 = at;
      if (!res.X3 && ex.nifty && s >= 30 && ((ex.nifty.c[s] / ex.nifty.c[s - 30] - 1) * 100) * d <= -P.niftyRecentPct) res.X3 = at;
      if (!res.X6 && candles >= 3 && R(b.c) < 0.3) res.X6 = at;
      if (!res.X7 && mfe >= 1 && R(b.c) <= 0.3) res.X7 = at;
      prevBar = b;
    }
    if (allKeys.every((k) => res[k])) break;
  }
  const lastClose = day.c[Math.max(0, end - 1)];
  // XA: the first discretionary marker
  const firstX = discr.map((k) => res[k]).filter((x): x is { exit: number; slot: number } => !!x).sort((a, b) => a.slot - b.slot)[0];
  if (firstX) res.XA = firstX;
  const qty = sizeFor(P.riskInr, dist);
  const one = (k: OutKey): TargetResult => {
    const x = res[k] ?? { exit: lastClose, slot: end - 1 };
    const r = R(x.exit);
    const cost = roundTripCharges(qty, entry, x.exit, d) / (qty * dist);
    const net = r2(r - cost);
    return { hit: k === 'TC' || !k.startsWith('T') ? net > 0 : !!x.target, r: r2(r), net, min: Math.max(1, x.slot - sig.slot + 1) };
  };
  const o = {} as Outcome;
  for (const k of [...TARGET_KEYS, ...EXIT_KEYS]) o[k] = one(k);
  return {
    ...o,
    mfe: r2(mfe), mae: r2(Math.min(mae, 1)),
    costR: r2(roundTripCharges(qty, entry, entry, d) / (qty * dist)),
    ...(filled !== undefined ? { filled } : {}),
  };
}
