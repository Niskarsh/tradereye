/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../lib/live/sync';
import { MONTHLY_BASE } from '../lib/live/schema';
import { FakeSheets, IST } from './helpers';

const T = '2026-10-12';
const trade = (id: string, side: 'BUY' | 'SELL', qty: number, price: number, time: string, symbol = 'ABC', orderId = 'O' + id) => ({
  exchangeTradeId: id, orderId, tradingSymbol: symbol, securityId: '11', exchangeSegment: 'NSE_EQ', transactionType: side,
  tradedQuantity: qty, tradedPrice: price, createTime: `${T} ${time}`,
});
const order = (o: any) => ({
  orderId: 'S1', orderStatus: 'PENDING', transactionType: 'SELL', orderType: 'STOP_LOSS', tradingSymbol: 'ABC', securityId: '11',
  exchangeSegment: 'NSE_EQ', productType: 'INTRADAY', triggerPrice: 99, price: 0, quantity: 10, filledQty: 0,
  createTime: `${T} 09:21:00`, updateTime: `${T} 09:21:00`, ...o,
});

function setup(initial?: (f: FakeSheets) => void) {
  const f = new FakeSheets();
  initial?.(f);
  const dhan = { o: [] as any[], t: [] as any[], p: [] as any[], orders: async () => dhan.o, trades: async () => dhan.t, positions: async () => dhan.p };
  let clock = IST(T, '09:30:00');
  const run = (opts = {}) => runSync({ dhan, sheets: f.client(), now: () => clock }, opts);
  return { f, dhan, run, at: (time: string) => { clock = IST(T, time); } };
}

test('open trade lives only in live-trades; nothing reaches the monthly sheet or stats', async () => {
  const s = setup((f) => f.addTab('october-2026', [[...MONTHLY_BASE]]));
  s.dhan.t = [trade('1', 'BUY', 10, 100, '09:20:00')];
  s.dhan.o = [order({})];
  s.dhan.p = [{ tradingSymbol: 'ABC', netQty: 10, unrealizedProfit: 12.5 }];
  const r = await s.run();
  assert.equal(r.totals.openCount, 1); assert.equal(r.totals.closedCount, 0); assert.equal(r.totals.closedNet, 0);
  assert.equal(r.groups[0].unrealized, 12.5); assert.equal(r.groups[0].initialStop, 99); assert.equal(r.groups[0].riskInr, 10);
  assert.equal(s.f.table('october-2026').length, 0);
  const lt = s.f.table('live-trades');
  assert.equal(lt.length, 1); assert.equal(lt[0].Status, 'OPEN');
});

test('trade goes flat -> written once to the monthly sheet in the existing shape, idempotent on re-sync', async () => {
  const s = setup((f) => f.addTab('october-2026', [[...MONTHLY_BASE], ['TRD-1', T, 'OLD', 'LONG', 'BUY', '5', '1', '0', '0', '0', 'WIN', '09:00:00', '1', 'YES', 'X1', '', '']]));
  s.dhan.t = [trade('1', 'BUY', 10, 100, '09:20:00')];
  s.dhan.o = [order({})];
  await s.run();
  s.dhan.t = [trade('1', 'BUY', 10, 100, '09:20:00'), trade('2', 'SELL', 10, 101, '09:40:00')];
  s.dhan.o = [order({ orderStatus: 'TRADED', filledQty: 10, updateTime: `${T} 09:40:00` })];
  s.at('09:41:00');
  const r = await s.run();
  assert.deepEqual(r.finalized.map((x) => x.result), ['LOGGED']);
  const rows = s.f.table('october-2026');
  assert.equal(rows.length, 3); // 1 old + 2 fills
  assert.deepEqual(s.f.rows('october-2026')[0].slice(0, 17), [...MONTHLY_BASE]); // original columns untouched, new ones appended
  const mine = rows.filter((x) => x.Symbol === 'ABC');
  assert.equal(mine[0].Direction, 'LONG'); assert.equal(mine[0].Source, 'AUTO'); assert.equal(mine[0].InitialStop, '99');
  assert.equal(mine[0].TradeGroupId, mine[1].TradeGroupId);
  assert.equal(mine[0].ExchTradeId, '1'); assert.equal(mine[1].ExchTradeId, '2');
  assert.ok(Number(mine[0].NetPnL) < 10 && Number(mine[0].GrossPnL) === 10);
  assert.equal(s.f.table('live-trades')[0].Status, 'LOGGED');
  // again and again: nothing new
  const before = s.f.rows('october-2026').length;
  await s.run(); await s.run();
  assert.equal(s.f.rows('october-2026').length, before);
  assert.equal(s.f.table('live-trades').length, 1);
});

test('a trade already logged by hand is not logged twice', async () => {
  const s = setup((f) => f.addTab('october-2026', [[...MONTHLY_BASE],
    ['TRD-9', T, 'ABC', 'LONG', 'BUY', '100', '10', '10', '9', '1', 'WIN', '09:20:00', '1200', 'YES', '1', '', ''],
    ['TRD-9', T, 'ABC', 'LONG', 'SELL', '101', '10', '10', '9', '1', 'WIN', '09:40:00', '1200', 'YES', '2', '', '']]));
  s.dhan.t = [trade('1', 'BUY', 10, 100, '09:20:00'), trade('2', 'SELL', 10, 101, '09:40:00')];
  const r = await s.run();
  assert.deepEqual(r.finalized.map((x) => x.result), ['DUPLICATE']);
  assert.equal(s.f.table('october-2026').length, 2);
});

test('creates the month tab with every column when it does not exist', async () => {
  const s = setup();
  s.dhan.t = [trade('1', 'SELL', 10, 100, '09:20:00'), trade('2', 'BUY', 10, 99, '09:30:00')];
  await s.run();
  const rows = s.f.table('october-2026');
  assert.equal(rows.length, 2); assert.equal(rows[0].Direction, 'SHORT'); assert.ok('Nifty500First5Pct' in rows[0]);
});

test('an open position from an earlier day is marked STALE, never written to the monthly sheet', async () => {
  const s = setup((f) => {
    f.addTab('live-trades', [['GroupId', 'Date', 'Symbol', 'SecurityId', 'Direction', 'Status', 'NetQty', 'AvgCost', 'RealizedGross', 'Adds', 'EntryTime', 'LastTime', 'InitialStop', 'LastStop', 'StopMoves', 'TpLast', 'RiskInr', 'FillCount', 'FillKeys', 'FinalizedAt', 'UpdatedAt', 'Note'],
      ['TRD-old', '2026-10-09', 'OLD', '1', 'LONG', 'OPEN', '5', '10', '0', '0', '09:20:00', '09:20:00', '', '', '0', '', '', '1', '[]', '', '', '']]);
  });
  await s.run();
  assert.equal(s.f.table('live-trades').find((x) => x.GroupId === 'TRD-old')!.Status, 'STALE');
});

test('a trade logged before its stop was understood gets stop/risk/exit filled in later, without touching what you typed', async () => {
  const s = setup((f) => f.addTab('october-2026', [[...MONTHLY_BASE]]));
  s.dhan.t = [trade('1', 'BUY', 10, 100, '09:20:00'), trade('2', 'SELL', 10, 101, '09:40:00')];
  s.dhan.o = [];                       // nothing about the stop is known when the trade closes
  s.at('09:41:00');
  await s.run();
  let mine = s.f.table('october-2026').filter((x) => x.Symbol === 'ABC');
  assert.equal(mine.length, 2); assert.equal(mine[0].InitialStop, ''); assert.equal(mine[0].RiskInr, '');
  // you add a note by hand on the first row
  const header = s.f.rows('october-2026')[0]; const ci = header.indexOf('Comment');
  s.f.rows('october-2026')[1][ci] = 'my note';
  // later the stop order is understood (correct side/kind from the order book)
  s.dhan.o = [order({ orderStatus: 'TRADED', filledQty: 10, updateTime: `${T} 09:40:00` })];
  s.at('09:42:00');
  const r = await s.run();
  mine = s.f.table('october-2026').filter((x) => x.Symbol === 'ABC');
  assert.equal(mine[0].InitialStop, '99'); assert.equal(mine[1].InitialStop, '99');
  assert.equal(mine[0].RiskInr, '10'); assert.equal(mine[0].StopMoves, '0');
  assert.equal(mine[0].Comment, 'my note');
  assert.equal(r.groups[0].riskInr, 10);
  assert.equal(s.f.table('live-trades')[0].InitialStop, '99');
  const before = s.f.calls.length; await s.run();
  assert.ok(!s.f.calls.slice(before).some((c) => c.includes('values:batchUpdate') && c.includes('october')), 'no repeated patching');
});
