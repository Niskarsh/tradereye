import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candles } from '../lib/dhan';
import { afterExit, exitSignals, gatherReview, toStoredReview, REVIEW_SCHEMA } from '../lib/copilot/review';
import { MONTHLY_ALL } from '../lib/live/schema';
import { FakeSheets, IST } from './helpers';
import type { Bar } from '../lib/live/enrich';

const bars = (date: string, from: string, px: (i: number) => number, n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => { const c = px(i); return { t: IST(date, from) / 1000 + i * 60, o: c, h: c + 0.1, l: c - 0.1, c, v: 1000 }; });

test('after exit: price ran 1R+ his way without touching his stop = EARLY', () => {
  // long from 100, stop 99 (R = 1), out at 101 at 10:00; then it climbs to 103 by 10:40
  const b = bars('2026-10-15', '10:00:00', (i) => 101 + Math.min(i, 40) * 0.05, 120);
  const a = afterExit({ bars: b, direction: 'LONG', avgEntry: 100, avgExit: 101, exitMs: IST('2026-10-15', '10:00:10'), rDist: 1, rBasis: 'stop', lastStop: 99, exitType: 'MANUAL' });
  assert.equal(a.ExitCall, 'EARLY');
  assert.ok(a.BestR60! >= 1.9, String(a.BestR60));
  assert.equal(a.StopHitFirst60, false);
});

test('after exit: price went nowhere or against him = GOOD', () => {
  const b = bars('2026-10-15', '10:00:00', (i) => 101 - i * 0.03, 90);
  const a = afterExit({ bars: b, direction: 'LONG', avgEntry: 100, avgExit: 101, exitMs: IST('2026-10-15', '10:00:10'), rDist: 1, rBasis: 'stop', lastStop: 99, exitType: 'MANUAL' });
  assert.equal(a.ExitCall, 'GOOD');
});

test('stopped, then it went 1R+ his way from the entry within the hour = STOPPED_THEN_WORKED (short)', () => {
  // short from 100, stop 101 (R = 1), stopped at 101; then it falls to 98.5
  const b = bars('2026-10-15', '10:00:00', (i) => 101 - i * 0.06, 60);
  const a = afterExit({ bars: b, direction: 'SHORT', avgEntry: 100, avgExit: 101, exitMs: IST('2026-10-15', '10:00:10'), rDist: 1, rBasis: 'stop', lastStop: 101, exitType: 'STOP' });
  assert.equal(a.ExitCall, 'STOPPED_THEN_WORKED');
});

test('exit signals name the stay and go signs in plain words', () => {
  const s = exitSignals({ NiftyLast30Trend: 'FLAT', NiftyLast30Pct: 0.01, VwapSide: 'BUYERS', Stretch: 'VERY_STRETCHED', StretchDir: 'UP', StretchRunPct: 95, Ema200InPath: '', Climax: '', FailedBreak: '', flags: [], missing: [], NiftyState: 'FLAT' },
    { AvgEntry: 100, CounterVolRatio: 0.5, ClimaxAgainst: '', FailedExtreme: '', MinInTrade: 10, missing: [] }, 'LONG', 0.8);
  assert.ok(s.stay.some((x) => /still moving your way/.test(x)));
  assert.ok(s.stay.some((x) => /lighter/.test(x)));
  assert.ok(s.go.some((x) => /Nifty 500 flat/.test(x)));
  assert.ok(s.go.some((x) => /very stretched/.test(x)));
});

test('review from the journal only (no token): gathers the trade, marks the review partial', async () => {
  const fs = new FakeSheets();
  const h = [...MONTHLY_ALL];
  const row = (o: Record<string, string | number>) => h.map((k) => String(o[k] ?? ''));
  fs.addTab('october-2026', [h,
    row({ TradeGroupId: 'G1', 'Date (IST)': '2026-10-15', Symbol: 'HINDPETRO', Direction: 'LONG', OrderType: 'BUY', Price: 339.25, Qty: 100, NetPnL: 60, 'Time (IST)': '10:40:00', InitialStop: 337.45, ExitType: 'MANUAL', Setup: 'momentum', DirFromFills: 'LONG', Comment: 'Exited at 96% ADR' }),
    row({ TradeGroupId: 'G1', 'Date (IST)': '2026-10-15', Symbol: 'HINDPETRO', Direction: 'LONG', OrderType: 'SELL', Price: 340.4, Qty: 100, NetPnL: 60, 'Time (IST)': '10:46:00' }),
  ]);
  const r = await gatherReview({ sheets: fs.client(), lookupSecurityId: async () => '1' }, 'october-2026', 'G1');
  assert.equal(r.firstRowNumber, 2);
  assert.match(r.message, /"AvgEntry":339.25/);
  assert.match(r.message, /"AvgExit":340.4/);
  assert.match(r.message, /HIS_NOTES .*96% ADR/);
  assert.match(r.message, /MISSING No Dhan token/);
  assert.equal(r.exitCall, 'UNKNOWN');
});

test('review with market data: entry/exit facts, after-exit and the 10-min chart with ENTRY/EXIT marks', async () => {
  const fs = new FakeSheets();
  const h = [...MONTHLY_ALL];
  const row = (o: Record<string, string | number>) => h.map((k) => String(o[k] ?? ''));
  fs.addTab('october-2026', [h,
    row({ TradeGroupId: 'G2', 'Date (IST)': '2026-10-14', Symbol: 'X', OrderType: 'BUY', Price: 301, Qty: 10, NetPnL: 5, 'Time (IST)': '10:30:00', InitialStop: 300, ExitType: 'MANUAL', Setup: 'momentum' }),
    row({ TradeGroupId: 'G2', 'Date (IST)': '2026-10-14', Symbol: 'X', OrderType: 'SELL', Price: 302, Qty: 10, NetPnL: 5, 'Time (IST)': '10:50:00' }),
  ]);
  const days = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14'];
  const candles = (base: number, slope: number): Candles => {
    const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
    for (const d of days) for (let m = 0; m < 375; m++) {
      const px = d === '2026-10-14' ? base + m * slope : base + Math.sin(m / 7);
      c.t.push(IST(d, '09:15:00') / 1000 + m * 60); c.o.push(px); c.h.push(px + 0.2); c.l.push(px - 0.2); c.c.push(px); c.v.push(1000);
    }
    return c;
  };
  const daily: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < 300; i++) { daily.t.push(IST('2025-06-02', '00:00:00') / 1000 + i * 86400); daily.o.push(300); daily.h.push(303); daily.l.push(297); daily.c.push(300); daily.v.push(1e6); }
  const dhan = {
    async intraday(p: { securityId: string }) { return p.securityId === '19' ? candles(24000, 1) : candles(298, 0.04); },
    async daily() { return daily; },
  };
  const r = await gatherReview({ sheets: fs.client(), dhan, lookupSecurityId: async () => '7' }, 'october-2026', 'G2');
  for (const k of ['AT_ENTRY ', 'AT_EXIT ', 'IN_TRADE_AT_EXIT ', 'EXIT_SIGNALS ', 'AFTER_EXIT ', 'STOCK_10M']) assert.ok(r.message.includes(k), k);
  assert.match(r.message, /,ENTRY\n/);
  assert.match(r.message, /,EXIT\n/);
  assert.equal(r.exitCall, 'EARLY'); // it kept trending up 1R+ after the exit
});

test('stored review keeps the app\'s exit call and caps every list at 3', () => {
  const s = toStoredReview({ grade: 'MIXED', headline: 'h', right: ['a', 'b', 'c', 'd'], wrong: [], exit_points: ['x'], next_time: ['n'] }, '', 'EARLY', { at: 't', costInr: 2, model: 'm' });
  assert.deepEqual([s.grade, s.right.length, s.exit], ['MIXED', 3, 'EARLY']);
  assert.equal((REVIEW_SCHEMA as { additionalProperties: boolean }).additionalProperties, false);
});

import { ordersOf } from '../lib/copilot/review';

test('one order filled in pieces is one entry, not an add; a later order is an add', () => {
  const t = (hms: string) => IST('2026-10-15', hms);
  const fills = [
    { ts: t('10:40:00'), side: 'BUY', qty: 30, price: 339.2 },
    { ts: t('10:40:00'), side: 'BUY', qty: 30, price: 339.3 },   // same order, split by the exchange
    { ts: t('10:40:01'), side: 'BUY', qty: 40, price: 339.35 },  // still the same order
    { ts: t('10:52:10'), side: 'BUY', qty: 50, price: 338.0 },   // a real add, 12 minutes later
    { ts: t('11:05:00'), side: 'SELL', qty: 100, price: 341 },
    { ts: t('11:05:00'), side: 'SELL', qty: 50, price: 341 },
  ];
  const buys = ordersOf(fills, 'BUY'), sells = ordersOf(fills, 'SELL');
  assert.deepEqual(buys.map((o) => [o.qty, o.fills]), [[100, 3], [50, 1]]);
  assert.deepEqual(sells.map((o) => [o.qty, o.fills]), [[150, 2]]);
});

test('the review sends orders, and Adds counts orders (split fills are not an add)', async () => {
  const fs = new FakeSheets();
  const h = [...MONTHLY_ALL];
  const row = (o: Record<string, string | number>) => h.map((k) => String(o[k] ?? ''));
  const base = { TradeGroupId: 'G3', 'Date (IST)': '2026-10-15', Symbol: 'X', DirFromFills: 'LONG' };
  fs.addTab('october-2026', [h,
    row({ ...base, OrderType: 'BUY', Price: 100, Qty: 30, 'Time (IST)': '10:40:00' }),
    row({ ...base, OrderType: 'BUY', Price: 100.1, Qty: 30, 'Time (IST)': '10:40:00' }),
    row({ ...base, OrderType: 'SELL', Price: 101, Qty: 60, 'Time (IST)': '10:55:00' }),
  ]);
  const r = await gatherReview({ sheets: fs.client(), lookupSecurityId: async () => '1' }, 'october-2026', 'G3');
  assert.match(r.message, /"Adds":0/);
  assert.match(r.message, /"EntryOrders":\["10:40:00 60 @ 100.05 \(2 fills, one order\)"\]/);
});
