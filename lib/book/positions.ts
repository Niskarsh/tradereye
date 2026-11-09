/* eslint-disable @typescript-eslint/no-explicit-any */
import { normalizeOrder, normalizeTrade } from '../live/orders';
import { groupFills } from '../live/grouping';
import { pendingPlan, superOrderRows } from '../copilot/pending';
import type { OrderSnapIn } from '../live/types';
import type { OpenPosition } from './situation';

/**
 * The positions open right now, with the stop and target resting at Dhan, straight from Dhan's trade and order books.
 * Read-only: unlike the Live tab's sync it never touches the sheets, so the chart can ask as often as it likes.
 */
export function openPositions(trades: any[], orders: any[], supers: any[]): OpenPosition[] {
  const rows = [...orders, ...superOrderRows(supers, new Set(orders.map((o: any) => String(o?.orderId ?? o?.orderNo ?? ''))), { legsAtCreate: true })];
  const snaps = rows.map(normalizeOrder).filter((x): x is OrderSnapIn => !!x);
  const fills = trades.map(normalizeTrade).filter((f): f is NonNullable<typeof f> => !!f && f.segment.endsWith('_EQ'));
  return groupFills(fills).filter((g) => g.status === 'OPEN' && g.netQty !== 0).map((g) => {
    const plan = pendingPlan(snaps, g.symbol, g.securityId, g.direction);
    return { symbol: g.symbol, securityId: g.securityId, direction: g.direction, qty: Math.abs(g.netQty), avgCost: Number(g.avgCost.toFixed(2)), entryTs: g.entryTs, stop: plan?.stop, target: plan?.target };
  });
}
