import { tradeMarks, type TradeMark } from '../book/marks';
import type { Curve, CurveMode, PnlFill, PnlPosition } from './curve';

/** One row of the positions card: size, prices, the orders, slippage and the result. All from real fills. */

export interface Slippage { kind: 'STOP' | 'TARGET'; ref: number; fill: number; perShare: number; inr: number }
export interface PositionCard {
  symbol: string; direction: 'LONG' | 'SHORT'; qty: number; openQty: number;
  avgBuy?: number; avgSell?: number;
  orders: TradeMark[];
  slippage?: Slippage;
  gross: number; net: number; charges: number;
}

const IST = 19800_000;
const toFills = (date: string, fills: PnlFill[]) => fills.map((f) => ({ time: new Date(f.t + IST).toISOString().slice(11, 19), side: f.side, qty: f.qty, price: f.price }));
const avg = (fills: PnlFill[], side: string) => {
  const q = fills.filter((f) => f.side === side);
  const n = q.reduce((s, f) => s + f.qty, 0);
  return n ? q.reduce((s, f) => s + f.qty * f.price, 0) / n : undefined;
};

/**
 * Slippage needs a price the order was aimed at. A stop exit is measured against the stop's trigger, a target exit
 * against the limit. A market order has no such price, so nothing is shown for it instead of a made-up number.
 * perShare and inr are positive when the fill was worse than the order's price.
 */
export function exitSlippage(p: PnlPosition, orders: TradeMark[], direction: 'LONG' | 'SHORT'): Slippage | undefined {
  const type = (p.exitType ?? '').toUpperCase();
  const ref = type === 'STOP' ? p.lastStop : type === 'TARGET' ? p.target : undefined;
  const exit = [...orders].reverse().find((o) => o.role === 'EXIT');
  if (!ref || !exit) return undefined;
  const perShare = Math.round((direction === 'LONG' ? ref - exit.price : exit.price - ref) * 100) / 100;
  return { kind: type as 'STOP' | 'TARGET', ref, fill: exit.price, perShare, inr: Math.round(perShare * exit.qty * 100) / 100 };
}

export function positionCards(date: string, positions: PnlPosition[], curve: Curve): PositionCard[] {
  return positions.map((p) => {
    const fills = [...p.fills].sort((a, b) => a.t - b.t);
    const orders = tradeMarks(date, p.direction ?? '', toFills(date, fills));
    const direction: 'LONG' | 'SHORT' = /short/i.test(p.direction ?? '') ? 'SHORT' : /long/i.test(p.direction ?? '') ? 'LONG' : fills[0]?.side === 'SELL' ? 'SHORT' : 'LONG';
    const line = curve.positions.find((l) => l.symbol === p.symbol);
    const qty = fills.filter((f) => f.side === (direction === 'LONG' ? 'BUY' : 'SELL')).reduce((s, f) => s + f.qty, 0);
    return {
      symbol: p.symbol, direction, qty, openQty: line?.openQty ?? 0,
      avgBuy: avg(fills, 'BUY'), avgSell: avg(fills, 'SELL'), orders, slippage: exitSlippage(p, orders, direction),
      gross: line?.gross.at(-1) ?? 0, net: line?.net.at(-1) ?? 0, charges: p.charges,
    };
  });
}

/** What Algo Live's order would have done untouched, against what happened (from Me vs Algo). */
export interface AlgoCompare { symbol: string; planInr: number; myInr: number; steppedIn: boolean }

/** How one position felt while it was open: the best and worst it showed, and for how long. All from the curve. */
export interface PositionStats { best: number; worst: number; heldMin: number; line: number[] }
export function positionStats(card: PositionCard, curve: Curve, mode: CurveMode): PositionStats {
  const all = curve.positions.find((l) => l.symbol === card.symbol)?.[mode] ?? [];
  const ts = card.orders.map((o) => o.t), first = Math.min(...ts), last = card.openQty ? curve.times.at(-1) ?? first : Math.max(...ts);
  const minute = (t: number) => Math.floor(t / 60_000) * 60_000;
  const from = curve.times.indexOf(minute(first)), to = curve.times.indexOf(minute(last));
  const line = ts.length && from >= 0 && to >= from ? all.slice(from, to + 1) : all;
  return { best: line.length ? Math.max(...line) : 0, worst: line.length ? Math.min(...line) : 0, heldMin: ts.length ? Math.round((last - first) / 60_000) : 0, line };
}

const rs = (n: number) => `₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;
const money = (n: number) => `${n < 0 ? '-' : '+'}${rs(n)}`;

/** The slide's headline: the most striking true thing about the day. Every number comes from the curve or Me vs Algo. */
export function dayHook(curve: Curve, mode: CurveMode, algo: AlgoCompare[] = []): string {
  const line = curve.overall[mode], end = line.at(-1) ?? 0;
  const peak = Math.max(0, ...line), low = Math.min(0, ...line);
  const stepped = algo.filter((a) => a.steppedIn);
  if (stepped.length) {
    const mine = stepped.reduce((s, a) => s + a.myInr, 0), plan = stepped.reduce((s, a) => s + a.planInr, 0);
    if (Math.abs(mine - plan) >= 50) return `The algo's plan: ${money(plan)}. What I did: ${money(mine)}.`;
  }
  if (low <= -100 && end > 0) return `Down ${rs(low)} at the worst. Finished ${money(end)}.`;
  if (peak >= 100 && peak - end >= peak * 0.3) return `Was up ${rs(peak)}. Ended ${money(end)}.`;
  const gross = curve.overall.gross.at(-1) ?? 0;
  if (gross > 0 && curve.charges >= gross * 0.25) return `Made ${rs(gross)}. Charges took ${rs(curve.charges)}.`;
  if (end > 0 && low > -30) return `${money(end)}. Never went red.`;
  if (end < 0) return `Lost ${rs(end)}. Logged anyway.`;
  return `${money(end)} on the day.`;
}

export const finalOf = (curve: Curve, mode: CurveMode) => curve.overall[mode].at(-1) ?? 0;
