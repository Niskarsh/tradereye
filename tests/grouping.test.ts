import test from 'node:test';
import assert from 'node:assert/strict';
import { groupFills } from '../lib/live/grouping';
import { computePnl } from '../lib/live/pnl';
import type { Fill } from '../lib/live/types';
import { IST } from './helpers';

let n = 0;
const fill = (symbol: string, side: 'BUY' | 'SELL', qty: number, price: number, time: string, date = '2026-10-12'): Fill => ({
  tradeId: `T${++n}`, orderId: `O${n}`, symbol, securityId: '1', segment: 'NSE_EQ', side, qty, price,
  ts: IST(date, time), time: `${date} ${time}`,
});

test('long round trip is one closed trade with direction from first fill', () => {
  const [g, ...rest] = groupFills([fill('ABC', 'BUY', 10, 100, '09:20:00'), fill('ABC', 'SELL', 10, 102, '09:25:00')]);
  assert.equal(rest.length, 0);
  assert.equal(g.direction, 'LONG'); assert.equal(g.status, 'CLOSED'); assert.equal(g.realizedGross, 20);
  assert.equal(computePnl(g).grossPnL, 20);
});

test('short trade, with an add and a partial exit', () => {
  const gs = groupFills([
    fill('XYZ', 'SELL', 10, 200, '09:30:00'), fill('XYZ', 'SELL', 10, 202, '09:31:00'),
    fill('XYZ', 'BUY', 5, 198, '09:40:00'), fill('XYZ', 'BUY', 15, 199, '09:45:00'),
  ]);
  assert.equal(gs.length, 1);
  const g = gs[0];
  assert.equal(g.direction, 'SHORT'); assert.equal(g.adds, 1); assert.equal(g.peakQty, 20); assert.equal(g.status, 'CLOSED');
  assert.equal(g.avgEntry, 201);
});

test('a position still open stays OPEN and reports the quantity left', () => {
  const [g] = groupFills([fill('OPN', 'BUY', 10, 50, '10:00:00'), fill('OPN', 'SELL', 4, 51, '10:05:00')]);
  assert.equal(g.status, 'OPEN'); assert.equal(g.netQty, 6); assert.equal(g.realizedGross, 4);
});

test('a flipping fill is split into two trades with stable part ids', () => {
  const gs = groupFills([fill('FLP', 'BUY', 10, 100, '09:20:00'), fill('FLP', 'SELL', 15, 101, '09:30:00')]);
  assert.equal(gs.length, 2);
  assert.equal(gs[0].status, 'CLOSED'); assert.equal(gs[1].direction, 'SHORT'); assert.equal(gs[1].netQty, -5);
  assert.ok(gs[0].parts[1].partId.endsWith('~1') && gs[1].parts[0].partId.endsWith('~2'));
});

test('same symbol traded twice in a day gives two trades; symbols are independent', () => {
  const gs = groupFills([
    fill('AAA', 'BUY', 5, 10, '09:20:00'), fill('BBB', 'SELL', 5, 20, '09:21:00'),
    fill('AAA', 'SELL', 5, 11, '09:22:00'), fill('BBB', 'BUY', 5, 19, '09:23:00'),
    fill('AAA', 'BUY', 5, 12, '10:00:00'), fill('AAA', 'SELL', 5, 13, '10:01:00'),
  ]);
  assert.equal(gs.length, 3);
  assert.equal(gs.filter((g) => g.symbol === 'AAA').length, 2);
});

test('adds count new entry ORDERS: one order split into several fills is not an add', async () => {
  const { groupFills } = await import('../lib/live/grouping');
  const f = (tradeId: string, orderId: string, side: 'BUY' | 'SELL', qty: number, price: number, ts: number) => ({ tradeId, orderId, symbol: 'X', securityId: '1', segment: 'NSE_EQ', side, qty, price, ts, time: '' });
  const t0 = Date.UTC(2026, 9, 15, 5, 10, 0);
  const groups = groupFills([
    f('a', 'O1', 'BUY', 30, 100, t0), f('b', 'O1', 'BUY', 30, 100.1, t0), // split
    f('c', 'O2', 'BUY', 20, 99, t0 + 600_000),                            // real add
    f('d', 'O3', 'SELL', 80, 101, t0 + 900_000),
  ]);
  assert.equal(groups[0].adds, 1);
});
