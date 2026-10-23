import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, journalTrades, summarize } from '../lib/algoLive/fills';
import type { OrderRec } from '../lib/algoLive/engine';

const D = '2026-10-23';
const at = (hhmm: string) => Date.parse(`${D}T${hhmm}:00Z`) - 19800_000;
const order = (o: Partial<OrderRec> = {}): OrderRec => ({ symbol: 'ABC', securityId: '1', slot: 20, pred: 0.1, price: 300, adr: 8, qty: 75, stop: 304, target: 296,
  correlationId: 'c', sentAt: at('09:35'), status: 'TRADED', avgPrice: 299.9, ...o });
const H = ['TradeGroupId', 'Date (IST)', 'Symbol', 'Direction', 'EntryTime', 'AvgEntry', 'AvgExit', 'ExitType', 'LastStop', 'DirFromFills'];
const row = (id: string, sym: string, exit: number, type: string, time = '09:35:04', last = '') => [id, D, sym, 'SHORT', time, '299.90', String(exit), type, last, 'SHORT'];

test('journal: one line per trade group, by column name', () => {
  const j = journalTrades(H, [{ cells: row('g1', 'ABC', 296, 'TARGET') }, { cells: row('g1', 'ABC', 296, 'TARGET') }, { cells: row('g2', 'XYZ', 304.5, 'STOP') }]);
  assert.equal(j.length, 2);
  assert.deepEqual([j[0].symbol, j[0].short, j[0].exitType, j[0].avgExit], ['ABC', true, 'TARGET', 296]);
});

test('fills: a stop that filled 3 ticks worse and an entry 2 ticks worse cost 3 ticks against the backtest', () => {
  const j = journalTrades(H, [{ cells: row('g1', 'ABC', 304.15, 'STOP') }]);
  const r = compare(D, order(), j)!;
  assert.equal(r.entryTicks, 2);
  assert.equal(r.stopTicks, 3);
  // backtest: 1 tick in, 1 tick out; here 2 in, 3 out = 3 ticks more, on a risk of 304 - 299.95 = 4.05
  assert.ok(Math.abs(r.extraR - (3 * 0.05) / 4.05) < 0.002, String(r.extraR));
  assert.ok(Math.abs(r.stopPct! - (0.15 / 304) * 100) < 0.001);
});

test('fills: a target at its price costs nothing on the exit; a manual exit counts only for the entry', () => {
  const t = compare(D, order({ avgPrice: 299.95 }), journalTrades(H, [{ cells: row('g1', 'ABC', 296, 'TARGET') }]))!;
  assert.equal(t.targetTicks, 0); assert.equal(t.extraR, 0);
  const m = compare(D, order({ avgPrice: 299.85 }), journalTrades(H, [{ cells: row('g1', 'ABC', 298, 'MANUAL') }]))!;
  assert.equal(m.stopTicks, null); assert.equal(m.entryTicks, 3);
  const s = summarize([t, m]);
  assert.equal(s.trades, 2); assert.equal(s.manual, 1); assert.equal(s.stopsHit, 0); assert.equal(s.entryTicks, 2);
});

test('fills: a moved stop is measured against where it ended; an unfilled order is left out; the nearest journal trade wins', () => {
  const r = compare(D, order(), journalTrades(H, [{ cells: row('g1', 'ABC', 300.05, 'STOP', '09:35:04', '300.00') }]))!;
  assert.equal(r.stop, 300); assert.equal(r.stopTicks, 1);
  assert.equal(compare(D, order({ avgPrice: undefined }), []), undefined);
  const two = journalTrades(H, [{ cells: row('g1', 'ABC', 296, 'TARGET', '13:10:00') }, { cells: row('g2', 'ABC', 304.05, 'STOP', '09:35:02') }]);
  assert.equal(compare(D, order(), two)!.exitType, 'STOP');
});
