import type { Bar, TimeOpts } from '../types';
import {
  atr, change, ema, highest, hma, lowest, prevDay, rma, rsi, sessionVwap, sma, source, SOURCES, stdev, stoch, trueRange, vwma, wma,
} from './math';

/**
 * Every built-in indicator. A definition says what it asks for (inputs), what it draws (plots, fixed lines, fills) and
 * how it is worked out. Add your own with `registerIndicator`.
 */

export type InputType = 'int' | 'float' | 'source' | 'bool' | 'select';
export interface InputDef { key: string; label: string; type: InputType; default: number | string | boolean; min?: number; max?: number; step?: number; options?: string[] }
export type PlotKind = 'line' | 'histogram' | 'area' | 'dots' | 'step' | 'columns';
export interface PlotDef {
  key: string; label: string; color: string; kind?: PlotKind; width?: number;
  /**
   * histogram / columns coloured by sign (and getting stronger / weaker): [up, down, upFading, downFading].
   * 'columns' draw the size (absolute value) from zero and use the sign only for the colour (volume: + = up candle).
   */
  signColors?: [string, string, string?, string?];
}
export interface HLine { value: number; color?: string; dash?: 'dashed' | 'dotted' | 'solid'; label?: string }
/** a fill between two plots, or a plot and a value, or two values (RSI's 30..70 band) */
export interface FillDef { a: string | number; b: string | number; color: string }
export interface Ctx { time: TimeOpts; intervalMin: number }
export interface IndicatorDef {
  id: string; name: string; short: string; category: 'Trend' | 'Oscillators' | 'Volatility' | 'Volume' | 'Levels';
  /** drawn over the price (true) or in a pane of its own (false) */
  overlay: boolean;
  inputs: InputDef[]; plots: PlotDef[]; hlines?: HLine[]; fills?: FillDef[];
  /** a fixed value range for the pane scale (RSI: 0..100) */
  range?: [number, number];
  /** drawn in a special way by the chart (visible range volume profile) */
  special?: 'vpvr' | 'volume';
  /** only for intraday charts */
  intradayOnly?: boolean;
  compute(bars: Bar[], inp: Record<string, number | string | boolean>, ctx: Ctx): Record<string, number[]>;
}

const C = { gold: '#DFB15B', green: '#1DC995', red: '#E03F53', steel: '#8FA8C2', copper: '#E8873A', white: '#E8EAF0', blue: '#2962FF', purple: '#9C27B0', cyan: '#00BCD4' };
const len = (d = 14, label = 'Length'): InputDef => ({ key: 'length', label, type: 'int', default: d, min: 1, max: 1000 });
const src = (d = 'close'): InputDef => ({ key: 'source', label: 'Source', type: 'source', default: d, options: SOURCES });
const N = (v: unknown) => Number(v);
const S = (v: unknown) => String(v);

const defs: IndicatorDef[] = [
  // ---------------- trend (over price)
  { id: 'sma', name: 'Moving Average Simple', short: 'MA', category: 'Trend', overlay: true, inputs: [len(9), src()],
    plots: [{ key: 'ma', label: 'MA', color: C.blue }], compute: (b, i) => ({ ma: sma(source(b, S(i.source)), N(i.length)) }) },
  { id: 'ema', name: 'Moving Average Exponential', short: 'EMA', category: 'Trend', overlay: true, inputs: [len(9), src()],
    plots: [{ key: 'ema', label: 'EMA', color: C.gold }], compute: (b, i) => ({ ema: ema(source(b, S(i.source)), N(i.length)) }) },
  { id: 'wma', name: 'Moving Average Weighted', short: 'WMA', category: 'Trend', overlay: true, inputs: [len(9), src()],
    plots: [{ key: 'wma', label: 'WMA', color: C.cyan }], compute: (b, i) => ({ wma: wma(source(b, S(i.source)), N(i.length)) }) },
  { id: 'hma', name: 'Hull Moving Average', short: 'HMA', category: 'Trend', overlay: true, inputs: [len(9), src()],
    plots: [{ key: 'hma', label: 'HMA', color: C.copper }], compute: (b, i) => ({ hma: hma(source(b, S(i.source)), N(i.length)) }) },
  { id: 'vwma', name: 'Volume Weighted Moving Average', short: 'VWMA', category: 'Trend', overlay: true, inputs: [len(20), src()],
    plots: [{ key: 'vwma', label: 'VWMA', color: C.purple }], compute: (b, i) => ({ vwma: vwma(source(b, S(i.source)), b.map((x) => x.v), N(i.length)) }) },
  { id: 'ema-ribbon', name: 'EMA Ribbon (9 / 21 / 50 / 200)', short: 'EMAs', category: 'Trend', overlay: true, inputs: [src()],
    plots: [{ key: 'e9', label: 'EMA 9', color: C.gold, width: 1 }, { key: 'e21', label: 'EMA 21', color: C.copper, width: 1 }, { key: 'e50', label: 'EMA 50', color: C.steel, width: 1 }, { key: 'e200', label: 'EMA 200', color: C.white, width: 2 }],
    compute: (b, i) => { const x = source(b, S(i.source)); return { e9: ema(x, 9), e21: ema(x, 21), e50: ema(x, 50), e200: ema(x, 200) }; } },
  { id: 'supertrend', name: 'Supertrend', short: 'Supertrend', category: 'Trend', overlay: true,
    inputs: [{ key: 'length', label: 'ATR length', type: 'int', default: 10, min: 1, max: 200 }, { key: 'mult', label: 'Factor', type: 'float', default: 3, min: 0.1, max: 20, step: 0.1 }],
    plots: [{ key: 'up', label: 'Up trend', color: C.green, kind: 'step' }, { key: 'down', label: 'Down trend', color: C.red, kind: 'step' }],
    compute: (b, i) => {
      const a = atr(b, N(i.length)), f = N(i.mult);
      const up = new Array<number>(b.length).fill(NaN), down = new Array<number>(b.length).fill(NaN);
      let fu = NaN, fl = NaN, dir = 1;
      for (let k = 0; k < b.length; k++) {
        if (!Number.isFinite(a[k])) continue;
        const mid = (b[k].h + b[k].l) / 2, bu = mid + f * a[k], bl = mid - f * a[k];
        const pc = k ? b[k - 1].c : b[k].c;
        fu = !Number.isFinite(fu) || bu < fu || pc > fu ? bu : fu;
        fl = !Number.isFinite(fl) || bl > fl || pc < fl ? bl : fl;
        if (dir === 1 && b[k].c < fl) dir = -1; else if (dir === -1 && b[k].c > fu) dir = 1;
        if (dir === 1) up[k] = fl; else down[k] = fu;
      }
      return { up, down };
    } },
  { id: 'psar', name: 'Parabolic SAR', short: 'SAR', category: 'Trend', overlay: true,
    inputs: [{ key: 'start', label: 'Start', type: 'float', default: 0.02, step: 0.01, min: 0.001, max: 1 }, { key: 'inc', label: 'Increment', type: 'float', default: 0.02, step: 0.01, min: 0.001, max: 1 }, { key: 'max', label: 'Max', type: 'float', default: 0.2, step: 0.01, min: 0.01, max: 1 }],
    plots: [{ key: 'sar', label: 'SAR', color: C.steel, kind: 'dots' }],
    compute: (b, i) => {
      const out = new Array<number>(b.length).fill(NaN);
      if (b.length < 2) return { sar: out };
      let long = b[1].c >= b[0].c, af = N(i.start), ep = long ? b[0].h : b[0].l, sar = long ? b[0].l : b[0].h;
      for (let k = 1; k < b.length; k++) {
        sar = sar + af * (ep - sar);
        if (long) {
          sar = Math.min(sar, b[k - 1].l, k > 1 ? b[k - 2].l : b[k - 1].l);
          if (b[k].l < sar) { long = false; sar = ep; ep = b[k].l; af = N(i.start); }
          else if (b[k].h > ep) { ep = b[k].h; af = Math.min(af + N(i.inc), N(i.max)); }
        } else {
          sar = Math.max(sar, b[k - 1].h, k > 1 ? b[k - 2].h : b[k - 1].h);
          if (b[k].h > sar) { long = true; sar = ep; ep = b[k].h; af = N(i.start); }
          else if (b[k].l < ep) { ep = b[k].l; af = Math.min(af + N(i.inc), N(i.max)); }
        }
        out[k] = sar;
      }
      return { sar: out };
    } },
  { id: 'ichimoku', name: 'Ichimoku Cloud', short: 'Ichimoku', category: 'Trend', overlay: true,
    inputs: [{ key: 'conv', label: 'Conversion line', type: 'int', default: 9, min: 1 }, { key: 'base', label: 'Base line', type: 'int', default: 26, min: 1 }, { key: 'spanB', label: 'Leading span B', type: 'int', default: 52, min: 1 }],
    plots: [{ key: 'conv', label: 'Conversion', color: C.blue, width: 1 }, { key: 'base', label: 'Base', color: C.red, width: 1 }, { key: 'a', label: 'Lead A', color: C.green, width: 1 }, { key: 'b', label: 'Lead B', color: C.red, width: 1 }],
    fills: [{ a: 'a', b: 'b', color: 'rgba(143,168,194,0.12)' }],
    compute: (b, i) => {
      const hi = b.map((x) => x.h), lo = b.map((x) => x.l);
      const mid = (n: number) => { const h = highest(hi, n), l = lowest(lo, n); return h.map((v, k) => (v + l[k]) / 2); };
      const conv = mid(N(i.conv)), base = mid(N(i.base)), sb = mid(N(i.spanB));
      const shift = N(i.base) - 1;
      const a = new Array<number>(b.length).fill(NaN), bb = new Array<number>(b.length).fill(NaN);
      for (let k = 0; k + shift < b.length; k++) { a[k + shift] = (conv[k] + base[k]) / 2; bb[k + shift] = sb[k]; }
      return { conv, base, a, b: bb };
    } },
  // ---------------- volatility
  { id: 'bb', name: 'Bollinger Bands', short: 'BB', category: 'Volatility', overlay: true,
    inputs: [len(20), src(), { key: 'mult', label: 'StdDev', type: 'float', default: 2, min: 0.1, max: 10, step: 0.1 }],
    plots: [{ key: 'basis', label: 'Basis', color: C.copper, width: 1 }, { key: 'upper', label: 'Upper', color: C.blue, width: 1 }, { key: 'lower', label: 'Lower', color: C.blue, width: 1 }],
    fills: [{ a: 'upper', b: 'lower', color: 'rgba(41,98,255,0.06)' }],
    compute: (b, i) => { const x = source(b, S(i.source)), m = sma(x, N(i.length)), d = stdev(x, N(i.length)); return { basis: m, upper: m.map((v, k) => v + N(i.mult) * d[k]), lower: m.map((v, k) => v - N(i.mult) * d[k]) }; } },
  { id: 'kc', name: 'Keltner Channels', short: 'KC', category: 'Volatility', overlay: true,
    inputs: [len(20), { key: 'mult', label: 'Multiplier', type: 'float', default: 2, step: 0.1, min: 0.1, max: 10 }],
    plots: [{ key: 'basis', label: 'Basis', color: C.blue, width: 1 }, { key: 'upper', label: 'Upper', color: C.blue, width: 1 }, { key: 'lower', label: 'Lower', color: C.blue, width: 1 }],
    fills: [{ a: 'upper', b: 'lower', color: 'rgba(41,98,255,0.05)' }],
    compute: (b, i) => { const m = ema(source(b, 'close'), N(i.length)), r = ema(trueRange(b), N(i.length)); return { basis: m, upper: m.map((v, k) => v + N(i.mult) * r[k]), lower: m.map((v, k) => v - N(i.mult) * r[k]) }; } },
  { id: 'donchian', name: 'Donchian Channels', short: 'DC', category: 'Volatility', overlay: true, inputs: [len(20)],
    plots: [{ key: 'upper', label: 'Upper', color: C.blue, width: 1 }, { key: 'basis', label: 'Basis', color: C.copper, width: 1 }, { key: 'lower', label: 'Lower', color: C.blue, width: 1 }],
    fills: [{ a: 'upper', b: 'lower', color: 'rgba(41,98,255,0.05)' }],
    compute: (b, i) => { const u = highest(b.map((x) => x.h), N(i.length)), l = lowest(b.map((x) => x.l), N(i.length)); return { upper: u, lower: l, basis: u.map((v, k) => (v + l[k]) / 2) }; } },
  { id: 'atr', name: 'Average True Range', short: 'ATR', category: 'Volatility', overlay: false, inputs: [len(14)],
    plots: [{ key: 'atr', label: 'ATR', color: C.red }], compute: (b, i) => ({ atr: atr(b, N(i.length)) }) },
  // ---------------- levels (intraday)
  { id: 'vwap', name: 'VWAP', short: 'VWAP', category: 'Levels', overlay: true, intradayOnly: true,
    inputs: [src('hlc3'), { key: 'bands', label: 'Band multiplier (0 = off)', type: 'float', default: 0, min: 0, max: 5, step: 0.5 }],
    plots: [{ key: 'vwap', label: 'VWAP', color: C.blue, width: 2 }, { key: 'upper', label: 'Upper band', color: C.green, width: 1 }, { key: 'lower', label: 'Lower band', color: C.green, width: 1 }],
    compute: (b, i, ctx) => {
      const { vwap, sd } = sessionVwap(b, source(b, S(i.source)), ctx.time.tzOffsetSec);
      const m = N(i.bands);
      return { vwap, upper: m > 0 ? vwap.map((v, k) => v + m * sd[k]) : vwap.map(() => NaN), lower: m > 0 ? vwap.map((v, k) => v - m * sd[k]) : vwap.map(() => NaN) };
    } },
  { id: 'pdhl', name: 'Previous Day High / Low / Close', short: 'PDH/PDL', category: 'Levels', overlay: true, intradayOnly: true, inputs: [],
    plots: [{ key: 'pdh', label: 'PDH', color: C.green, kind: 'step', width: 1 }, { key: 'pdl', label: 'PDL', color: C.red, kind: 'step', width: 1 }, { key: 'pdc', label: 'PDC', color: C.steel, kind: 'step', width: 1 }],
    compute: (b, _i, ctx) => { const p = prevDay(b, ctx.time.tzOffsetSec); return { pdh: p.ph, pdl: p.pl, pdc: p.pc }; } },
  { id: 'pivots', name: 'Pivot Points Standard (daily)', short: 'Pivots', category: 'Levels', overlay: true, intradayOnly: true, inputs: [],
    plots: [{ key: 'p', label: 'P', color: C.copper, kind: 'step', width: 1 }, { key: 'r1', label: 'R1', color: C.red, kind: 'step', width: 1 }, { key: 's1', label: 'S1', color: C.green, kind: 'step', width: 1 }, { key: 'r2', label: 'R2', color: C.red, kind: 'step', width: 1 }, { key: 's2', label: 'S2', color: C.green, kind: 'step', width: 1 }],
    compute: (b, _i, ctx) => {
      const { ph, pl, pc } = prevDay(b, ctx.time.tzOffsetSec);
      const p = ph.map((h, k) => (h + pl[k] + pc[k]) / 3);
      return { p, r1: p.map((v, k) => 2 * v - pl[k]), s1: p.map((v, k) => 2 * v - ph[k]), r2: p.map((v, k) => v + ph[k] - pl[k]), s2: p.map((v, k) => v - (ph[k] - pl[k])) };
    } },
  { id: 'orb', name: 'Opening Range', short: 'ORB', category: 'Levels', overlay: true, intradayOnly: true,
    inputs: [{ key: 'minutes', label: 'Minutes', type: 'int', default: 15, min: 1, max: 120 }],
    plots: [{ key: 'hi', label: 'OR high', color: C.gold, kind: 'step', width: 1 }, { key: 'lo', label: 'OR low', color: C.gold, kind: 'step', width: 1 }],
    compute: (b, i, ctx) => {
      const tz = ctx.time.tzOffsetSec, open = ctx.time.sessionOpenMin, m = N(i.minutes);
      const hi = new Array<number>(b.length).fill(NaN), lo = new Array<number>(b.length).fill(NaN);
      let day = NaN, h = -Infinity, l = Infinity, done = false;
      for (let k = 0; k < b.length; k++) {
        const d = Math.floor((b[k].t + tz) / 86400), min = Math.floor(((b[k].t + tz) % 86400) / 60);
        if (d !== day) { day = d; h = -Infinity; l = Infinity; done = false; }
        const endMin = min + Math.max(1, ctx.intervalMin);
        if (!done && min < open + m) { h = Math.max(h, b[k].h); l = Math.min(l, b[k].l); if (endMin >= open + m) done = true; }
        else done = true;
        if (done && Number.isFinite(h)) { hi[k] = h; lo[k] = l; }
      }
      return { hi, lo };
    } },
  { id: 'vpvr', name: 'Volume Profile Visible Range', short: 'VPVR', category: 'Volume', overlay: true, special: 'vpvr',
    inputs: [{ key: 'rows', label: 'Rows', type: 'int', default: 24, min: 6, max: 200 }, { key: 'va', label: 'Value area %', type: 'int', default: 70, min: 10, max: 100 }],
    plots: [{ key: 'up', label: 'Up volume', color: 'rgba(29,201,149,0.35)' }, { key: 'down', label: 'Down volume', color: 'rgba(224,63,83,0.35)' }, { key: 'poc', label: 'POC', color: C.gold }],
    compute: () => ({}) },
  // ---------------- volume
  { id: 'vol', name: 'Volume (on the price pane)', short: 'Volume', category: 'Volume', overlay: true, special: 'volume',
    inputs: [{ key: 'ma', label: 'MA length (0 = off)', type: 'int', default: 0, min: 0, max: 500 }, { key: 'height', label: 'Height (% of pane)', type: 'int', default: 18, min: 5, max: 60 }],
    plots: [{ key: 'up', label: 'Up volume', color: 'rgba(232,234,240,0.28)' }, { key: 'down', label: 'Down volume', color: 'rgba(124,136,153,0.32)' }, { key: 'ma', label: 'Volume MA', color: C.gold, width: 1 }],
    compute: (b, i) => { const v = b.map((x) => x.v); return { ma: N(i.ma) > 0 ? sma(v, N(i.ma)) : v.map(() => NaN) }; } },
  { id: 'volume', name: 'Volume (own pane)', short: 'Vol', category: 'Volume', overlay: false, inputs: [{ key: 'ma', label: 'MA length (0 = off)', type: 'int', default: 20, min: 0, max: 500 }],
    plots: [{ key: 'vol', label: 'Volume', color: C.steel, kind: 'columns', signColors: ['rgba(29,201,149,0.5)', 'rgba(224,63,83,0.5)'] }, { key: 'ma', label: 'Volume MA', color: C.gold, width: 1 }],
    compute: (b, i) => { const v = b.map((x) => x.v); return { vol: v.map((x, k) => (b[k].c >= b[k].o ? x : -x)), ma: N(i.ma) > 0 ? sma(v, N(i.ma)) : v.map(() => NaN) }; } },
  { id: 'rvol', name: 'Relative Volume at Time', short: 'RVOL', category: 'Volume', overlay: false, intradayOnly: true,
    inputs: [{ key: 'days', label: 'Days to average', type: 'int', default: 10, min: 1, max: 60 }, { key: 'cumulative', label: 'Cumulative (day so far)', type: 'bool', default: true }],
    plots: [{ key: 'rvol', label: 'RVOL', color: C.steel, kind: 'columns', signColors: ['rgba(29,201,149,0.6)', 'rgba(143,168,194,0.5)'] }],
    hlines: [{ value: 1, dash: 'dashed', label: '1' }],
    compute: (b, i, ctx) => {
      const tz = ctx.time.tzOffsetSec, nDays = N(i.days), cum = !!i.cumulative;
      const out = new Array<number>(b.length).fill(NaN);
      const hist = new Map<number, number[]>(); // slot -> past values (cumulative or single)
      let day = NaN, run = 0, today: [number, number][] = [];
      const flush = () => { for (const [slot, v] of today) { const a = hist.get(slot) ?? []; a.push(v); if (a.length > nDays) a.shift(); hist.set(slot, a); } today = []; };
      for (let k = 0; k < b.length; k++) {
        const d = Math.floor((b[k].t + tz) / 86400), slot = Math.floor(((b[k].t + tz) % 86400) / 60);
        if (d !== day) { flush(); day = d; run = 0; }
        run += b[k].v;
        const v = cum ? run : b[k].v;
        const past = hist.get(slot);
        if (past && past.length) { const avg = past.reduce((a, x) => a + x, 0) / past.length; if (avg > 0) out[k] = v / avg; }
        today.push([slot, v]);
      }
      return { rvol: out.map((v) => (Number.isFinite(v) ? (v >= 1 ? v : -v) : NaN)) };
    } },
  { id: 'obv', name: 'On Balance Volume', short: 'OBV', category: 'Volume', overlay: false, inputs: [],
    plots: [{ key: 'obv', label: 'OBV', color: C.blue }],
    compute: (b) => { let s = 0; return { obv: b.map((x, k) => { if (k) s += x.c > b[k - 1].c ? x.v : x.c < b[k - 1].c ? -x.v : 0; return s; }) }; } },
  { id: 'mfi', name: 'Money Flow Index', short: 'MFI', category: 'Volume', overlay: false, inputs: [len(14)], range: [0, 100],
    plots: [{ key: 'mfi', label: 'MFI', color: C.purple }], hlines: [{ value: 80, dash: 'dashed' }, { value: 20, dash: 'dashed' }],
    compute: (b, i) => {
      const n = N(i.length), tp = source(b, 'hlc3');
      const pos = tp.map((v, k) => (k && v > tp[k - 1] ? v * b[k].v : 0)), neg = tp.map((v, k) => (k && v < tp[k - 1] ? v * b[k].v : 0));
      const p = sma(pos, n), q = sma(neg, n);
      return { mfi: p.map((v, k) => (q[k] === 0 ? 100 : 100 - 100 / (1 + v / q[k]))) };
    } },
  { id: 'cmf', name: 'Chaikin Money Flow', short: 'CMF', category: 'Volume', overlay: false, inputs: [len(20)],
    plots: [{ key: 'cmf', label: 'CMF', color: C.green, kind: 'histogram', signColors: [C.green, C.red] }], hlines: [{ value: 0 }],
    compute: (b, i) => {
      const mfv = b.map((x) => (x.h > x.l ? (((x.c - x.l) - (x.h - x.c)) / (x.h - x.l)) * x.v : 0));
      const a = sma(mfv, N(i.length)), v = sma(b.map((x) => x.v), N(i.length));
      return { cmf: a.map((x, k) => (v[k] > 0 ? x / v[k] : NaN)) };
    } },
  // ---------------- oscillators
  { id: 'rsi', name: 'Relative Strength Index', short: 'RSI', category: 'Oscillators', overlay: false, inputs: [len(14), src(), { key: 'ma', label: 'Smoothing MA (0 = off)', type: 'int', default: 14, min: 0, max: 200 }],
    range: [0, 100], plots: [{ key: 'rsi', label: 'RSI', color: C.purple }, { key: 'ma', label: 'RSI MA', color: C.gold, width: 1 }],
    hlines: [{ value: 70, dash: 'dashed' }, { value: 50, dash: 'dotted' }, { value: 30, dash: 'dashed' }],
    fills: [{ a: 70, b: 30, color: 'rgba(156,39,176,0.06)' }],
    compute: (b, i) => { const r = rsi(source(b, S(i.source)), N(i.length)); return { rsi: r, ma: N(i.ma) > 0 ? sma(r, N(i.ma)) : r.map(() => NaN) }; } },
  { id: 'macd', name: 'MACD', short: 'MACD', category: 'Oscillators', overlay: false,
    inputs: [{ key: 'fast', label: 'Fast length', type: 'int', default: 12, min: 1 }, { key: 'slow', label: 'Slow length', type: 'int', default: 26, min: 1 }, { key: 'signal', label: 'Signal smoothing', type: 'int', default: 9, min: 1 }, src()],
    plots: [{ key: 'hist', label: 'Histogram', color: C.green, kind: 'histogram', signColors: ['#26A69A', '#FF5252', '#B2DFDB', '#FFCDD2'] }, { key: 'macd', label: 'MACD', color: C.blue }, { key: 'signal', label: 'Signal', color: C.copper }],
    hlines: [{ value: 0, dash: 'dotted' }],
    compute: (b, i) => {
      const x = source(b, S(i.source)), f = ema(x, N(i.fast)), s = ema(x, N(i.slow)), m = f.map((v, k) => v - s[k]);
      const sig = ema(m, N(i.signal));
      return { macd: m, signal: sig, hist: m.map((v, k) => v - sig[k]) };
    } },
  { id: 'stoch', name: 'Stochastic', short: 'Stoch', category: 'Oscillators', overlay: false, range: [0, 100],
    inputs: [{ key: 'k', label: '%K length', type: 'int', default: 14, min: 1 }, { key: 'ks', label: '%K smoothing', type: 'int', default: 1, min: 1 }, { key: 'd', label: '%D smoothing', type: 'int', default: 3, min: 1 }],
    plots: [{ key: 'k', label: '%K', color: C.blue }, { key: 'd', label: '%D', color: C.copper }], hlines: [{ value: 80, dash: 'dashed' }, { value: 20, dash: 'dashed' }],
    compute: (b, i) => { const k = sma(stoch(source(b, 'close'), b.map((x) => x.h), b.map((x) => x.l), N(i.k)), N(i.ks)); return { k, d: sma(k, N(i.d)) }; } },
  { id: 'stochrsi', name: 'Stochastic RSI', short: 'Stoch RSI', category: 'Oscillators', overlay: false, range: [0, 100],
    inputs: [{ key: 'k', label: 'K', type: 'int', default: 3, min: 1 }, { key: 'd', label: 'D', type: 'int', default: 3, min: 1 }, { key: 'rsi', label: 'RSI length', type: 'int', default: 14, min: 1 }, { key: 'st', label: 'Stochastic length', type: 'int', default: 14, min: 1 }],
    plots: [{ key: 'k', label: 'K', color: C.blue }, { key: 'd', label: 'D', color: C.copper }], hlines: [{ value: 80, dash: 'dashed' }, { value: 20, dash: 'dashed' }],
    compute: (b, i) => { const r = rsi(source(b, 'close'), N(i.rsi)); const k = sma(stoch(r, r, r, N(i.st)), N(i.k)); return { k, d: sma(k, N(i.d)) }; } },
  { id: 'cci', name: 'Commodity Channel Index', short: 'CCI', category: 'Oscillators', overlay: false, inputs: [len(20), src('hlc3')],
    plots: [{ key: 'cci', label: 'CCI', color: C.blue }], hlines: [{ value: 100, dash: 'dashed' }, { value: 0, dash: 'dotted' }, { value: -100, dash: 'dashed' }],
    compute: (b, i) => {
      const n = N(i.length), x = source(b, S(i.source)), m = sma(x, n);
      return { cci: x.map((v, k) => { if (!Number.isFinite(m[k])) return NaN; let d = 0; for (let j = 0; j < n; j++) d += Math.abs(x[k - j] - m[k]); d /= n; return d ? (v - m[k]) / (0.015 * d) : 0; }) };
    } },
  { id: 'willr', name: 'Williams %R', short: '%R', category: 'Oscillators', overlay: false, inputs: [len(14)], range: [-100, 0],
    plots: [{ key: 'r', label: '%R', color: C.purple }], hlines: [{ value: -20, dash: 'dashed' }, { value: -80, dash: 'dashed' }],
    compute: (b, i) => { const s = stoch(source(b, 'close'), b.map((x) => x.h), b.map((x) => x.l), N(i.length)); return { r: s.map((v) => v - 100) }; } },
  { id: 'adx', name: 'ADX / DMI', short: 'DMI', category: 'Oscillators', overlay: false, inputs: [len(14, 'DI length'), { key: 'smooth', label: 'ADX smoothing', type: 'int', default: 14, min: 1 }],
    plots: [{ key: 'adx', label: 'ADX', color: C.red }, { key: 'plus', label: '+DI', color: C.blue }, { key: 'minus', label: '-DI', color: C.copper }],
    compute: (b, i) => {
      const n = N(i.length);
      const up = b.map((x, k) => (k ? x.h - b[k - 1].h : NaN)), dn = b.map((x, k) => (k ? b[k - 1].l - x.l : NaN));
      const pdm = up.map((u, k) => (u > dn[k] && u > 0 ? u : 0)), mdm = dn.map((d, k) => (d > up[k] && d > 0 ? d : 0));
      const tr = rma(trueRange(b), n), p = rma(pdm, n), m = rma(mdm, n);
      const plus = p.map((v, k) => (100 * v) / tr[k]), minus = m.map((v, k) => (100 * v) / tr[k]);
      const dx = plus.map((v, k) => { const s = v + minus[k]; return s ? (100 * Math.abs(v - minus[k])) / s : 0; });
      return { adx: rma(dx, N(i.smooth)), plus, minus };
    } },
  { id: 'roc', name: 'Rate Of Change', short: 'ROC', category: 'Oscillators', overlay: false, inputs: [len(9), src()],
    plots: [{ key: 'roc', label: 'ROC', color: C.blue }], hlines: [{ value: 0, dash: 'dotted' }],
    compute: (b, i) => { const x = source(b, S(i.source)), n = N(i.length); return { roc: x.map((v, k) => (k >= n ? (100 * (v - x[k - n])) / x[k - n] : NaN)) }; } },
  { id: 'mom', name: 'Momentum', short: 'Mom', category: 'Oscillators', overlay: false, inputs: [len(10), src()],
    plots: [{ key: 'mom', label: 'Momentum', color: C.blue }], hlines: [{ value: 0, dash: 'dotted' }],
    compute: (b, i) => ({ mom: change(source(b, S(i.source)), N(i.length)) }) },
  { id: 'ao', name: 'Awesome Oscillator', short: 'AO', category: 'Oscillators', overlay: false, inputs: [],
    plots: [{ key: 'ao', label: 'AO', color: C.green, kind: 'histogram', signColors: [C.green, C.red] }],
    compute: (b) => { const m = source(b, 'hl2'), f = sma(m, 5), s = sma(m, 34); return { ao: f.map((v, k) => v - s[k]) }; } },
  { id: 'aroon', name: 'Aroon', short: 'Aroon', category: 'Oscillators', overlay: false, inputs: [len(14)], range: [0, 100],
    plots: [{ key: 'up', label: 'Aroon up', color: C.copper }, { key: 'down', label: 'Aroon down', color: C.blue }],
    compute: (b, i) => {
      const n = N(i.length), up = new Array<number>(b.length).fill(NaN), dn = new Array<number>(b.length).fill(NaN);
      for (let k = n; k < b.length; k++) {
        let hi = k, lo = k;
        for (let j = k - n; j <= k; j++) { if (b[j].h >= b[hi].h) hi = j; if (b[j].l <= b[lo].l) lo = j; }
        up[k] = (100 * (n - (k - hi))) / n; dn[k] = (100 * (n - (k - lo))) / n;
      }
      return { up, down: dn };
    } },
  { id: 'trix', name: 'TRIX', short: 'TRIX', category: 'Oscillators', overlay: false, inputs: [len(18)],
    plots: [{ key: 'trix', label: 'TRIX', color: C.red }], hlines: [{ value: 0, dash: 'dotted' }],
    compute: (b, i) => { const n = N(i.length), e = ema(ema(ema(b.map((x) => Math.log(x.c)), n), n), n); return { trix: e.map((v, k) => (k ? 10000 * (v - e[k - 1]) : NaN)) }; } },
];

const REG = new Map<string, IndicatorDef>(defs.map((d) => [d.id, d]));

export function registerIndicator(def: IndicatorDef): void { REG.set(def.id, def); }
export function getIndicator(id: string): IndicatorDef | undefined { return REG.get(id); }
export function listIndicators(): IndicatorDef[] { return [...REG.values()]; }
