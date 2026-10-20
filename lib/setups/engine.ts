import type { Candles } from '../dhan';
import { tenMinuteBars, type Bar, type Session } from '../live/enrich';
import { istParts, SESSION_OPEN_MIN } from '../live/time';
import { hasSuspectGap, nMinuteBars, pointOfControl } from '../copilot/features';
import { roundTripCharges, sizeFor } from './costs';
import { CASE_BY_ID, timeBucket, type CaseId, type Outcome, type Rel, type RvolBucket, type Signal, type TargetResult } from './cases';

/**
 * The setup engine: one stock, one day, replayed minute by minute. Pure code (no network, no clock), so the backtest
 * and the live alerts run exactly the same rules on exactly the same numbers.
 *
 * At decision minute k (0 = 09:15) only the 1-minute candles that started before k are used; the entry price is the
 * close of minute k-1. Bars are aligned at 09:15, the 10-minute chart is built from them (the candle still forming
 * counts, the way the chart shows it), and ATR(14) / the 200 EMAs / VWAP are computed the same way as the co-pilot.
 * Decisions run from 09:20 to 14:59; anything still open is closed at 15:00 (he never trades the last 30 minutes).
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

export const FIRST_DECISION = 5;   // 09:20
export const LAST_DECISION = 344;  // 14:59
export const EXIT_SLOT = 345;      // 15:00: anything open is closed at the 14:59 close

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

interface B10 { o: number; h: number; l: number; c: number; v: number }

const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dirOf = (pct: number | undefined, th: number): 1 | -1 | 0 => (pct === undefined ? 0 : pct >= th ? 1 : pct <= -th ? -1 : 0);
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
class Ema {
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
class Atr {
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

function barOf(s: Slots, from: number, toExcl: number): B10 {
  let h = -Infinity, l = Infinity, v = 0;
  for (let i = from; i < toExcl; i++) { if (s.h[i] > h) h = s.h[i]; if (s.l[i] < l) l = s.l[i]; v += s.v[i]; }
  return { o: s.o[from], h, l, c: s.c[toExcl - 1], v };
}

/* ---- the day ---------------------------------------------------------------------------------------------- */

interface Draft { id: CaseId; d: 1 | -1; stop: number; capped: boolean; target: number; slot: number; price: number; atr: number; ctx: DimCtx }
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

  const K = Math.min(day.n, nifty.n);
  const lastK = Math.min(K, LAST_DECISION);
  const nOpen = nifty.o[0];
  const nPct = (i: number) => (nifty.c[i] / nOpen - 1) * 100;
  const nFirst5 = K >= 5 ? (nifty.c[4] / nOpen - 1) * 100 : undefined;

  // ---- running state for the day
  const tens: B10[] = [];
  let pv = 0, vv = 0, cumV = 0;
  let dayHi = -Infinity, dayLo = Infinity, hiSlot = 0, loSlot = 0, lowSinceHi = Infinity, highSinceLo = -Infinity;
  let or10: B10 | undefined, or30: B10 | undefined, openBusy = false;
  let brkHi = -1, maxSinceBrk = -Infinity, brkLo = -1, minSinceBrk = Infinity;
  let medV = median(medBase);
  const fired = new Set<string>();
  const drafts: Draft[] = [];

  for (let k = 1; k <= lastK; k++) {
    // ---- add minute k-1
    const s = k - 1;
    if (day.h[s] > dayHi) { dayHi = day.h[s]; hiSlot = s; lowSinceHi = Infinity; } else lowSinceHi = Math.min(lowSinceHi, day.l[s]);
    if (day.l[s] < dayLo) { dayLo = day.l[s]; loSlot = s; highSinceLo = -Infinity; } else highSinceLo = Math.max(highSinceLo, day.h[s]);
    cumV += day.v[s];
    if ((s + 1) % 10 === 0) {
      const b = barOf(day, s - 9, s + 1);
      tens.push(b); atrC.push(b); ema10.push(b.c);
      pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v;
      medV = median([...medBase, ...tens.map((x) => x.v)]);
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
    if (k < FIRST_DECISION) continue;

    // ---- the picture at minute k
    const price = day.c[k - 1], prev = day.c[k - 2];
    const formStart = Math.floor(k / 10) * 10;
    const forming = k % 10 ? barOf(day, formStart, k) : undefined;
    const atr = atrC.peek(forming);
    if (!atr || !(atr > 0)) continue;
    const e10 = ema10.peek(forming ? price : undefined);
    const e5 = ema5.peek(k % 5 ? price : undefined);
    const e1d = suspect ? undefined : ema1d.peek(price);
    const fv = forming?.v ?? 0;
    const vwap = vv + fv > 0 ? (pv + (forming ? ((forming.h + forming.l + forming.c) / 3) * fv : 0)) / (vv + fv) : undefined;
    const nDay = nPct(k - 1);
    const nRecent = k >= 31 ? (nifty.c[k - 1] / nifty.c[k - 31] - 1) * 100 : undefined;
    const rvolSame = cumV / sameAvg(k);
    const ext = ((price - open) / adr) * 100;
    const ctxBase: DimCtx = { nFirst5, nDay: k >= 15 ? nDay : undefined, nRecent, rvolSame: Number.isFinite(rvolSame) ? rvolSame : undefined, openBusy, e5, e10, e1d, gapPct };
    /** Nifty his way: before 09:30 by the first 5 minutes (his rule), from 09:30 by open -> now */
    const niftyWith = (d: 1 | -1) => (k < 15 ? dirOf(nFirst5, P.niftyDirPct) : dirOf(nDay, P.niftyDirPct)) === d;

    const clampStop = (d: 1 | -1, raw: number) => {
      let stop = raw, capped = false;
      if ((price - stop) * d < 0.25 * atr) stop = price - d * 0.25 * atr;
      if ((price - stop) * d > 2 * atr) { stop = price - d * 2 * atr; capped = true; }
      return { stop, capped };
    };
    /** momentum stop: beyond the last two 10-min candles and the one forming (the co-pilot's stop idea) */
    const momStop = (d: 1 | -1) => {
      const recent = forming ? [...tens.slice(-2), forming] : tens.slice(-3);
      const pool = recent.length ? recent : [barOf(day, 0, k)];
      return clampStop(d, d === 1 ? Math.min(...pool.map((b) => b.l)) - 0.1 * atr : Math.max(...pool.map((b) => b.h)) + 0.1 * atr);
    };
    const revStop = (d: 1 | -1, extreme: number) => clampStop(d, extreme - d * 0.1 * atr);

    let pocMemo: number | undefined | null = null, poc2Memo: number | undefined | null = null;
    const pocToday = () => (pocMemo === null ? (pocMemo = pointOfControl(day.bars.slice(0, k), P.pocRows)) : pocMemo);
    const poc2d = () => (poc2Memo === null ? (poc2Memo = prevSession ? pointOfControl([...prevSession.bars, ...day.bars.slice(0, k)], P.pocRows) : undefined) : poc2Memo);
    /** reversal target: today's POC from 10:15 (six completed 10-min candles), the 2-day POC before */
    const pocTarget = () => (k >= 60 ? pocToday() : poc2d());

    const add = (id: CaseId, d: 1 | -1, st: { stop: number; capped: boolean }, target?: number) => {
      const key = `${id}${d}`;
      if (fired.has(key)) return false;
      const dist = Math.abs(price - st.stop);
      const family = CASE_BY_ID.get(id)!.family;
      let tgt = target;
      if (family === 'MOMENTUM') tgt = price + d * 2 * dist;
      if (tgt === undefined || !Number.isFinite(tgt) || (tgt - price) * d < 0.5 * dist) return false; // no room
      fired.add(key);
      drafts.push({ id, d, stop: st.stop, capped: st.capped, target: tgt, slot: k, price, atr, ctx: { ...ctxBase, ext: family === 'MOMENTUM' ? ext * d : ext * -d } });
      return true;
    };
    const mom = (id: CaseId, d: 1 | -1) => {
      const ok = add(id, d, momStop(d));
      // M9: the same moment as an opening range break with Nifty strong, entered on a pullback instead
      if (ok && (id === 'M1' || id === 'M2') && nDay * d >= 0.3) add('M9', d, momStop(d));
    };

    for (const d of [1, -1] as const) {
      const up = d === 1;
      // ---- momentum
      if (or10 && niftyWith(d)) {
        const lvl = up ? or10.h : or10.l;
        if ((price - lvl) * d > 0 && (prev - lvl) * d <= 0) mom('M1', d);
      }
      if (or30 && k >= 30 && niftyWith(d)) {
        const lvl = up ? or30.h : or30.l;
        if ((price - lvl) * d > 0 && (prev - lvl) * d <= 0) mom('M2', d);
      }
      if (k === 10 && tens.length === 1 && Math.abs(gapPct) >= 0.5 && Math.sign(gapPct) === d && dirOf(nFirst5, P.niftyDirPct) === d) {
        const b = tens[0];
        if ((b.c - b.o) * d > 0 && (up ? b.l > prevClose : b.h < prevClose)) mom('M3', d);
      }
      if (k >= 20 && ext * d >= 30 && niftyWith(d)) {
        const depth = up ? dayHi - lowSinceHi : highSinceLo - dayLo;
        const pull = up ? lowSinceHi : highSinceLo;
        const turned = up ? day.c[k - 1] > day.h[k - 2] : day.c[k - 1] < day.l[k - 2];
        if (Number.isFinite(depth) && depth >= 0.5 * atr && turned) {
          const levels = [or10 ? (up ? or10.h : or10.l) : NaN, up ? (open < pdh && dayHi > pdh ? pdh : NaN) : (open > pdl && dayLo < pdl ? pdl : NaN)];
          const holds = (L: number) => Number.isFinite(L) && Math.abs(pull - L) <= 0.3 * atr && (price - L) * d > 0;
          if (levels.some(holds) || holds(pocToday() ?? NaN)) mom('M4', d);
        }
      }
      if (k >= 31) {
        const w0 = k - 21;
        let nExt = nifty.c[w0], sMin = day.c[w0], sMax = day.c[w0], hiW = -Infinity, loW = Infinity;
        for (let i = w0; i < k; i++) {
          nExt = up ? Math.min(nExt, nifty.c[i]) : Math.max(nExt, nifty.c[i]);
          sMin = Math.min(sMin, day.c[i]); sMax = Math.max(sMax, day.c[i]);
          hiW = Math.max(hiW, day.h[i]); loW = Math.min(loW, day.l[i]);
        }
        const dip = (nExt / nifty.c[w0] - 1) * 100 * d;          // < 0 = Nifty went against him
        const resume = (nifty.c[k - 1] / nExt - 1) * 100 * d;    // > 0 = Nifty coming back his way
        const held = up ? sMin >= day.c[w0] - 0.1 * atr : sMax <= day.c[w0] + 0.1 * atr;
        const atExt = up ? price >= hiW - 0.15 * atr : price <= loW + 0.15 * atr;
        if (dip <= -0.1 && resume >= 0.05 && (nifty.c[k - 1] - nifty.c[k - 4]) * d > 0 && held && atExt) mom('M5', d);
      }
      if (k % 10 === 0 && tens.length >= 2 && niftyWith(d)) {
        const B = tens[tens.length - 2], C = tens[tens.length - 1];
        const refC = tens.length >= 3 ? tens[tens.length - 3].c : prevClose;
        const lvl = up ? pdh : pdl;
        if ((B.c - lvl) * d > 0 && ((refC - lvl) * d <= 0 || (B.o - lvl) * d <= 0) && (C.c - lvl) * d > 0) mom('M6', d);
      }
      if (k >= 40 && tens.length >= 3 && niftyWith(d)) {
        const box = tens.slice(-3);
        if (box.every((b) => b.h - b.l < 0.6 * atr)) {
          const lvl = up ? Math.max(...box.map((b) => b.h)) : Math.min(...box.map((b) => b.l));
          if ((price - lvl) * d > 0 && (prev - lvl) * d <= 0) mom('M7', d);
        }
      }
      if (pva && openInVa && k % 10 === 0 && tens.length >= 2 && niftyWith(d)) {
        const lvl = up ? pva.vah : pva.val;
        if (tens.slice(-2).every((b) => (b.c - lvl) * d > 0)) mom('M8', d);
      }

      // ---- reversal: d is the trade, the run being faded goes -d
      const r = -d as 1 | -1;
      const runUp = r === 1;
      const extreme = runUp ? dayHi : dayLo;
      const turnedBack = runUp ? day.c[k - 1] < day.l[k - 2] : day.c[k - 1] > day.h[k - 2];
      if (ext * r >= 50 && turnedBack && (extreme - price) * r <= 0.5 * atr && k - 1 - (runUp ? hiSlot : loSlot) <= 20) {
        add('R1', d, revStop(d, extreme), pocTarget());
      }
      if (or10 && k >= 11) {
        const lvl = runUp ? or10.h : or10.l;
        const brk = runUp ? brkHi : brkLo;
        const far = runUp ? maxSinceBrk - or10.h : or10.l - minSinceBrk;
        // the first close back inside after the break (within 20 minutes of it)
        if (brk >= 0 && k - 1 > brk && k - 1 - brk <= 20 && far >= 0.1 * atr && (price - lvl) * r < 0) {
          add('R2', d, revStop(d, runUp ? maxSinceBrk : minSinceBrk), runUp ? or10.l : or10.h);
        }
      }
      if (k === 10 && tens.length === 1 && Math.abs(gapPct) >= 0.5 && Math.sign(gapPct) === r && (ctxBase.rvolSame ?? 1) < 1 && dirOf(nFirst5, P.niftyDirPct) !== r) {
        const b = tens[0];
        if ((b.c - b.o) * r < 0 && (price - prevClose) * r > 0) add('R3', d, revStop(d, extreme), prevClose);
      }
      if (k % 10 === 0 && tens.length >= 2) {
        const X = tens[tens.length - 2], S = tens[tens.length - 1];
        const before = tens.slice(0, -2);
        const newExt = runUp ? X.h >= Math.max(...before.map((b) => b.h), -Infinity) : X.l <= Math.min(...before.map((b) => b.l), Infinity);
        const stall = runUp ? S.h <= X.h && S.c < S.o : S.l >= X.l && S.c > S.o;
        if (medV > 0 && X.v >= 3 * medV && newExt && stall && (runUp ? X.h > open : X.l < open)) add('R4', d, revStop(d, runUp ? X.h : X.l), pocTarget());
      }
      if (pva && openInVa && k % 10 === 0 && tens.length >= 1) {
        const T = tens[tens.length - 1];
        const edge = runUp ? pva.vah : pva.val;
        if ((runUp ? T.h >= edge : T.l <= edge) && (T.c - edge) * r < 0) add('R5', d, revStop(d, extreme), pva.poc);
      }
      if (k % 10 === 0 && tens.length >= 1) {
        const T = tens[tens.length - 1];
        const lvl = runUp ? pdh : pdl;
        if ((open - lvl) * r < 0 && (runUp ? T.h > lvl : T.l < lvl) && (T.c - lvl) * r < 0) add('R6', d, revStop(d, extreme), pocTarget());
      }
      if ((ctxBase.rvolSame ?? 0) >= 1.5 && (extreme - open) * r >= 0.3 * adr && niftyWith(r)) {
        const lvl = extreme - r * atr;
        if ((price - lvl) * r <= 0 && (prev - lvl) * r > 0) add('R7', d, revStop(d, extreme), pocTarget());
      }
      if (vwap !== undefined && (price - vwap) * r >= 1.5 * atr && turnedBack) add('R8', d, revStop(d, extreme), vwap);
    }
  }

  // ---- signals with their slices (and outcomes in the backtest)
  const out: Signal[] = drafts.map((x) => toSignal(inp.symbol, inp.date, x, P));
  for (const sig of out) {
    sig.with = out.filter((o) => o !== sig && o.dir === sig.dir && o.case !== 'M9' && sig.case !== 'M9' && o.slot <= sig.slot && o.slot >= sig.slot - 30 && o.case !== sig.case)
      .map((o) => o.case).filter((c, i, a) => a.indexOf(c) === i);
    if (inp.simulate) sig.out = simulate(sig, day, P);
  }
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
    entry: r2(x.price), stop: r2(x.stop), target: r2(x.target), stopAtr: r2(Math.abs(x.price - x.stop) / x.atr), atr: r2(x.atr), capped: x.capped,
    time: timeBucket(x.slot),
    nFirst5: relPct(c.nFirst5, P.niftyDirPct),
    nDay: c.nDay === undefined ? 'EARLY' : relPct(c.nDay, P.niftyDirPct),
    nRecent: c.nRecent === undefined ? 'EARLY' : relPct(c.nRecent, P.niftyRecentPct),
    rvol, openBusy: c.openBusy, stretch: Math.round(c.ext ?? 0), emaInWay: inWay, gapPct: r2(c.gapPct), with: [],
  };
}

/**
 * What happened next, minute by minute until 15:00. The stop is checked before the target inside a minute (when both
 * are touched in the same minute the trade counts as stopped), so results are on the cautious side.
 */
export function simulate(sig: Signal, day: Slots, P: Params): Outcome {
  const d = sig.dir;
  let entry = sig.entry, start = sig.slot, filled: boolean | undefined;
  const stop = sig.stop;
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
      const none: TargetResult = { hit: false, r: 0, net: 0, min: 0 };
      return { T1: none, T15: { ...none }, TS: { ...none }, mfe: 0, mae: 0, costR: 0, filled: false };
    }
  }
  const dist = Math.abs(entry - stop);
  const levels = { T1: entry + d * dist, T15: entry + d * 1.5 * dist, TS: sig.case === 'M9' ? entry + d * 2 * dist : sig.target };
  const res: Partial<Record<keyof typeof levels, { hit: boolean; exit: number; slot: number }>> = {};
  let mfe = 0, mae = 0;
  const end = Math.min(EXIT_SLOT, day.n);
  for (let s = start; s < end; s++) {
    const hi = day.h[s], lo = day.l[s];
    const stopHit = d === 1 ? lo <= stop : hi >= stop;
    // on the fill minute of a limit order, only the stop counts (the high may have come before the fill)
    const canTarget = !(sig.case === 'M9' && s === start);
    if (stopHit) {
      for (const k of ['T1', 'T15', 'TS'] as const) if (!res[k]) res[k] = { hit: false, exit: stop, slot: s };
      mae = 1; break;
    }
    mfe = Math.max(mfe, ((d === 1 ? hi : lo) - entry) * d / dist);
    mae = Math.max(mae, (entry - (d === 1 ? lo : hi)) * d / dist);
    if (canTarget) for (const k of ['T1', 'T15', 'TS'] as const) {
      if (!res[k] && (d === 1 ? hi >= levels[k] : lo <= levels[k])) res[k] = { hit: true, exit: levels[k], slot: s };
    }
    if (res.T1 && res.T15 && res.TS) break;
  }
  const lastClose = day.c[Math.max(0, end - 1)];
  const qty = sizeFor(P.riskInr, dist);
  const one = (k: keyof typeof levels): TargetResult => {
    const x = res[k] ?? { hit: false, exit: lastClose, slot: end - 1 };
    const r = ((x.exit - entry) * d) / dist;
    const cost = roundTripCharges(qty, entry, x.exit, d) / (qty * dist);
    return { hit: x.hit, r: r2(r), net: r2(r - cost), min: Math.max(1, x.slot - sig.slot + 1) };
  };
  return {
    T1: one('T1'), T15: one('T15'), TS: one('TS'),
    mfe: r2(mfe), mae: r2(Math.min(mae, 1)),
    costR: r2(roundTripCharges(qty, entry, entry, d) / (qty * dist)),
    ...(filled !== undefined ? { filled } : {}),
  };
}
