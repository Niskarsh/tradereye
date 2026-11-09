import { roundTripCharges } from '../setups/costs';
import { onTick, TICK } from '../study/mine';
import { liqBand } from '../ml/grid';
import type { OrderRec } from './engine';

/**
 * The prices for protecting an Algo Live short by hand. When price reaches `at90` (90% of the way to the target), the
 * stop can go to `moveStop`: the price where the trade still pays Dhan's charges and the usual stop slippage for a stock
 * of this liquidity. This is about not going red after charges, not about locking profit (lib/ml/profitLock.ts tested it).
 */
export interface ProtectLevels { at90: number; moveStop: number }

export function protectLevels(o: Pick<OrderRec, 'price' | 'avgPrice' | 'target' | 'qty'>, avgVol = 0): ProtectLevels {
  const entry = o.avgPrice || o.price;
  const charges = o.qty > 0 ? roundTripCharges(o.qty, entry, entry, -1) / o.qty : 0;
  const slip = Math.max(TICK, (liqBand(avgVol).stopPct / 100) * entry);
  return { at90: onTick(o.price - 0.9 * (o.price - o.target), -1), moveStop: onTick(entry - charges - slip, -1) };
}

/**
 * A trade's plan in rupees, before and after Dhan's charges, for either direction. "Risk" is what the stop costs if it
 * fills exactly at its price; charges are worked out at that exit price. Slippage is not in the risk or reward (it is
 * only in `moveStop`, the same way as protectLevels). `avgVol` unknown = the thinnest band: the safest stop.
 */
export interface TradePlan {
  qty: number; entry: number; stop?: number; target?: number;
  risk?: number; riskNet?: number; reward?: number; rewardNet?: number; rr?: number; rrNet?: number;
  at90?: number; moveStop: number;
}

export function tradePlan(p: { dir: 1 | -1; entry: number; qty: number; stop?: number; target?: number; avgVol?: number }): TradePlan {
  const { dir, entry, qty, stop, target } = p;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const slip = Math.max(TICK, (liqBand(p.avgVol ?? 0).stopPct / 100) * entry);
  const perShare = roundTripCharges(qty, entry, entry, dir) / qty;
  // rounded towards the safer side: a long's stop up, a short's stop down; the 90% level further along for both
  const plan: TradePlan = { qty, entry, stop, target, moveStop: onTick(entry + dir * (perShare + slip), dir) };
  if (stop !== undefined && (entry - stop) * dir > 0) {
    plan.risk = r2((entry - stop) * dir * qty);
    plan.riskNet = r2(plan.risk + roundTripCharges(qty, entry, stop, dir));
  }
  if (target !== undefined && (target - entry) * dir > 0) {
    plan.reward = r2((target - entry) * dir * qty);
    plan.rewardNet = r2(plan.reward - roundTripCharges(qty, entry, target, dir));
    plan.at90 = onTick(entry + 0.9 * (target - entry), dir);
    if (plan.risk) { plan.rr = r2(plan.reward / plan.risk); plan.rrNet = r2(plan.rewardNet / plan.riskNet!); }
  }
  return plan;
}
