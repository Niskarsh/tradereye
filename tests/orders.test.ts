import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrade, applyOrderSnaps, normalizeOrder, snapsFromPayload } from '../lib/live/orders';
import { groupFills } from '../lib/live/grouping';
import type { Fill, TrackedOrder } from '../lib/live/types';
import { IST } from './helpers';

const rest = (o: Record<string, unknown>) => ({
  orderId: '1', orderStatus: 'PENDING', transactionType: 'SELL', orderType: 'STOP_LOSS', tradingSymbol: 'ABC', securityId: '11',
  exchangeSegment: 'NSE_EQ', productType: 'INTRADAY', triggerPrice: 99, price: 0, quantity: 10, filledQty: 0,
  createTime: '2026-10-12 09:21:00', updateTime: '2026-10-12 09:21:00', ...o,
});

test('normalizes REST, WebSocket and postback shapes to the same snapshot', () => {
  const a = normalizeOrder(rest({}))!;
  const ws = normalizeOrder({ Exchange: 'NSE', Segment: 'E', Source: 'W', SecurityId: '11', OrderNo: '1', TxnType: 'S', OrderType: 'SL', Status: 'Pending', Symbol: 'ABC', Product: 'I', TriggerPrice: 99, Price: 0, Quantity: 10, TradedQty: 0, OrderDateTime: '2026-10-12 09:21:00', LastUpdatedTime: '2026-10-12 09:21:00' })!;
  for (const k of ['orderId', 'status', 'side', 'kind', 'symbol', 'segment', 'product', 'triggerPrice', 'qty']) assert.deepEqual((ws as any)[k], (a as any)[k], k);
  assert.equal(snapsFromPayload({ Type: 'order_alert', Data: { OrderNo: '9', TxnType: 'B', OrderType: 'LMT', Status: 'TRADED' } })[0].orderId, '9');
  assert.equal(normalizeOrder({ foo: 1 }), null);
});

test('diffing: new order, stop move, repeat (no-op) and stale snapshot', () => {
  const known = new Map<string, TrackedOrder>();
  let r = applyOrderSnaps(known, [normalizeOrder(rest({}))!], 'POLL', 0);
  assert.equal(r.events.length, 1); r.updated.forEach((u) => known.set(u.orderId, u));
  r = applyOrderSnaps(known, [normalizeOrder(rest({}))!], 'POLL', 0);
  assert.equal(r.events.length, 0);
  r = applyOrderSnaps(known, [normalizeOrder(rest({ triggerPrice: 99.5, updateTime: '2026-10-12 09:25:00' }))!], 'WS', 0);
  assert.equal(r.events.length, 1); assert.match(r.events[0].note, /TRIGGER 99→99.5/); r.updated.forEach((u) => known.set(u.orderId, u));
  r = applyOrderSnaps(known, [normalizeOrder(rest({ triggerPrice: 90, updateTime: '2026-10-12 09:22:00' }))!], 'POLL', 0);
  assert.equal(r.events.length, 0);
  assert.equal(known.get('1')!.history.length, 2);
});

test('trade analysis: initial stop, risk, moved stop, target, and exit type', () => {
  const fills: Fill[] = [
    { tradeId: 'a', orderId: 'E', symbol: 'ABC', securityId: '11', segment: 'NSE_EQ', side: 'BUY', qty: 10, price: 100, ts: IST('2026-10-12', '09:20:00'), time: '2026-10-12 09:20:00' },
    { tradeId: 'b', orderId: 'S', symbol: 'ABC', securityId: '11', segment: 'NSE_EQ', side: 'SELL', qty: 10, price: 99.5, ts: IST('2026-10-12', '09:40:00'), time: '2026-10-12 09:40:00' },
  ];
  const [g] = groupFills(fills);
  const known = new Map<string, TrackedOrder>();
  const push = (o: any) => { const r = applyOrderSnaps(known, [normalizeOrder(o)!], 'POLL', 0); r.updated.forEach((u) => known.set(u.orderId, u)); };
  push(rest({ orderId: 'S', triggerPrice: 99, createTime: '2026-10-12 09:21:00', updateTime: '2026-10-12 09:21:00' }));
  push(rest({ orderId: 'S', triggerPrice: 99.5, updateTime: '2026-10-12 09:30:00', createTime: '2026-10-12 09:21:00' }));
  push(rest({ orderId: 'T', orderType: 'LIMIT', triggerPrice: 0, price: 104, createTime: '2026-10-12 09:22:00', updateTime: '2026-10-12 09:22:00' }));
  push(rest({ orderId: 'S', orderStatus: 'TRADED', triggerPrice: 99.5, filledQty: 10, updateTime: '2026-10-12 09:40:00', createTime: '2026-10-12 09:21:00' }));
  const m = analyzeTrade(g, [...known.values()]);
  assert.equal(m.initialStop, 99); assert.equal(m.lastStop, 99.5); assert.equal(m.stopMoves, 1);
  assert.equal(m.initialStopDist, 1); assert.equal(m.riskInr, 10);
  assert.equal(m.tpLast, 104);
});

test('trade analysis with no order history is empty, not wrong', () => {
  const [g] = groupFills([
    { tradeId: 'a', orderId: 'E', symbol: 'ABC', securityId: '11', segment: 'NSE_EQ', side: 'BUY', qty: 10, price: 100, ts: IST('2026-10-12', '09:20:00'), time: '2026-10-12 09:20:00' },
  ]);
  const m = analyzeTrade(g, []);
  assert.equal(m.initialStop, undefined); assert.equal(m.exitType, 'UNKNOWN');
});
