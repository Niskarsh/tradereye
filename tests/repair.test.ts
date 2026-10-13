import test from 'node:test';
import assert from 'node:assert/strict';
import { MONTHLY_ALL, ORDER_STATE_COLS, LIVE_TRADE_COLS, ORDER_EVENT_COLS } from '../lib/live/schema';
import { repairFromLogs, clearLogs } from '../lib/live/repair';
import { FakeSheets, IST } from './helpers';

const T = '2026-10-12';
function sheetWith() {
  const f = new FakeSheets();
  const mk = (o: Record<string, string>) => MONTHLY_ALL.map((h) => o[h] ?? '');
  const base = { TradeGroupId: 'TRD-1', 'Date (IST)': T, Symbol: 'ABC', Direction: 'LONG', SecurityId: '11', Source: 'AUTO', ExitType: 'MANUAL' };
  f.addTab('october-2026', [[...MONTHLY_ALL],
    mk({ ...base, OrderType: 'BUY', Price: '100', Qty: '10', 'Time (IST)': '09:20:00', ExchTradeId: 'a' }),
    mk({ ...base, OrderType: 'SELL', Price: '99', Qty: '10', 'Time (IST)': '09:25:00', ExchTradeId: 'b' })]);
  // order-state: a pending stop at 99 that was trailed from 98, created after entry, then triggered at the exit
  const hist = JSON.stringify([[IST(T, '09:21:00'), 'PENDING', 98, 0, 10, 0], [IST(T, '09:23:00'), 'PENDING', 99, 0, 10, 0], [IST(T, '09:25:00'), 'TRADED', 99, 0, 10, 10]]);
  const st = (o: Record<string, string>) => ORDER_STATE_COLS.map((h) => o[h] ?? '');
  f.addTab('order-state', [[...ORDER_STATE_COLS], st({ OrderId: 'S1', Date: T, Symbol: 'ABC', SecurityId: '11', Segment: 'NSE_EQ', Side: 'SELL', Kind: 'STOP', Status: 'TRADED', Trigger: '99', Qty: '10', Filled: '10', History: hist })]);
  f.addTab('order-events', [[...ORDER_EVENT_COLS], ['k1']]);
  f.addTab('live-trades', [[...LIVE_TRADE_COLS], ['g1']]);
  return f;
}

test('repair fills stop, risk and exit type of a logged trade from the order log, without touching typed cells', async () => {
  const f = sheetWith();
  const r = await repairFromLogs(f.client());
  assert.equal(r.fixed, 1);
  for (const row of f.table('october-2026')) {
    assert.equal(row.InitialStop, '98'); assert.equal(row.LastStop, '99'); assert.equal(row.StopMoves, '1');
    assert.equal(row.InitialStopDist, '2'); assert.equal(row.RiskInr, '20'); assert.equal(row.ExitType, 'STOP');
  }
  assert.equal((await repairFromLogs(f.client())).fixed, 0); // second run: nothing left to do
});

test('clear logs empties the three log tabs and keeps their headers', async () => {
  const f = sheetWith();
  const done = await clearLogs(f.client());
  assert.deepEqual(done.sort(), ['live-trades', 'order-events', 'order-state']);
  for (const t of done) assert.equal(f.rows(t).length, 1);
  assert.equal(f.rows('october-2026').length, 3);
});
