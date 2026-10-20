import type { Candles } from '../dhan';
import { deliveryCharges, sizeFor } from './costs';
import { EXIT_KEYS, type Outcome, type Signal, type TargetResult } from './cases';
import type { ScreenerFilter } from './universe';
import type { Params } from './engine';

/**
 * S1, the 5-day reversal (delivery): the classic short-term reversal that institutions trade at a multi-day horizon.
 * At a day's close, a stock in his price range that fell 7%+ over the last 5 sessions and did 4%+ worse than Nifty 500
 * is bought; it is sold at the close 5 sessions later. Stop 2x the 14-day ATR (checked on each day's low; a gap
 * below the stop exits at that day's open). Long only (a delivery short is not possible). One trade at a time per
 * stock. Delivery charges at his risk size.
 */

const IST = 19800_000;
const dateOf = (sec: number) => new Date(sec * 1000 + IST).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;

export const HOLD_DAYS = 5;

export function runSwing(symbol: string, daily: Candles, niftyClose: Map<string, number>, from: string, to: string, f: ScreenerFilter, P: Pick<Params, 'riskInr'>): Signal[] {
  const n = daily.c.length;
  const dates = daily.t.map(dateOf);
  const out: Signal[] = [];
  let busyUntil = -1;
  // Wilder ATR(14) on daily candles
  const atr: number[] = [];
  for (let i = 0; i < n; i++) {
    const tr = i ? Math.max(daily.h[i] - daily.l[i], Math.abs(daily.h[i] - daily.c[i - 1]), Math.abs(daily.l[i] - daily.c[i - 1])) : daily.h[i] - daily.l[i];
    atr.push(i ? (13 / 14) * atr[i - 1] + tr / 14 : tr);
  }
  for (let i = 15; i < n - HOLD_DAYS; i++) {
    const d = dates[i];
    if (d < from || d > to || i <= busyUntil) continue;
    const px = daily.c[i];
    if (!(px >= f.priceMin && px <= f.priceMax)) continue;
    let v = 0;
    for (let j = i - 9; j <= i; j++) v += daily.v[j];
    if (v / 10 < f.avgVolMin) continue;
    const ret5 = (px / daily.c[i - 5] - 1) * 100;
    if (Math.abs(daily.c[i] / daily.c[i - 1] - 1) > 0.25) continue; // a split / bonus, not a move
    const n0 = niftyClose.get(dates[i - 5]), n1 = niftyClose.get(d);
    if (n0 === undefined || n1 === undefined) continue;
    const rel = ret5 - (n1 / n0 - 1) * 100;
    if (!(ret5 <= -7 && rel <= -4)) continue;
    const a = atr[i];
    const stop = px - 2 * a, dist = px - stop;
    if (!(dist > 0)) continue;
    busyUntil = i + HOLD_DAYS;
    const sig: Signal = {
      case: 'S1', symbol, date: d, slot: 370, dir: 1, entry: r2(px), stop: r2(stop), target: r2(px + 2 * dist), stopAtr: 2, atr: r2(a), capped: true, stopType: 'ATR2',
      time: '13:00-15:00', nFirst5: 'FLAT', nDay: 'EARLY', nRecent: 'EARLY', rvol: 'NORMAL', openBusy: false,
      stretch: Math.round(-ret5), emaInWay: false, gapPct: 0, testNo: 0, tests: [], level: '', pullbackNo: 0, with: [],
    };
    sig.out = outcome(daily, i, px, stop, dist, P.riskInr);
    out.push(sig);
  }
  return out;
}

function outcome(daily: Candles, i: number, entry: number, stop: number, dist: number, riskInr: number): Outcome {
  const lv = { T1: entry + dist, T15: entry + 1.5 * dist, TS: entry + 2 * dist };
  const res: Partial<Record<'T1' | 'T15' | 'TS' | 'TC', { exit: number; day: number; target?: boolean }>> = {};
  let mfe = 0, mae = 0;
  for (let k = 1; k <= HOLD_DAYS; k++) {
    const j = i + k;
    const o = daily.o[j], h = daily.h[j], l = daily.l[j];
    if (l <= stop) {
      const exit = o < stop ? o : stop; // a gap below the stop fills at the open
      for (const key of ['T1', 'T15', 'TS', 'TC'] as const) if (!res[key]) res[key] = { exit, day: k };
      mae = Math.max(mae, (entry - exit) / dist);
      break;
    }
    mfe = Math.max(mfe, (h - entry) / dist); mae = Math.max(mae, (entry - l) / dist);
    for (const key of ['T1', 'T15', 'TS'] as const) if (!res[key] && h >= lv[key]) res[key] = { exit: Math.max(lv[key], o), day: k, target: true };
  }
  const last = daily.c[i + HOLD_DAYS];
  const qty = sizeFor(riskInr, dist);
  const one = (key: 'T1' | 'T15' | 'TS' | 'TC'): TargetResult => {
    const x = res[key] ?? { exit: last, day: HOLD_DAYS };
    const r = (x.exit - entry) / dist;
    const net = r2(r - deliveryCharges(qty, entry, x.exit) / (qty * dist));
    return { hit: key === 'TC' ? net > 0 : !!x.target, r: r2(r), net, min: x.day * 375 };
  };
  const tc = one('TC');
  const out = { T1: one('T1'), T15: one('T15'), TS: one('TS'), TC: tc, mfe: r2(mfe), mae: r2(Math.min(mae, 3)), costR: r2(deliveryCharges(qty, entry, entry) / (qty * dist)) } as Outcome;
  for (const k of EXIT_KEYS) out[k] = { ...tc }; // no intraday exits on a 5-day hold: the same as holding
  return out;
}
