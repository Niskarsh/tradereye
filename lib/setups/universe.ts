import type { Candles } from '../dhan';

/**
 * Which stocks the backtest looks at on each day: the ones his TradingView screener would have shown that morning.
 * Price and 10-day average volume are rebuilt exactly from daily candles (both are known before the open: the
 * previous close and the 10 sessions before). His market-cap floor (₹10,000 cr) is covered by starting from the
 * Nifty 500 list, which uses today's members (a stock that left the index in the last two years is missed).
 */

export interface ScreenerFilter { priceMin: number; priceMax: number; avgVolMin: number }
export const SCREENER: ScreenerFilter = { priceMin: 250, priceMax: 340, avgVolMin: 3_000_000 };

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
