import type { Candles } from '../dhan';
import { resultOf, scoreR, secOfDay, type ShortTrade, type WeekScore } from './trades';

/**
 * The "spec" handed to the renderer (scripts/shorts/render.py on GitHub Actions): everything the video shows, already
 * decided here, so the renderer only draws. Candles are the real 1-minute candles of the trade's day (grouped into
 * 2-, 3- or 5-minute candles when the trade is long, so a 60-second short stays readable).
 */

export const SPEC_VERSION = 1;
export type Template = 'mystery' | 'vs';

export interface PanelSpec {
  tf: number;                                   // minutes per candle
  candles: [number, number, number, number, number][]; // [unix sec, o, h, l, c]
  entryIdx: number; exitIdx: number;            // candle index of the first entry fill / last exit fill
  side: 'LONG' | 'SHORT';
  entry: number; exit: number; stop: number | null;
  fills: { idx: number; price: number; kind: 'in' | 'out' }[];
  result: { value: number; unit: 'R' | '%' };
  holdMin: number;
}

export interface MysterySpec { kind: 'mystery'; symbol: string; dateLabel: string; panel: PanelSpec; tell: string }
export interface VsSpec {
  kind: 'vs'; weekLabel: string;
  before: { me: number; algo: number }; after: { me: number; algo: number };
  week: WeekScore;
  me?: PanelSpec & { note: string }; algo?: PanelSpec & { note: string };
}
export interface ShortSpec { v: number; id: string; createdAt: number; handle: string; content: MysterySpec | VsSpec }

const IST = 19800;
const MAX_CANDLES = 120;
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

/**
 * The window shown: some lead-up before the entry (the story the viewer reads), the whole trade, a few candles after.
 * The candle size grows until the window fits in MAX_CANDLES.
 */
export function buildPanel(day: Candles, t: ShortTrade): PanelSpec {
  if (!day.t.length) throw new Error(`No candles saved for ${t.symbol} on ${t.date}.`);
  for (const tf of [1, 2, 3, 5, 10]) {
    const all = regroup(day, tf);
    const e = idxAt(all, t.entryTime), x = idxAt(all, t.exitTime);
    // 30-60 minutes of lead-up (the part the viewer reads before deciding), in candles of this size
    const lead = Math.min(e, Math.round(Math.max(30, Math.min(60, t.holdMin * 0.6)) / tf));
    const from = Math.max(0, e - lead), to = Math.min(all.length - 1, x + Math.max(2, Math.round(6 / tf)));
    if (to - from + 1 > MAX_CANDLES && tf < 10) continue;
    const cs = all.slice(from, to + 1);
    return {
      tf, candles: cs.map((k) => [k[0], r2(k[1]), r2(k[2]), r2(k[3]), r2(k[4])]),
      entryIdx: e - from, exitIdx: x - from, side: t.dir, entry: t.avgEntry, exit: t.avgExit, stop: t.stop ?? null,
      fills: t.fills.map((f) => ({ idx: idxAt(all, f.time) - from, price: f.price, kind: f.kind })).filter((f) => f.idx >= 0 && f.idx < cs.length),
      result: resultOf(t), holdMin: t.holdMin,
    };
  }
  throw new Error('Could not fit the trade into a short.');
}

const DATE_FMT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const dateLabel = (date: string) => DATE_FMT.format(new Date(`${date}T00:00:00Z`));

export function mysterySpec(id: string, t: ShortTrade, day: Candles, tell: string, now = Date.now()): ShortSpec {
  return { v: SPEC_VERSION, id, createdAt: now, handle: '@candlesbeforecubicles', content: { kind: 'mystery', symbol: t.symbol, dateLabel: dateLabel(t.date), panel: buildPanel(day, t), tell: tell.trim().slice(0, 90) } };
}

export function vsPanel(t: ShortTrade & { orderRisk?: number }, day: Candles, note: string): PanelSpec & { note: string } {
  const p = buildPanel(day, t);
  const r = scoreR(t);
  // the scoreboard counts R; show the same number on the panel
  return { ...p, result: r !== undefined ? { value: Math.round(r * 10) / 10, unit: 'R' } : p.result, note: note.trim().slice(0, 40) };
}

export function vsSpec(id: string, p: { week: WeekScore; before: { me: number; algo: number }; after: { me: number; algo: number }; me?: PanelSpec & { note: string }; algo?: PanelSpec & { note: string } }, now = Date.now()): ShortSpec {
  return { v: SPEC_VERSION, id, createdAt: now, handle: '@candlesbeforecubicles', content: { kind: 'vs', weekLabel: `Week of ${dateLabel(p.week.week).replace(/ \d{4}$/, '')}`, before: p.before, after: p.after, week: p.week, me: p.me, algo: p.algo } };
}
