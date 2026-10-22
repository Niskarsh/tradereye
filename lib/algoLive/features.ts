import type { Candles } from '../dhan';
import type { Bar, Session } from '../live/enrich';
import { istParts, SESSION_OPEN_MIN } from '../live/time';
import { gridDay, ML_KEYS } from '../ml/grid';

/**
 * Algo Live: the facts of one stock at one 10-minute close, computed by the very code that built the backtest's dataset
 * (lib/ml/grid.ts gridDay), so live and backtest cannot drift apart.
 *
 * gridDay needs a whole day (it also works out what the trades would have made). Live we only have the minutes up to
 * now, so the rest of the day is filled flat (no volume). The facts at a close only ever read the minutes before it
 * (tests/ml.test.ts "no look-ahead" proves that), so the filler never touches them.
 */

const slotOf = (b: Bar) => istParts(b.t * 1000).minuteOfDay - SESSION_OPEN_MIN;

/** the minutes before slot k (k = minutes since 09:15 of the 10-min close), then flat to the end of the day */
export function padDay(bars: Bar[], k: number): Bar[] {
  const kept = bars.filter((b) => { const s = slotOf(b); return s >= 0 && s < k; }).sort((a, b) => a.t - b.t);
  if (!kept.length) return [];
  const last = kept[kept.length - 1];
  const t0 = last.t - slotOf(last) * 60;
  return [...kept, { t: t0 + 374 * 60, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 }];
}

export interface StockInput { date: string; history: Session[]; today: Bar[]; nifty: Bar[]; daily: Candles }

/** the facts (by name) at slot k, or undefined when the stock has no row there (too little history, a 20% gap, ...) */
export function factsAt(inp: StockInput, k: number): Record<string, number> | undefined {
  const day = padDay(inp.today, k), nifty = padDay(inp.nifty, k);
  if (!day.length || !nifty.length) return undefined;
  const row = gridDay({ date: inp.date, history: inp.history, day, nifty, daily: inp.daily }).find((r) => r[0] === k);
  if (!row) return undefined;
  const x: Record<string, number> = {};
  ML_KEYS.forEach((f, i) => { x[f] = row[1 + i]; });
  return x;
}

/** is the minute just before slot k in (Dhan serves a minute a few seconds after it closes)? */
export function hasMinute(bars: Bar[], k: number): boolean {
  return bars.some((b) => slotOf(b) === k - 1);
}

/** the daily candles strictly before `date` (the backtest cuts them the same way) */
export function dailyBefore(c: Candles, date: string): Candles {
  const IST = 19800_000;
  const n = c.t.findIndex((t) => new Date(t * 1000 + IST).toISOString().slice(0, 10) >= date);
  const end = n < 0 ? c.t.length : n;
  return { t: c.t.slice(0, end), o: c.o.slice(0, end), h: c.h.slice(0, end), l: c.l.slice(0, end), c: c.c.slice(0, end), v: c.v.slice(0, end) };
}
