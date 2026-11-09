/* eslint-disable @typescript-eslint/no-explicit-any */
import { analyzeTrade, applyOrderSnaps, normalizeOrder, normalizeTrade } from '../live/orders';
import { groupFills } from '../live/grouping';
import { pendingPlan, superOrderRows } from '../copilot/pending';
import type { OrderSnapIn, TrackedOrder } from '../live/types';
import type { OpenPosition } from './situation';

/** an order in one of these states is no longer protecting the position */
const DONE = /^(CANCELLED|CANCELED|REJECTED|EXPIRED|TRADED|FAILED)$/;

/**
 * The positions open right now, with the stop and target resting at Dhan.
 * The current orders are read two ways: what is plainly pending (pendingPlan), and the same reading the Live tab uses
 * (analyzeTrade), which also recognises stops and targets by their price and side. `known` is the Live tab's saved
 * order log, for a leg Dhan has stopped listing; the route reads it about once a minute (each read is a sheet call).
 */
export function openPositions(trades: any[], orders: any[], supers: any[], known: Map<string, TrackedOrder> = new Map()): OpenPosition[] {
  const rows = [...orders, ...superOrderRows(supers, new Set(orders.map((o: any) => String(o?.orderId ?? o?.orderNo ?? ''))), { legsAtCreate: true })];
  const snaps = rows.map(normalizeOrder).filter((x): x is OrderSnapIn => !!x);
  const merged = new Map(known);
  for (const u of applyOrderSnaps(known, snaps, 'POLL', Date.now()).updated) merged.set(u.orderId, u);
  const active = [...merged.values()].filter((o) => !DONE.test(o.status));
  const fills = trades.map(normalizeTrade).filter((f): f is NonNullable<typeof f> => !!f && f.segment.endsWith('_EQ'));
  return groupFills(fills).filter((g) => g.status === 'OPEN' && g.netQty !== 0).map((g) => {
    const plan = pendingPlan(snaps, g.symbol, g.securityId, g.direction);
    const meta = analyzeTrade(g, active);
    return {
      symbol: g.symbol, securityId: g.securityId, direction: g.direction, qty: Math.abs(g.netQty), avgCost: Number(g.avgCost.toFixed(2)), entryTs: g.entryTs,
      stop: plan?.stop ?? meta.lastStop, target: plan?.target ?? meta.tpLast,
      realized: g.realizedGross, buyVal: g.buyVal, sellVal: g.sellVal,
    };
  });
}
