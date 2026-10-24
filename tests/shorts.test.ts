import test from 'node:test';
import assert from 'node:assert/strict';
import { journalShortTrades, mysteryEligible, resultOf, scoreWeek, seasonScore, splitMeAlgo, tradeOfWeek, weekOf, type ShortTrade } from '../lib/shorts/trades';
import { buildPanel, dayCandles, regroup } from '../lib/shorts/spec';

const H = ['TradeGroupId', 'Date (IST)', 'Symbol', 'Direction', 'OrderType', 'Price', 'Qty', 'NetPnL', 'Time (IST)', 'EntryTime', 'ExitTime', 'AvgEntry', 'AvgExit', 'InitialStop', 'RiskInr', 'ExitType', 'DirFromFills'];
const row = (o: Record<string, string | number>) => ({ cells: H.map((h) => String(o[h] ?? '')) });

test('journal fills become one trade each, with entries, exits, times and R from the logged risk', () => {
  const g = { TradeGroupId: 'G1', 'Date (IST)': '2026-07-15', Symbol: 'angelone', Direction: 'LONG', NetPnL: 96.5, RiskInr: 40, InitialStop: 292.45, ExitType: 'TARGET', DirFromFills: 'LONG' };
  const rows = [
    row({ ...g, OrderType: 'BUY', Price: 292.95, Qty: 50, 'Time (IST)': '09:56:16' }),
    row({ ...g, OrderType: 'BUY', Price: 292.95, Qty: 24, 'Time (IST)': '09:57:02' }),
    row({ ...g, OrderType: 'SELL', Price: 294.3, Qty: 30, 'Time (IST)': '10:59:40' }),
    row({ ...g, OrderType: 'SELL', Price: 294.3, Qty: 44, 'Time (IST)': '11:00:18' }),
    // an open trade (no exit yet) is left out
    row({ TradeGroupId: 'G2', 'Date (IST)': '2026-07-15', Symbol: 'SCI', DirFromFills: 'SHORT', OrderType: 'SELL', Price: 300, Qty: 10, 'Time (IST)': '09:20:00', NetPnL: '' }),
  ];
  const [t, ...rest] = journalShortTrades(H, rows);
  assert.equal(rest.length, 0);
  assert.equal(t.symbol, 'ANGELONE');
  assert.equal(t.dir, 'LONG');
  assert.equal(t.avgEntry, 292.95);
  assert.equal(t.avgExit, 294.3);
  assert.equal(t.entryTime, '09:56:16');
  assert.equal(t.exitTime, '11:00:18');
  assert.equal(t.holdMin, 64);
  assert.equal(t.fills.filter((f) => f.kind === 'in').length, 2);
  assert.equal(t.netR, 2.41);
  assert.deepEqual(resultOf(t), { value: 2.4, unit: 'R' });
});

test('without a logged risk the short shows the price move, never an assumed R', () => {
  const g = { TradeGroupId: 'G3', 'Date (IST)': '2026-05-07', Symbol: 'ENGINERSIN', NetPnL: 120, DirFromFills: 'SHORT' };
  const [t] = journalShortTrades(H, [row({ ...g, OrderType: 'SELL', Price: 289.6, Qty: 40, 'Time (IST)': '09:21:27' }), row({ ...g, OrderType: 'BUY', Price: 286.95, Qty: 40, 'Time (IST)': '09:28:58' })]);
  assert.equal(t.netR, undefined);
  assert.deepEqual(resultOf(t), { value: 0.92, unit: '%' });
});

test('mystery charts only use trades over 3 months old (SEBI)', () => {
  const now = Date.parse('2026-10-24T10:00:00Z');
  const t = { date: '2026-07-15', holdMin: 64 } as ShortTrade;
  assert.equal(mysteryEligible(t, now), true);
  assert.equal(mysteryEligible({ ...t, date: '2026-07-30' }, now), false);
  assert.equal(mysteryEligible({ ...t, holdMin: 1 }, now), false);
});

const T = (o: Partial<ShortTrade>): ShortTrade => ({ id: 'x', date: '2026-10-23', symbol: 'ABC', dir: 'SHORT', entryTime: '09:40:05', exitTime: '09:52:00', avgEntry: 100, avgExit: 99, fills: [], net: 300, risk: 300, netR: 1, movePct: 1, holdMin: 12, exitType: 'TARGET', ...o });

test('Algo Live orders claim their journal trade; everything else is his', () => {
  const sentAt = Date.parse('2026-10-23T09:40:00+05:30');
  const trades = [T({ id: 'a', symbol: 'FSL' }), T({ id: 'b', symbol: 'FSL', entryTime: '13:00:00' }), T({ id: 'c', symbol: 'SCI', dir: 'LONG' })];
  const { me, algo } = splitMeAlgo(trades, [
    { date: '2026-10-23', symbol: 'FSL', sentAt, stop: 101, status: 'TRADED', avgPrice: 100, risk: 300 },
    { date: '2026-10-23', symbol: 'SCI', sentAt, stop: 101, status: 'REJECTED' },
  ]);
  assert.deepEqual(algo.map((t) => t.id), ['a']);
  assert.deepEqual(me.map((t) => t.id).sort(), ['b', 'c']);
});

test('weekly score and season table', () => {
  const w1 = scoreWeek('2026-10-19', [T({ netR: 1.5 }), T({ netR: -1 }), T({ netR: undefined, risk: undefined })], [T({ netR: -1 })]);
  assert.equal(w1.me.r, 0.5); assert.equal(w1.me.n, 2); assert.equal(w1.me.uncounted, 1);
  assert.equal(w1.winner, 'me');
  const w2 = scoreWeek('2026-10-26', [T({ netR: -1 })], [T({ netR: 2 })]);
  assert.equal(w2.winner, 'algo');
  const w3 = scoreWeek('2026-11-02', [], []);
  assert.equal(w3.winner, 'none');
  assert.deepEqual(seasonScore([w1, w2, w3], '2026-10-19'), { me: 1, algo: 0 });
  assert.deepEqual(seasonScore([w1, w2, w3], '2026-11-02'), { me: 1, algo: 1 });
  assert.equal(weekOf('2026-10-23'), '2026-10-19');
  assert.equal(weekOf('2026-10-19'), '2026-10-19');
  // the trade of the week is the biggest R either way: a stop-out can be the story
  assert.equal(tradeOfWeek([T({ id: 'w', netR: 0.6 }), T({ id: 'l', netR: -1.2 })])?.id, 'l');
});

/** one session of 1-minute candles from 09:15 IST */
function session(date: string, n: number) {
  const t0 = Date.parse(`${date}T09:15:00+05:30`) / 1000;
  const c = { t: [] as number[], o: [] as number[], h: [] as number[], l: [] as number[], c: [] as number[], v: [] as number[] };
  for (let i = 0; i < n; i++) { const p = 100 + Math.sin(i / 7); c.t.push(t0 + i * 60); c.o.push(p); c.h.push(p + 0.2); c.l.push(p - 0.2); c.c.push(p + 0.05); c.v.push(1000); }
  return c;
}

test('candles: only the trade day, grouped from 09:15 when the trade is long', () => {
  const two = session('2026-07-14', 375);
  const day = session('2026-07-15', 375);
  for (const k of ['t', 'o', 'h', 'l', 'c', 'v'] as const) two[k].push(...day[k]);
  assert.equal(dayCandles(two, '2026-07-15').t.length, 375);
  const g5 = regroup(day, 5);
  assert.equal(g5.length, 75);
  assert.equal(g5[0][0], day.t[0]);
  assert.equal(g5[0][2], Math.max(...day.h.slice(0, 5)));
  assert.equal(g5[0][4], day.c[4]);
});

test('panel: lead-up + whole trade + a little after, entry and exit on the right candles, fits a short', () => {
  const day = session('2026-07-15', 375);
  const t = T({ date: '2026-07-15', dir: 'LONG', entryTime: '09:56:16', exitTime: '11:00:18', holdMin: 64, stop: 99.5, netR: 2.41,
    fills: [{ time: '09:56:16', price: 100, qty: 50, kind: 'in' }, { time: '11:00:18', price: 101, qty: 50, kind: 'out' }] });
  const p = buildPanel(day, t);
  assert.equal(p.tf, 1);
  assert.ok(p.candles.length <= 120);
  const hhmm = (sec: number) => new Date((sec + 19800) * 1000).toISOString().slice(11, 16);
  assert.equal(hhmm(p.candles[p.entryIdx][0]), '09:56');
  assert.equal(hhmm(p.candles[p.exitIdx][0]), '11:00');
  assert.ok(p.entryIdx >= 30, 'some lead-up before the entry');
  assert.equal(p.fills.length, 2);
  // a 3-hour hold groups into bigger candles
  const long = buildPanel(day, { ...t, entryTime: '09:20:00', exitTime: '13:30:00', holdMin: 250 });
  assert.ok(long.tf > 1 && long.candles.length <= 120);
  assert.throws(() => buildPanel({ t: [], o: [], h: [], l: [], c: [], v: [] }, t), /No candles saved/);
});
