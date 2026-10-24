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

test('panel: 1-minute candles from 09:15 (or 2 hours before a late entry) to the candle after the exit, drawn as 10-min', () => {
  const day = session('2026-07-15', 375);
  const t = T({ date: '2026-07-15', dir: 'LONG', entryTime: '09:56:16', exitTime: '11:00:18', holdMin: 64, stop: 99.5, netR: 2.41,
    fills: [{ time: '09:56:16', price: 100, qty: 50, kind: 'in' }, { time: '11:00:18', price: 101, qty: 50, kind: 'out' }] });
  const p = buildPanel(day, t);
  const hhmm = (sec: number) => new Date((sec + 19800) * 1000).toISOString().slice(11, 16);
  assert.equal(p.tf, 10);
  assert.equal(hhmm(p.candles[0][0]), '09:15');
  assert.equal(hhmm(p.candles[p.entryIdx][0]), '09:56');
  assert.equal(hhmm(p.candles[p.exitIdx][0]), '11:00');
  assert.equal(hhmm(p.candles[p.candles.length - 1][0]), '11:14'); // the exit's 10-min candle (11:05) and one more
  assert.equal(p.fills.length, 2);
  // a late entry starts the chart two hours earlier, on a 10-minute boundary
  const late = buildPanel(day, { ...t, entryTime: '13:47:00', exitTime: '14:10:00', holdMin: 23 });
  assert.equal(hhmm(late.candles[0][0]), '11:45');
  assert.throws(() => buildPanel({ t: [], o: [], h: [], l: [], c: [], v: [] }, t), /No candles saved/);
});

test('Claude text: the mystery ticker never reaches the public texts, and every field is length-capped', async () => {
  const { scrubTicker, toSocialText } = await import('../lib/shorts/write');
  const raw = {
    tell: 'x'.repeat(200), notes: { me: '', algo: '' },
    youtube: { title: 'Would you long ANGELONE here?', description: 'ANGELONE at the open.\n#angelone #shorts', tags: ['#Day Trading', 'angelone', 'angelone share', 'nse'] },
    instagram: { caption: 'Guess before the reveal: #ANGELONE' },
  };
  const t = scrubTicker(toSocialText(raw, 'mystery'), 'ANGELONE');
  assert.equal(t.tell?.length, 90);
  assert.equal(t.notes, undefined);
  for (const s of [t.youtube.title, t.youtube.description, t.instagram.caption]) assert.ok(!/angelone/i.test(s), s);
  assert.deepEqual(t.youtube.tags, ['day trading', 'nse']);
  assert.match(t.youtube.title, /this stock/);
  // a ticker inside a longer word is left alone
  assert.equal(scrubTicker(toSocialText({ ...raw, youtube: { ...raw.youtube, title: 'SCI vs SCIENCE' } }, 'mystery'), 'SCI').youtube.title, 'this stock vs SCIENCE');
});

test('Claude gets the candles with the entry and exit marked, and his own journal words', async () => {
  const { candleLines, mysteryMessage } = await import('../lib/shorts/write');
  const day = session('2026-07-15', 375);
  const t = T({ date: '2026-07-15', dir: 'LONG', entryTime: '09:56:16', exitTime: '11:00:18', holdMin: 64, stop: 99.5, netR: 2.41, comment: 'Held the morning low three times', context: { RvolAtEntry: '2.3' },
    fills: [{ time: '09:56:16', price: 100, qty: 50, kind: 'in' }, { time: '11:00:18', price: 101, qty: 50, kind: 'out' }] });
  const p = buildPanel(day, t);
  const lines = candleLines(p).split('\n');
  assert.equal(lines.length, 12); // 10-minute candles 09:15 .. 11:05
  assert.match(lines.find((l) => l.includes('ENTRY')) ?? '', /^09:55/);
  assert.match(lines.find((l) => l.includes('EXIT')) ?? '', /^10:55/);
  const msg = mysteryMessage(t, p);
  assert.match(msg, /Held the morning low three times/);
  assert.match(msg, /RvolAtEntry=2.3/);
  assert.match(msg, /never put them in title/);
});

test('a losing trade gets the honest instructions: WHAT I MISSED, not THE TELL', async () => {
  const { mysteryMessage } = await import('../lib/shorts/write');
  const day = session('2026-07-15', 375);
  const base = { date: '2026-07-15', dir: 'LONG' as const, entryTime: '09:56:16', exitTime: '10:18:00', holdMin: 22, stop: 99.5,
    fills: [{ time: '09:56:16', price: 100, qty: 50, kind: 'in' as const }, { time: '10:18:00', price: 99.4, qty: 50, kind: 'out' as const }] };
  const loss = mysteryMessage(T({ ...base, netR: -1.1, net: -330 }), buildPanel(day, T({ ...base, netR: -1.1, net: -330 })));
  assert.match(loss, /OUTCOME: A LOSS/);
  assert.match(loss, /WHAT I MISSED/);
  assert.doesNotMatch(loss, /OUTCOME: A WIN/);
  const win = mysteryMessage(T({ ...base, netR: 1.4 }), buildPanel(day, T({ ...base, netR: 1.4 })));
  assert.match(win, /OUTCOME: A WIN/);
  assert.match(win, /THE TELL/);
});

test('recap marks: only candles on the chart, prices from the candles, levels inside the range, at most 3', async () => {
  const { toMarks, slots } = await import('../lib/shorts/spec');
  const day = session('2026-07-15', 375);
  const p = buildPanel(day, T({ date: '2026-07-15', dir: 'LONG', entryTime: '09:56:16', exitTime: '11:00:18', holdMin: 64, netR: 1,
    fills: [{ time: '09:56:16', price: 100, qty: 50, kind: 'in' }, { time: '11:00:18', price: 101, qty: 50, kind: 'out' }] }));
  const ss = slots(p);
  assert.equal(ss[0].time, '09:15');
  assert.equal(ss[3].time, '09:45');
  const m = toMarks([
    { time: '09:35', kind: 'high', price: 999, label: 'lower high' },   // price comes from the candle, not Claude
    { time: '09:45', kind: 'low', price: 0, label: 'held the low' },
    { time: '13:05', kind: 'high', price: 0, label: 'not on chart' },   // dropped
    { time: '09:45', kind: 'level', price: 5000, label: 'way off' },    // dropped: outside the range
    { time: '09:45', kind: 'wick', price: 0, label: 'unknown kind' },   // dropped
    { time: '09:25', kind: 'close', price: 0, label: 'x'.repeat(40) },
  ], p);
  assert.equal(m.length, 3);
  assert.deepEqual(m[0], { slot: 2, kind: 'high', price: Math.round(ss[2].h * 100) / 100, label: 'lower high' });
  assert.equal(m[1].price, Math.round(ss[3].l * 100) / 100);
  assert.equal(m[2].label.length, 24);
  assert.deepEqual(toMarks('nonsense', p), []);
});

test('Me vs Algo: Claude marks per side, and each panel knows how its trade ended', async () => {
  const { toSocialText } = await import('../lib/shorts/write');
  const t = toSocialText({ notes: { me: 'Higher low', algo: 'Short on a breakdown' }, vs_marks: { me: [{ time: '09:45', kind: 'low', price: 0, label: 'higher low' }], algo: [] },
    youtube: { title: 't', description: 'd', tags: [] }, instagram: { caption: 'c' } }, 'vs');
  assert.deepEqual(t.notes, { me: 'Higher low', algo: 'Short on a breakdown' });
  assert.equal((t.vsMarks?.me as unknown[]).length, 1);
  assert.equal(t.tell, undefined);
  const day = session('2026-07-15', 375);
  const p = buildPanel(day, T({ date: '2026-07-15', exitType: 'STOP', netR: -1, entryTime: '09:56:00', exitTime: '10:10:00', holdMin: 14 }));
  assert.equal(p.exitType, 'STOP');
});

test('Me vs Algo shows a ticker only when the trade is over 3 months old (SEBI)', async () => {
  const { vsPanel } = await import('../lib/shorts/spec');
  const day = session('2026-07-15', 375);
  const t = T({ date: '2026-07-15', symbol: 'ANGELONE', entryTime: '09:56:00', exitTime: '10:20:00', holdMin: 24 });
  assert.equal(vsPanel(t, day, '', Date.parse('2026-10-24T10:00:00Z')).symbol, 'ANGELONE');
  assert.equal(vsPanel(t, day, '', Date.parse('2026-08-01T10:00:00Z')).symbol, undefined);
});

test('season ledger: a week freezes with every earlier one, never drifts, and changes only on a deliberate re-score', async () => {
  const { emptyLedger, freezeThrough, mergedWeeks, drifted, rescore } = await import('../lib/shorts/season');
  const wk = (week: string, me: number, algo: number) => scoreWeek(week, me ? [T({ netR: me })] : [], algo ? [T({ netR: algo })] : []);
  const computed = [wk('2026-10-19', 1, -1), wk('2026-10-26', -1, 2), wk('2026-11-02', 0.5, 0.2)];
  // generating week 2 freezes weeks 1 and 2, not week 3
  const { ledger, changed } = freezeThrough(emptyLedger(), computed, '2026-10-26', 1000);
  assert.equal(changed, true);
  assert.deepEqual(Object.keys(ledger.weeks).sort(), ['2026-10-19', '2026-10-26']);
  assert.equal(freezeThrough(ledger, computed, '2026-10-26', 2000).changed, false);
  // the journal changes later: week 1 would now be an algo win; the ledger still shows the frozen result
  const later = [wk('2026-10-19', -2, -1), computed[1], computed[2]];
  const merged = mergedWeeks(ledger, later);
  assert.equal(merged[0].winner, 'me');
  assert.equal(merged[0].frozenAt, 1000);
  assert.equal(merged[2].frozenAt, undefined);           // week 3: not frozen, shown as computed
  assert.deepEqual(seasonScore(merged, '2026-10-26'), { me: 1, algo: 1 });
  assert.equal(drifted(ledger.weeks['2026-10-19'], later[0]), true);
  assert.equal(drifted(ledger.weeks['2026-10-26'], later[1]), false);
  // a deliberate re-score: new result, old one kept in history
  const r = rescore(ledger, later[0], 3000);
  assert.equal(r.weeks['2026-10-19'].winner, 'algo');
  assert.equal(r.weeks['2026-10-19'].rescoredAt, 3000);
  assert.equal(r.weeks['2026-10-19'].frozenAt, 1000);
  assert.equal(r.weeks['2026-10-19'].history?.[0].winner, 'me');
});
