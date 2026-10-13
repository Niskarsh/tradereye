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

test('partial WebSocket frames never overwrite good data (no side/status/price/time must not become SELL/blank/0)', () => {
  const known = new Map<string, TrackedOrder>();
  // REST says: a BUY stop (the protective stop of a short), trigger 290.3
  let r = applyOrderSnaps(known, [normalizeOrder(rest({ orderId: 'B1', transactionType: 'BUY', orderType: 'STOP_LOSS', tradingSymbol: 'FSL', triggerPrice: 290.3, price: 291 }))!], 'POLL', 0);
  r.updated.forEach((u) => known.set(u.orderId, u));
  // the frame the real feed produced: the order id, a new trigger, and almost nothing else
  r = applyOrderSnaps(known, snapsFromPayload({ Type: 'order_alert', Data: { OrderNo: 'B1', TriggerPrice: 289.9, LastUpdatedTime: '1980-01-01 00:00:00' } }), 'WS', 0);
  assert.equal(r.events.length, 1);
  assert.match(r.events[0].note, /TRIGGER 290.3→289.9/);
  const o = r.updated[0];
  assert.equal(o.side, 'BUY'); assert.equal(o.kind, 'SL'); assert.equal(o.symbol, 'FSL');
  assert.equal(o.status, 'PENDING'); assert.equal(o.price, 291); assert.equal(o.qty, 10);
  // unseen order + frame without a side: do not invent a record, the poll will create it
  r = applyOrderSnaps(known, snapsFromPayload({ Data: { OrderNo: 'NEW1', TriggerPrice: 5 } }), 'WS', 0);
  assert.equal(r.events.length, 0);
});

test('field names are matched loosely (camelCase / PascalCase / snake_case)', () => {
  const s = normalizeOrder({ orderNo: '7', txnType: 'B', status: 'Pending', symbol: 'ABC', orderType: 'SL', trigger_price: 12.5 })!;
  assert.equal(s.side, 'BUY'); assert.equal(s.status, 'PENDING'); assert.equal(s.symbol, 'ABC'); assert.equal(s.kind, 'SL'); assert.equal(s.triggerPrice, 12.5);
});

test('a short whose buy-stop was trailed by partial WS frames still reports its first stop and risk', () => {
  const fills: Fill[] = [
    { tradeId: 'a', orderId: 'E', symbol: 'FSL', securityId: '11', segment: 'NSE_EQ', side: 'SELL', qty: 83, price: 287.11, ts: IST('2026-10-13', '09:30:00'), time: '2026-10-13 09:30:00' },
    { tradeId: 'b', orderId: 'S', symbol: 'FSL', securityId: '11', segment: 'NSE_EQ', side: 'BUY', qty: 83, price: 290.5, ts: IST('2026-10-13', '09:44:28'), time: '2026-10-13 09:44:28' },
  ];
  const [g] = groupFills(fills);
  const known = new Map<string, TrackedOrder>();
  const apply = (snaps: any[], src: string) => { const r = applyOrderSnaps(known, snaps, src, IST('2026-10-13', '09:30:10')); r.updated.forEach((u) => known.set(u.orderId, u)); };
  apply([normalizeOrder(rest({ orderId: 'STOP', transactionType: 'BUY', orderType: 'STOP_LOSS', tradingSymbol: 'FSL', triggerPrice: 290.3, quantity: 83, createTime: '2026-10-13 09:30:05', updateTime: '2026-10-13 09:30:05' }))!], 'POLL');
  apply(snapsFromPayload({ Data: { OrderNo: 'STOP', TriggerPrice: 289.9 } }), 'WS');
  apply(snapsFromPayload({ Data: { OrderNo: 'STOP', TriggerPrice: 289.2 } }), 'WS');
  const m = analyzeTrade(g, [...known.values()]);
  assert.equal(m.initialStop, 290.3);
  assert.equal(m.lastStop, 289.2);
  assert.equal(m.stopMoves, 2);
  assert.equal(m.riskInr, Number(((290.3 - 287.11) * 83).toFixed(2)));
});
