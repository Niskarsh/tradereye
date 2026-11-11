import type { Candles } from '../dhan';
import { wideVol } from '../ml/grid';
import type { LiveModel } from './model';

/**
 * Algo Live, the wide model (iteration 15's pick, scripts/ml_live_wide.py): what it adds to the narrow engine, worked out
 * exactly as the model's Python did.
 *
 *  - turnover: the stock's average daily turnover in rupees, as scripts/ml_live_wide.py turnover_rs: the dataset's avgVol
 *    (10-day average shares, scaled to a ₹340 stock above ₹340, lib/ml/grid.ts) x min(price, ₹340). Below the model's
 *    floor (₹100 crore a day) a stock is still scored and ranked, but never traded.
 *  - the market gate: the market's 20-day move is the median 20-day move of every stock on the day list (known before the
 *    open); the day is "hot" when that is above the top third (numpy's quantile) of its last 250 days, with 60 days of
 *    history at least. On a hot day the wide model trades nothing.
 */

/** the dataset's avgVol for a stock from its daily candles before today (lib/ml/grid.ts gridDay) */
export function avgVolOf(daily: Candles, wide: boolean): number {
  const n = daily.c.length;
  if (n < 10) return NaN;
  let v = 0;
  for (let j = n - 10; j < n; j++) v += daily.v[j];
  return wide ? wideVol(v / 10, daily.c[n - 1]) : v / 10;
}

/** average daily turnover in rupees at this price */
export const turnoverOf = (avgVol: number, price: number, refPrice = 340) => avgVol * Math.min(price, refPrice);

/** the 20-day move (%) the dataset's ret20d holds: last close vs the close 20 sessions before it (daily candles before today) */
export function ret20dOf(daily: Candles): number {
  const n = daily.c.length;
  return n > 20 ? (daily.c[n - 1] / daily.c[n - 21] - 1) * 100 : NaN;
}

/** pandas' median (missing left out) */
export function median(xs: number[]): number {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** numpy's quantile (linear interpolation) */
export function quantile(xs: number[], q: number): number {
  const v = [...xs].sort((a, b) => a - b);
  if (!v.length) return NaN;
  const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export interface GateRule { days: number; min: number; q: number }

/** is `today` hot against the days before it (oldest first)? the bar is null with too little history (then never hot) */
export function hotAgainst(past: (number | null)[], today: number, g: GateRule): { hot: boolean; bar: number | null; history: number } {
  const p = past.slice(-g.days).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (p.length < g.min || !Number.isFinite(today)) return { hot: false, bar: null, history: p.length };
  const bar = quantile(p, g.q);
  return { hot: today > bar, bar, history: p.length };
}

export interface GateToday { move: number | null; bar: number | null; hot: boolean; history: number; stocks: number }

/**
 * Today's gate for the wide model: the model's own history (to its data's last day), then the days Algo Live saved since
 * (`saved`, date -> move), then today's move from the day list's 20-day moves.
 */
export function gateToday(model: Pick<LiveModel, 'gate' | 'dataTo'>, saved: Record<string, number>, date: string, ret20ds: number[]): GateToday {
  const g = model.gate!;
  const hist = g.history.filter(([d]) => d < date);
  const last = hist.at(-1)?.[0] ?? '';
  const later = Object.entries(saved).filter(([d]) => d > last && d < date).sort(([a], [b]) => a.localeCompare(b));
  const past = [...hist.map(([, v]) => v), ...later.map(([, v]) => v)];
  const move = median(ret20ds);
  const r = hotAgainst(past, move, g);
  return { move: Number.isFinite(move) ? move : null, bar: r.bar, hot: r.hot, history: r.history, stocks: ret20ds.filter(Number.isFinite).length };
}

/**
 * The model's own history worked out here, for the days that have a full window inside the export (the first `days` of
 * it lack the older history Python had): the hot ones must equal the ones Python exported (scripts/ml-live-check.ts).
 */
export function hotOfHistory(g: NonNullable<LiveModel['gate']>): { checked: string[]; hot: string[] } {
  const checked: string[] = [], hot: string[] = [];
  const vals = g.history.map(([, v]) => v);
  g.history.forEach(([d, v], i) => {
    if (i < g.days) return;
    checked.push(d);
    if (typeof v === 'number' && hotAgainst(vals.slice(0, i), v, g).hot) hot.push(d);
  });
  return { checked, hot };
}
