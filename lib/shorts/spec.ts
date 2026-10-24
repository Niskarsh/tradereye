import type { Candles } from '../dhan';
import { mysteryCutoff, resultOf, scoreR, secOfDay, type ShortTrade, type WeekScore } from './trades';

/**
 * The "spec" handed to the renderer (scripts/shorts/render.py on GitHub Actions): everything the video shows, already
 * decided here, so the renderer only draws. Candles are the real 1-minute candles of the trade's day; the video shows
 * them as 10-minute candles that form live (price moving through each minute), like a real-time chart.
 */

export const SPEC_VERSION = 2; // 2: candles are 1-minute, drawn as live-forming 10-minute candles
export type Template = 'mystery' | 'vs';

export interface PanelSpec {
  tf: number;                                   // minutes per DRAWN candle (10): the renderer builds them live
  candles: [number, number, number, number, number][]; // 1-minute candles [unix sec, o, h, l, c]
  entryIdx: number; exitIdx: number;            // minute index of the first entry fill / last exit fill
  side: 'LONG' | 'SHORT';
  entry: number; exit: number; stop: number | null;
  fills: { idx: number; price: number; kind: 'in' | 'out' }[];
  result: { value: number; unit: 'R' | '%' };
  holdMin: number;
  exitType?: string;                             // STOP / TARGET / MANUAL...: a loss is "STOPPED" only when the stop hit
}

/**
 * A mark on the recap chart (the part after the reveal that shows what the tell talks about). Positions come from the
 * real candles: `slot` is the 10-minute candle's index in the panel, `price` is that candle's own high / low / close
 * (or, for a level, a price inside the chart's range). Claude only says which candle and which kind.
 */
export interface ChartMark { slot: number; kind: 'high' | 'low' | 'close' | 'level'; price: number; label: string }
export interface MysterySpec { kind: 'mystery'; symbol: string; dateLabel: string; panel: PanelSpec; tell: string; marks?: ChartMark[] }
export interface VsSpec {
  kind: 'vs'; weekLabel: string;
  before: { me: number; algo: number }; after: { me: number; algo: number };
  week: WeekScore;
  me?: VsPanel; algo?: VsPanel;
}
/** one side's panel: its trade, the one-line reason, and the candles that reason refers to (marked in the "why" beat) */
export type VsPanel = PanelSpec & { note: string; marks?: ChartMark[]; symbol?: string };
export interface ShortSpec { v: number; id: string; createdAt: number; handle: string; content: MysterySpec | VsSpec }

const IST = 19800;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The day's candles only (IST date), in time order. */
export function dayCandles(c: Candles, date: string): Candles {
  const out: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < c.t.length; i++) {
    if (new Date((c.t[i] + IST) * 1000).toISOString().slice(0, 10) !== date) continue;
    out.t.push(c.t[i]); out.o.push(c.o[i]); out.h.push(c.h[i]); out.l.push(c.l[i]); out.c.push(c.c[i]); out.v.push(c.v[i]);
  }
  return out;
}

const istSec = (t: number) => ((t + IST) % 86400 + 86400) % 86400;

/** Group 1-minute candles into `tf`-minute candles aligned to 09:15. */
export function regroup(c: Candles, tf: number): [number, number, number, number, number][] {
  const out: [number, number, number, number, number][] = [];
  const open = 9 * 3600 + 15 * 60;
  for (let i = 0; i < c.t.length; i++) {
    const bucket = Math.floor((istSec(c.t[i]) - open) / (tf * 60));
    const last = out[out.length - 1];
    const lastBucket = last ? Math.floor((istSec(last[0]) - open) / (tf * 60)) : NaN;
    if (last && lastBucket === bucket) { last[2] = Math.max(last[2], c.h[i]); last[3] = Math.min(last[3], c.l[i]); last[4] = c.c[i]; }
    else out.push([c.t[i], c.o[i], c.h[i], c.l[i], c.c[i]]);
  }
  return out;
}

/** Index of the candle a time of day (HH:mm:ss) falls in. */
function idxAt(cs: [number, number, number, number, number][], hhmmss: string): number {
  // the last candle that starts at or before the time (a fill inside a grouped candle belongs to it)
  const s = secOfDay(hhmmss);
  let k = 0;
  for (let i = 0; i < cs.length; i++) if (istSec(cs[i][0]) <= s) k = i; else break;
  return k;
}

/** Display timeframe: the video draws 10-minute candles that form live from the 1-minute candles inside them. */
export const DISPLAY_TF = 10;
/** at most this much of the day before the entry (a late entry starts the chart later than 09:15) */
const MAX_LEAD_MIN = 120;

/**
 * The window shown, as 1-MINUTE candles (the renderer groups them into live-forming 10-minute candles): from 09:15
 * (or at most two hours before the entry, on a 10-minute boundary) through the whole trade to the end of the
 * 10-minute candle after the exit. Indexes (entry, exit, fills) are minute indexes into `candles`.
 */
export function buildPanel(day: Candles, t: ShortTrade): PanelSpec {
  if (!day.t.length) throw new Error(`No candles saved for ${t.symbol} on ${t.date}.`);
  const all = regroup(day, 1);
  const e = idxAt(all, t.entryTime), x = idxAt(all, t.exitTime);
  const open = 9 * 3600 + 15 * 60, tfSec = DISPLAY_TF * 60;
  const slotStart = (sec: number) => open + Math.floor((sec - open) / tfSec) * tfSec;
  const startSec = slotStart(Math.max(open, istSec(all[e][0]) - MAX_LEAD_MIN * 60));
  const endSec = slotStart(istSec(all[x][0])) + 2 * tfSec; // the exit's candle and one more
  const from = Math.max(0, all.findIndex((k) => istSec(k[0]) >= startSec));
  let to = all.length - 1;
  while (to > x && istSec(all[to][0]) >= endSec) to--;
  const cs = all.slice(from, to + 1);
  return {
    tf: DISPLAY_TF, candles: cs.map((k) => [k[0], r2(k[1]), r2(k[2]), r2(k[3]), r2(k[4])]),
    entryIdx: e - from, exitIdx: x - from, side: t.dir, entry: t.avgEntry, exit: t.avgExit, stop: t.stop ?? null,
    fills: t.fills.map((f) => ({ idx: idxAt(all, f.time) - from, price: f.price, kind: f.kind })).filter((f) => f.idx >= 0 && f.idx < cs.length),
    result: resultOf(t), holdMin: t.holdMin, exitType: t.exitType,
  };
}

/** The panel's drawn (10-minute) candles: start time "HH:MM" and exact O/H/L/C, in order. */
export function slots(p: PanelSpec): { time: string; o: number; h: number; l: number; c: number }[] {
  const tfSec = p.tf * 60, open = 9 * 3600 + 15 * 60;
  const out: { time: string; o: number; h: number; l: number; c: number; s: number }[] = [];
  for (const [t, o, h, l, c] of p.candles) {
    const sec = istSec(t);
    const s = Math.floor((sec - open) / tfSec);
    const last = out[out.length - 1];
    if (last && last.s === s) { last.h = Math.max(last.h, h); last.l = Math.min(last.l, l); last.c = c; }
    else {
      const start = open + s * tfSec;
      out.push({ s, time: `${String(Math.floor(start / 3600)).padStart(2, '0')}:${String(Math.floor(start / 60) % 60).padStart(2, '0')}`, o, h, l, c });
    }
  }
  return out.map(({ s: _s, ...x }) => x); // eslint-disable-line @typescript-eslint/no-unused-vars
}

/**
 * Claude's marks -> marks the renderer can trust: the candle must be on the chart, the price is taken from that
 * candle (a level must lie inside the chart's range), at most 3, labels short. Anything else is dropped.
 */
export function toMarks(raw: unknown, p: PanelSpec): ChartMark[] {
  if (!Array.isArray(raw)) return [];
  const ss = slots(p);
  const lo = Math.min(...ss.map((x) => x.l)), hi = Math.max(...ss.map((x) => x.h));
  const out: ChartMark[] = [];
  for (const m of raw as Record<string, unknown>[]) {
    const kind = String(m?.kind ?? '') as ChartMark['kind'];
    const slot = ss.findIndex((x) => x.time === String(m?.time ?? '').trim().slice(0, 5));
    const label = String(m?.label ?? '').trim().slice(0, 24);
    if (!['high', 'low', 'close', 'level'].includes(kind)) continue;
    if (kind === 'level') {
      const price = Number(m?.price);
      if (!Number.isFinite(price) || price < lo || price > hi) continue;
      out.push({ slot: Math.max(0, slot), kind, price: r2(price), label });
    } else {
      if (slot < 0) continue;
      out.push({ slot, kind, price: r2(kind === 'high' ? ss[slot].h : kind === 'low' ? ss[slot].l : ss[slot].c), label });
    }
    if (out.length === 3) break;
  }
  return out;
}

const DATE_FMT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const dateLabel = (date: string) => DATE_FMT.format(new Date(`${date}T00:00:00Z`));

export function mysterySpec(id: string, t: ShortTrade, day: Candles, tell: string, now = Date.now()): ShortSpec {
  return { v: SPEC_VERSION, id, createdAt: now, handle: '@candlesbeforecubicles', content: { kind: 'mystery', symbol: t.symbol, dateLabel: dateLabel(t.date), panel: buildPanel(day, t), tell: tell.trim().slice(0, 90) } };
}

export function vsPanel(t: ShortTrade & { orderRisk?: number }, day: Candles, note: string, now = Date.now()): VsPanel {
  const p = buildPanel(day, t);
  const r = scoreR(t);
  // the scoreboard counts R; show the same number on the panel
  return {
    ...p, result: r !== undefined ? { value: Math.round(r * 10) / 10, unit: 'R' } : p.result, note: note.trim().slice(0, 40),
    // the ticker is shown only once the trade is over 3 months old (SEBI); recent weeks keep it hidden
    ...(t.date <= mysteryCutoff(now) ? { symbol: t.symbol } : {}),
  };
}

export function vsSpec(id: string, p: { week: WeekScore; before: { me: number; algo: number }; after: { me: number; algo: number }; me?: VsPanel; algo?: VsPanel }, now = Date.now()): ShortSpec {
  return { v: SPEC_VERSION, id, createdAt: now, handle: '@candlesbeforecubicles', content: { kind: 'vs', weekLabel: `Week of ${dateLabel(p.week.week).replace(/ \d{4}$/, '')}`, before: p.before, after: p.after, week: p.week, me: p.me, algo: p.algo } };
}
