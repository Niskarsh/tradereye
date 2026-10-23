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

test('a quiet poll costs 2 Sheets reads on a warm client (it used to cost 9), so 5-second polling stays far under the quota', async () => {
  const f = new FakeSheets(); f.addTab('october-2026', [[...MONTHLY_BASE]]);
  const client = f.client();                       // one client, like the warm server instance
  const dhan = { orders: async () => [], trades: async () => [trade('1', 'BUY', 10, 100, '09:20:00')], positions: async () => [] };
  const run = (o = {}) => runSync({ dhan: dhan as any, sheets: client, now: () => IST(T, '09:30:00') }, o);
  await run();                                      // cold: creates tabs, learns headers, saves the open trade
  const reads = async (o = {}) => { const b = f.calls.length; await run(o); return f.calls.slice(b).filter((c) => c.startsWith('GET')).length; };
  assert.equal(await reads({ includeRecent: false }), 2);
  assert.equal(await reads({ includeRecent: false }), 2);
  assert.ok(await reads({ includeRecent: true }) <= 4);   // + the activity log
});

test('co-pilot: the entry check made before the trade is copied onto its rows and tagged with the trade id', async () => {
  const s = setup((f) => {
    f.addTab('october-2026', [[...MONTHLY_BASE]]);
    f.addTab('october-2026-checks', [
      ['CheckId', 'Date', 'Time', 'Symbol', 'Direction', 'Mode', 'Verdict', 'Line1', 'Line2', 'Line3', 'Watch', 'RvolDay', 'Decision', 'TradeGroupId'],
      ['C-old', T, '09:01:00', 'ABC', 'LONG', 'ENTRY', 'SUPPORTS', 'too early', '', '', '', '0.2', '', ''],
      ['C-1', T, '09:18:40', 'ABC', 'LONG', 'ENTRY', 'WARNING', 'Daily 200 EMA close above', 'Volume fading', '', 'A close above PDH', '0.14', 'TOOK', ''],
      ['C-short', T, '09:19:00', 'ABC', 'SHORT', 'ENTRY', 'MIXED', 'x', '', '', '', '', '', ''],
    ]);
  });
  s.dhan.t = [trade('1', 'BUY', 10, 100, '09:20:00'), trade('2', 'SELL', 10, 101, '09:40:00')];
  s.at('09:41:00');
  const r = await s.run();
  assert.deepEqual(r.finalized.map((x) => x.result), ['LOGGED']);
  const rows = s.f.table('october-2026');
  assert.equal(rows.length, 2);
  for (const x of rows) {
    assert.equal(x.CkId, 'C-1'); assert.equal(x.CkVerdict, 'WARNING'); assert.equal(x.CkDecision, 'TOOK');
    assert.equal(x.CkLines, 'Daily 200 EMA close above | Volume fading'); assert.equal(x.CkRvolDay, '0.14');
  }
  const checks = s.f.table('october-2026-checks');
  assert.equal(checks.find((c) => c.CheckId === 'C-1')!.TradeGroupId, rows[0].TradeGroupId);
  assert.equal(checks.find((c) => c.CheckId === 'C-short')!.TradeGroupId, '');
  assert.equal(checks.find((c) => c.CheckId === 'C-old')!.TradeGroupId, '');
});

test('co-pilot: no checks tab is fine, the trade is still logged', async () => {
  const s = setup((f) => f.addTab('october-2026', [[...MONTHLY_BASE]]));
  s.dhan.t = [trade('1', 'BUY', 10, 100, '09:20:00'), trade('2', 'SELL', 10, 101, '09:40:00')];
  s.at('09:41:00');
  const r = await s.run();
  assert.deepEqual(r.finalized.map((x) => x.result), ['LOGGED']);
  assert.equal(s.f.table('october-2026')[0].CkId, '');
});

test('a super order (bracket): its stop and target legs are read from the super order, even after the trade closed', async () => {
  const s = setup((f) => f.addTab('october-2026', [[...MONTHLY_BASE]]));
  const entry = { orderId: 'E1', orderStatus: 'TRADED', transactionType: 'SELL', orderType: 'MARKET', tradingSymbol: 'ABC', securityId: '11',
    exchangeSegment: 'NSE_EQ', productType: 'INTRADAY', price: 0, quantity: 22, filledQty: 22, createTime: `${T} 09:35:47`, updateTime: `${T} 09:35:48` };
  const sup = (target: string, stop: string, upd: string) => [{ ...entry, updateTime: upd, legDetails: [
    { orderId: 'E1', legName: 'STOP_LOSS_LEG', transactionType: 'BUY', price: 275.75, orderStatus: stop, remainingQuantity: 22 },
    { orderId: 'E1', legName: 'TARGET_LEG', transactionType: 'BUY', price: 249.4, orderStatus: target, remainingQuantity: 22 },
  ] }];
  (s.dhan as any).superOrders = async () => (s.dhan as any).s;
  // read only after it closed at the target (as on the first sync after this change)
  s.dhan.o = [entry];
  (s.dhan as any).s = sup('TRADED', 'CANCELLED', `${T} 10:40:00`);
  // placed 09:35:47, filled 09:39 (the legs carry the placing time only)
  s.dhan.t = [trade('1', 'SELL', 22, 261.74, '09:39:10', 'ABC', 'E1'), trade('2', 'BUY', 22, 249.4, '10:40:00', 'ABC', 'E1')];
  s.at('15:40:00');
  const r = await s.run();
  const g = r.groups.find((x) => x.symbol === 'ABC')!;
  assert.equal(g.initialStop, 275.75); assert.equal(g.tpLast, 249.4);
  assert.equal(g.riskInr, Number(((275.75 - 261.74) * 22).toFixed(2)));
  assert.ok(g.rMultiple! > 0.8 && g.rMultiple! < 0.9, `R ${g.rMultiple}`);
  assert.equal(s.f.table('october-2026').filter((x) => x.Symbol === 'ABC')[0].InitialStop, '275.75');
});
