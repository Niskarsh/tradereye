import type { Direction, OrderSnapIn } from '../live/types';

/**
 * His intention, read from the orders he has already placed in Dhan for this stock (free trading API):
 * a pending entry, a stop and a target. Works for bracket orders (legs 1/2/3) and for separate orders.
 */

export const OPEN_ORDER_STATUSES = new Set(['PENDING', 'TRANSIT', 'PART_TRADED', 'TRIGGER_PENDING', 'OPEN', 'MODIFIED', 'CONFIRM']);

export interface PendingPlan {
  direction?: Direction;
  entry?: number;        // pending entry price (limit price, or trigger for a stop-entry); undefined = market / none
  /** the entry is a stop order: it fills only when price breaks through it (buy-stop above / sell-stop below) */
  entryIsStop?: boolean;
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
    return check({ direction, entry: leg1.kind === 'MARKET' ? undefined : actPrice(leg1), entryIsStop: leg1.kind === 'SL' || leg1.kind === 'SLM', stop: leg2 ? actPrice(leg2) : undefined, target: leg3 ? actPrice(leg3) : undefined, source: 'your bracket order' });
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
    entryIsStop: entryOrder ? entryOrder.kind === 'SL' || entryOrder.kind === 'SLM' : undefined,
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

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Super orders (GET /super/orders) as plain order-book rows: the entry leg (leg 1) plus its stop-loss leg (2) and
 * target leg (3), which carry their price in `price` and no symbol of their own. Skips legs already in the order book.
 */
const realTs = (v: unknown) => (typeof v === 'string' && v && !/^(1980|0001|1970)/.test(v) ? v : undefined);
const legDate = (so: any) => { const t = realTs(so.exchangeTime) ?? realTs(so.createTime); return t ? { updateTime: t, createTime: t } : {}; };

export function superOrderRows(supers: any[], have: Set<string>, opts: { legsAtCreate?: boolean } = {}): any[] {
  const out: any[] = [];
  for (const so of Array.isArray(supers) ? supers : []) {
    if (!so?.orderId) continue;
    const base = { tradingSymbol: so.tradingSymbol, securityId: so.securityId, exchangeSegment: so.exchangeSegment, productType: so.productType, createTime: so.createTime, updateTime: so.updateTime };
    if (!have.has(String(so.orderId))) out.push({ ...so, legName: 'ENTRY_LEG' });
    for (const leg of Array.isArray(so.legDetails) ? so.legDetails : []) {
      const name = String(leg?.legName ?? '').toUpperCase();
      if (name !== 'STOP_LOSS_LEG' && name !== 'TARGET_LEG') continue;
      const id = leg.orderId && String(leg.orderId) !== String(so.orderId) ? String(leg.orderId) : `${so.orderId}-${name === 'TARGET_LEG' ? 'T' : 'S'}`;
      if (have.has(id)) continue;
      const px = Number(leg.price);
      out.push({
        ...base, orderId: id, legName: name, transactionType: leg.transactionType ?? (so.transactionType === 'BUY' ? 'SELL' : 'BUY'),
        orderType: name === 'TARGET_LEG' ? 'LIMIT' : 'STOP_LOSS_MARKET', price: px, triggerPrice: name === 'TARGET_LEG' ? 0 : px,
        orderStatus: leg.orderStatus ?? 'PENDING', quantity: leg.totalQuatity ?? leg.totalQuantity ?? leg.remainingQuantity ?? so.quantity, filledQty: 0,
        // the legs go live with the entry: dated when it filled (or was placed), so a trade read after it closed still
        // finds its stop and target inside its window
        ...(opts.legsAtCreate ? legDate(so) : {}),
      });
    }
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
