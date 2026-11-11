/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../lib/live/sync';
import { summarizeDay } from '../lib/live/daySummary';
import { MONTHLY_BASE } from '../lib/live/schema';
import { FakeSheets, IST } from './helpers';

// The Fetch Today's Trades page is one press of the Live engine: fetch, pair, price after charges, save. These pin that
// the press pairs a whole day without any ticking, saves each completed trade once, and says so.
const T = '2026-10-12';
const fill = (id: string, side: 'BUY' | 'SELL', qty: number, price: number, time: string, symbol: string, orderId = 'O' + id) => ({
  exchangeTradeId: id, orderId, tradingSymbol: symbol, securityId: symbol === 'ABC' ? '11' : '22', exchangeSegment: 'NSE_EQ',
  transactionType: side, tradedQuantity: qty, tradedPrice: price, createTime: `${T} ${time}`,
});
const order = (o: any) => ({
  orderStatus: 'PENDING', orderType: 'STOP_LOSS', exchangeSegment: 'NSE_EQ', productType: 'INTRADAY', price: 0, filledQty: 0,
  createTime: `${T} 09:41:00`, updateTime: `${T} 09:41:00`, ...o,
});

function setup(initial?: (f: FakeSheets) => void) {
  const f = new FakeSheets();
  initial?.(f);
  const dhan = { o: [] as any[], t: [] as any[], p: [] as any[], orders: async () => dhan.o, trades: async () => dhan.t, positions: async () => dhan.p };
  const run = () => runSync({ dhan, sheets: f.client(), now: () => IST(T, '15:40:00') });
  return { f, dhan, run };
}

// a short in ABC stopped out in two fills, a long in XYZ with an add that hit its target, and an open long in ABC
const day = [
  fill('1', 'SELL', 10, 300, '09:40:00', 'ABC'),
  fill('2', 'BUY', 6, 303, '10:05:00', 'ABC', 'S1'),
  fill('3', 'BUY', 4, 303, '10:05:01', 'ABC', 'S1'),
  fill('4', 'BUY', 5, 200, '10:20:00', 'XYZ'),
  fill('5', 'BUY', 5, 201, '10:30:00', 'XYZ'),
  fill('6', 'SELL', 10, 206, '11:10:00', 'XYZ', 'T1'),
  fill('7', 'BUY', 8, 304, '14:50:00', 'ABC'),
];
const orders = [
  order({ orderId: 'S1', orderStatus: 'TRADED', transactionType: 'BUY', tradingSymbol: 'ABC', securityId: '11', triggerPrice: 303, quantity: 10, filledQty: 10, updateTime: `${T} 10:05:01` }),
  order({ orderId: 'T1', orderStatus: 'TRADED', orderType: 'LIMIT', transactionType: 'SELL', tradingSymbol: 'XYZ', securityId: '22', price: 206, quantity: 10, filledQty: 10, createTime: `${T} 10:31:00`, updateTime: `${T} 11:10:00` }),
];

test('one press pairs the whole day, prices it after charges and saves each completed trade', async () => {
  const s = setup((f) => f.addTab('october-2026', [[...MONTHLY_BASE]]));
  s.dhan.t = day; s.dhan.o = orders;
  const r = await s.run();

  const abc = r.groups.find((g) => g.symbol === 'ABC' && g.status === 'CLOSED')!;
  const xyz = r.groups.find((g) => g.symbol === 'XYZ')!;
  assert.equal(abc.direction, 'SHORT'); assert.equal(abc.peakQty, 10); assert.equal(abc.grossPnl, -30);
  assert.equal(xyz.direction, 'LONG'); assert.equal(xyz.adds, 1); assert.equal(xyz.grossPnl, 55);
  assert.ok(abc.charges! > 0 && abc.netPnl === Number((abc.grossPnl! - abc.charges!).toFixed(2)));
  assert.equal(abc.exitType, 'STOP'); assert.equal(abc.initialStop, 303); assert.equal(xyz.exitType, 'TARGET');
  assert.equal(r.groups.filter((g) => g.status === 'OPEN').length, 1);

  const sum = summarizeDay(r);
  assert.deepEqual([sum.closed, sum.savedNow, sum.alreadyIn, sum.notSaved, sum.open], [2, 2, 0, 0, 1]);
  assert.equal(sum.line, '2 completed trades · 2 saved to the sheet now · 1 open position (saved once flat)');
  const rows = s.f.table('october-2026');
  assert.equal(rows.length, 6, 'one row per fill of the two completed trades; the open one is not written');
  assert.deepEqual([...new Set(rows.map((x) => x.Direction))].sort(), ['LONG', 'SHORT']);
});

test('pressing again writes nothing twice', async () => {
  const s = setup((f) => f.addTab('october-2026', [[...MONTHLY_BASE]]));
  s.dhan.t = day; s.dhan.o = orders;
  await s.run();
  const sum = summarizeDay(await s.run());
  assert.deepEqual([sum.savedNow, sum.alreadyIn], [0, 2]);
  assert.equal(s.f.table('october-2026').length, 6);
});

test('a trade already logged by hand is recognised, not written again', async () => {
  const s = setup((f) => f.addTab('october-2026', [[...MONTHLY_BASE],
    ['MANUAL-1', T, 'XYZ', 'LONG', 'BUY', 200, 5, 55, 40, 15, 'WIN', '10:20:00', 3000, 'YES', '4', '', '']]));
  s.dhan.t = day; s.dhan.o = orders;
  const sum = summarizeDay(await s.run());
  assert.deepEqual([sum.savedNow, sum.alreadyIn], [1, 1]);
  assert.equal(s.f.table('october-2026').length, 1 + 3);
});

test('a quiet day says so', () => {
  assert.equal(summarizeDay({ groups: [], finalized: [] }).line, 'No trades today');
});
