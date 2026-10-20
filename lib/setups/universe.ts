import type { Candles } from '../dhan';

/**
 * Which stocks the backtest looks at on each day: every NSE equity in his price range (₹250-340 at the previous
 * close), with a liquidity floor so the results could actually be traded (10-day average volume of 500,000 shares,
 * about ₹15 cr a day). Both are known before the open. Which of them were "in play" that day (unusually busy) is a
 * slice, not a filter (set by the job from the first 10 minutes).
 */

export interface ScreenerFilter { priceMin: number; priceMax: number; avgVolMin: number }
export const SCREENER: ScreenerFilter = { priceMin: 250, priceMax: 340, avgVolMin: 500_000 };

const IST = 19800_000;
const dateOf = (sec: number) => new Date(sec * 1000 + IST).toISOString().slice(0, 10);

/** Trading days in [from, to] on which the stock passed the screener (by the previous close and 10 prior sessions). */
export function screenerDays(daily: Candles, f: ScreenerFilter, from: string, to: string): string[] {
  const out: string[] = [];
  for (let i = 10; i < daily.t.length; i++) {
    const d = dateOf(daily.t[i]);
    if (d < from || d > to) continue;
    const pc = daily.c[i - 1];
    if (!(pc >= f.priceMin && pc <= f.priceMax)) continue;
    let v = 0;
    for (let j = i - 10; j < i; j++) v += daily.v[j];
    if (v / 10 > f.avgVolMin) out.push(d);
  }
  return out;
}

/** Calendar months of 1-minute history a set of days needs: each day's month and the ~5 weeks before it. */
export function monthsNeeded(days: string[]): string[] {
  const set = new Set<string>();
  for (const d of days) {
    // every month from 5 weeks before the day up to the day's own month
    const from = new Date(Date.parse(`${d}T00:00:00Z`) - 35 * 86400_000);
    let y = from.getUTCFullYear(), m = from.getUTCMonth() + 1;
    const end = d.slice(0, 7);
    for (;;) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      set.add(key);
      if (key >= end) break;
      if (++m > 12) { m = 1; y++; }
    }
  }
  return [...set].sort();
}

/** Symbols from NSE's Nifty 500 list (CSV with a "Symbol" column). */
export function parseIndexCsv(csv: string): string[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const i = head.indexOf('symbol');
  if (i < 0) return [];
  return [...new Set(lines.slice(1).map((l) => (l.split(',')[i] ?? '').trim().replace(/^"|"$/g, '').toUpperCase()).filter((s) => /^[A-Z0-9&-]{1,30}$/.test(s)))];
}
