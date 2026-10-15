import type { Direction, OrderSnapIn } from '../live/types';

/**
 * His intention, read from the orders he has already placed in Dhan for this stock (free trading API):
 * a pending entry, a stop and a target. Works for bracket orders (legs 1/2/3) and for separate orders.
 */

export const OPEN_ORDER_STATUSES = new Set(['PENDING', 'TRANSIT', 'PART_TRADED', 'TRIGGER_PENDING', 'OPEN', 'MODIFIED', 'CONFIRM']);

export interface PendingPlan {
  direction?: Direction;
  entry?: number;        // pending entry price (limit price, or trigger for a stop-entry); undefined = market / none
  stop?: number;
  target?: number;
  source: string;        // short description for the card
}

const isOpen = (o: OrderSnapIn) => OPEN_ORDER_STATUSES.has(String(o.status ?? '').toUpperCase());
const pos = (n: number | undefined) => (n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined);
/** The price an order acts at: the trigger for stop orders, else the limit price. */
const actPrice = (o: OrderSnapIn) => (o.kind === 'SL' || o.kind === 'SLM' ? pos(o.triggerPrice) ?? pos(o.price) : pos(o.price) ?? pos(o.triggerPrice));
const latest = (a: OrderSnapIn[]) => [...a].sort((x, y) => String(x.createTime ?? '').localeCompare(String(y.createTime ?? ''))).at(-1);

export function pendingPlan(orders: OrderSnapIn[], symbol: string, securityId: string, held?: Direction): PendingPlan | undefined {
  const mine = orders.filter((o) => (o.securityId === securityId || String(o.symbol ?? '').toUpperCase() === symbol.toUpperCase())
    && isOpen(o) && (o.side === 'BUY' || o.side === 'SELL'));
  if (!mine.length) return undefined;

  // already in the position: the orders on the exit side are his stop (trigger) and target (plain limit)
  if (held) {
    const exitSide = held === 'LONG' ? 'SELL' : 'BUY';
    const exits = mine.filter((o) => o.side === exitSide);
    const stop = latest(exits.filter((o) => o.legNo === 2 || pos(o.triggerPrice)));
    const target = latest(exits.filter((o) => o.legNo === 3 || (o.kind === 'LIMIT' && !pos(o.triggerPrice))));
    const plan: PendingPlan = { direction: held, stop: stop ? actPrice(stop) : undefined, target: target ? actPrice(target) : undefined, source: 'your exit orders' };
    return plan.stop || plan.target ? check(plan) : undefined;
  }

  // bracket order: legs 1 / 2 / 3
  const leg1 = mine.find((o) => o.legNo === 1);
  if (leg1) {
    const direction: Direction = leg1.side === 'BUY' ? 'LONG' : 'SHORT';
    const leg2 = mine.find((o) => o.legNo === 2), leg3 = mine.find((o) => o.legNo === 3);
    return check({ direction, entry: leg1.kind === 'MARKET' ? undefined : actPrice(leg1), stop: leg2 ? actPrice(leg2) : undefined, target: leg3 ? actPrice(leg3) : undefined, source: 'your bracket order' });
  }

  // separate orders: the side that was placed first is the entry; on the other side a trigger order is the stop
  // and a plain limit is the target
  const first = [...mine].sort((x, y) => String(x.createTime ?? '').localeCompare(String(y.createTime ?? '')))[0];
  const entrySide = first.side!;
  const direction: Direction = entrySide === 'BUY' ? 'LONG' : 'SHORT';
  const entryOrder = latest(mine.filter((o) => o.side === entrySide));
  const exits = mine.filter((o) => o.side !== entrySide);
  const stop = latest(exits.filter((o) => pos(o.triggerPrice)));
  const target = latest(exits.filter((o) => o.kind === 'LIMIT' && !pos(o.triggerPrice)));
  return check({
    direction, entry: entryOrder && entryOrder.kind !== 'MARKET' ? actPrice(entryOrder) : undefined,
    stop: stop ? actPrice(stop) : undefined, target: target ? actPrice(target) : undefined, source: 'your pending orders',
  });
}

/** Drops a stop or target on the wrong side of the entry (they would not be a stop or a target for this trade). */
function check(p: PendingPlan): PendingPlan {
  const sign = p.direction === 'SHORT' ? -1 : 1;
  const ref = p.entry;
  if (ref !== undefined) {
    if (p.stop !== undefined && (p.stop - ref) * sign >= 0) p.stop = undefined;
    if (p.target !== undefined && (p.target - ref) * sign <= 0) p.target = undefined;
  }
  return p;
}
