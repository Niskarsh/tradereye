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
