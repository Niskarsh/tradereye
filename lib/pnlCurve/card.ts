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

export const finalOf = (curve: Curve, mode: CurveMode) => curve.overall[mode].at(-1) ?? 0;
