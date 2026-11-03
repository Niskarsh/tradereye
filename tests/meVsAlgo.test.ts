import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, totalsOf, untouched } from '../lib/algoLive/meVsAlgo';
import { journalTrades, liveOrders } from '../lib/algoLive/fills';
import type { OrderRec } from '../lib/algoLive/engine';
import type { JournalTrade } from '../lib/algoLive/fills';
import type { Candles } from '../lib/dhan';

const D = '2026-11-03';
const sec = (hhmm: string) => Date.parse(`${D}T${hhmm}:00Z`) / 1000 - 19800;
const order: OrderRec = { symbol: 'ABC', securityId: '1', slot: 20, pred: 0.1, price: 300, adr: 8, qty: 75, stop: 304, target: 296, correlationId: 'c', sentAt: sec('09:35') * 1000, status: 'TRADED', avgPrice: 300 };
function candles(path: [string, number, number][]): Candles {
  const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const [t, h, l] of path) { c.t.push(sec(t)); c.o.push(h); c.h.push(h); c.l.push(l); c.c.push((h + l) / 2); c.v.push(1); }
  return c;
}
const mine = (o: Partial<JournalTrade>): JournalTrade => ({ date: D, symbol: 'ABC', entryTime: '09:35:04', avgEntry: 300, avgExit: 299.8, exitType: 'MANUAL', short: true, exitTime: '10:20:00', netPnl: -25, ...o });

test('today\'s case: 80% of the way, he gets out at a scratch, the untouched stop is then hit', () => {
  const c = candles([['09:40', 300, 299], ['10:00', 299, 296.8], ['10:20', 300, 299.5], ['10:50', 304.1, 300]]);
  const r = judge(D, order, mine({}), c, true)!;
  assert.equal(r.peakPct, 80);
  assert.equal(r.planOutcome, 'STOP');
  assert.equal(r.steppedIn, true);
  assert.ok(r.planInr! < -300 && r.diffInr! > 280, `plan ${r.planInr}, diff ${r.diffInr}`);
});

test('an exit that gave up a target counts against him', () => {
  const c = candles([['09:40', 300, 299.5], ['09:50', 300, 299.8], ['10:30', 299, 295]]);
  const r = judge(D, order, mine({ exitTime: '09:50:00', avgExit: 299.8, netPnl: -20 }), c, true)!;
  assert.equal(r.planOutcome, 'TARGET');
  assert.ok(r.diffInr! < -250);
  const t = totalsOf([r]);
  assert.deepEqual([t.steppedIn, t.helped, t.hurt], [1, 0, 1]);
});

test('same minute touching both is a stop; a target must trade through; nothing hit stays open until the session ends', () => {
  assert.equal(untouched(order, 300, candles([['09:40', 304, 295]]), true)!.outcome, 'STOP');
  assert.equal(untouched(order, 300, candles([['09:40', 301, 296]]), false)!.outcome, 'OPEN');
  assert.equal(untouched(order, 300, candles([['09:40', 301, 296]]), true)!.outcome, '15:15');
});

test('trades left alone are not counted as stepping in; the journal reads a negative net P&L', () => {
  const c = candles([['09:40', 300, 299], ['10:00', 300, 295.5]]);
  const r = judge(D, order, mine({ avgExit: 296, exitTime: '10:00:00', exitType: 'TARGET', netPnl: 280 }), c, true)!;
  assert.equal(r.steppedIn, false);
  const H = ['TradeGroupId', 'Date (IST)', 'Symbol', 'Direction', 'NetPnL', 'ExitTime'];
  const j = journalTrades(H, [{ cells: ['g', D, 'ABC', 'SHORT', '-25.5', '10:20:00'] }]);
  assert.equal(j[0].netPnl, -25.5);
  assert.equal(typeof liveOrders, 'function');
});

test('a bare wick through the target is marked uncertain, with what happens if it did not fill', () => {
  const c = candles([['09:40', 300, 299], ['10:30', 298, 295.9], ['11:00', 304.1, 298]]);
  const r = judge(D, order, mine({ exitTime: '10:00:00', avgExit: 299, netPnl: 50 }), c, true)!;
  assert.equal(r.planOutcome, 'TARGET');
  assert.equal(r.throughTicks, 2);
  assert.equal(r.fillDoubt, true);
  assert.equal(r.ifNoFill!.outcome, 'STOP');
  assert.ok(r.ifNoFill!.inr! < -300);
  const t = totalsOf([r]);
  assert.deepEqual([t.helped, t.hurt, t.unclear], [0, 0, 1]);
});

test('a target traded well through is not in doubt', () => {
  const r = judge(D, order, mine({ exitTime: '10:00:00', avgExit: 299, netPnl: 50 }), candles([['09:40', 300, 299], ['10:30', 298, 295]]), true)!;
  assert.equal(r.throughTicks, 20);
  assert.equal(r.fillDoubt, false);
});
