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

/* ---- trades Algo Live placed ---------------------------------------------------------------------------------- */
import { managedAs, matchOrder, ALGO_REVIEW_RULES, ALGO_REVIEW_SCHEMA, toStoredAlgoReview } from '../lib/copilot/review';
import { factPushes, modelFor, scoreSide, splitPushes, whyPicked } from '../lib/algoLive/why';
import { saveState, type DayState, type OrderRec } from '../lib/algoLive/engine';
import { MODEL_KEY, type LiveModel } from '../lib/algoLive/model';
import { putJson, type Store } from '../lib/setups/store';
import type { MeVsAlgoRow } from '../lib/algoLive/meVsAlgo';

const memStore = (): Store => { const m = new Map<string, Uint8Array>(); return { get: async (k) => m.get(k), put: async (k, b) => { m.set(k, b); } }; };
const DAY = '2026-11-03';
const order: OrderRec = { symbol: 'ABC', securityId: '7', slot: 20, pred: 0.3, price: 262, adr: 5, qty: 60, stop: 264.5, target: 259.5, correlationId: 'c', sentAt: IST(DAY, '09:35:06'), status: 'TRADED', avgPrice: 261.95, risk: 300 };
const state = (o: Partial<DayState> = {}): DayState => ({
  v: 1, date: DAY, list: [{ symbol: 'ABC', securityId: '7', prevClose: 260, avgVol: 4e6 }], prepared: [], vetoes: ['XYZ'], armed: true, orders: [order], log: [],
  model: { month: '2026-11', threshold: 0.2, standAside: false, createdAt: 5 },
  ticks: {
    10: { slot: 10, at: 0, picked: [], note: '', missing: [], scored: [{ symbol: 'ABC', pred: 0.1, above: false }, { symbol: 'XYZ', pred: 0.05, above: false }] },
    20: { slot: 20, at: 0, picked: ['ABC'], note: '', missing: [], scored: [{ symbol: 'DEF', pred: 0.35, above: true }, { symbol: 'ABC', pred: 0.3, above: true }, { symbol: 'XYZ', pred: -0.1, above: false }, { symbol: 'NOD', pred: null, above: false }] },
  }, ...o,
});
// one tree: a high move since the open (or its rank) adds 0.3R, everything else nothing
const leaf = (value: number[], feature: number[], threshold: number[]) => ({ value, feature, threshold, missingLeft: [0, 0, 0], left: [1, 0, 0], right: [2, 0, 0], leaf: [0, 1, 1] });
const model = (o: Partial<LiveModel> = {}): LiveModel => ({
  v: 1, strategy: 'fCap2', month: '2026-11', createdAt: 5, train: ['2024-01', '2026-07'], val: ['2026-08', '2026-10'], features: ['retOpenPct', 'retOpenPct_rk', 'tVol'], ranked: ['retOpenPct'],
  threshold: 0.2, standAside: false, valTrades: 40, valR: 0.1, valDays: 60, rules: { firstSlot: 20, lastSlot: 100, cap: 2, stopAdr: 0.5, targetAdr: 0.5, exitSlot: 360, riskInr: 300 },
  models: [{ baseline: 0, trees: [leaf([0, 0, 0.3], [0, 0, 0], [0.5, 0, 0])] }], ...o,
});

test('an order is matched by stock, side and time; a rejected order or a long of his own is not', () => {
  const at = IST(DAY, '09:35:10');
  assert.equal(matchOrder([order], 'ABC', 'SHORT', at), order);
  assert.equal(matchOrder([order], 'ABC', 'LONG', at), undefined);
  assert.equal(matchOrder([order], 'ABC', 'SHORT', IST(DAY, '10:30:00')), undefined);
  assert.equal(matchOrder([{ ...order, status: 'REJECTED' }], 'ABC', 'SHORT', at), undefined);
});

test('his part: decided by the app from Me vs Algo', () => {
  const row = (o: Partial<MeVsAlgoRow>) => ({ steppedIn: true, fillDoubt: false, diffInr: 100, ...o }) as MeVsAlgoRow;
  assert.equal(managedAs(row({ steppedIn: false }), false), 'LEFT_ALONE');
  assert.equal(managedAs(row({ steppedIn: false }), true), 'MOVED_STOP_NO_EFFECT');
  assert.equal(managedAs(row({}), true), 'HELPED');
  assert.equal(managedAs(row({ diffInr: -100 }), false), 'HURT');
  assert.equal(managedAs(row({ diffInr: 2 }), false), 'EVEN');
  assert.equal(managedAs(row({ fillDoubt: true }), false), 'UNCLEAR');
  assert.equal(managedAs(row({ steppedIn: null }), false), 'UNKNOWN');
  assert.equal(managedAs(undefined, false), 'UNKNOWN');
});

test('the score side: rank among scored stocks, the score building up, the others above the bar', () => {
  const s = scoreSide(state(), order);
  assert.equal(s.rankAtClose, '2 of 3');
  assert.equal(s.scoreAboveBarR, 0.1);
  assert.deepEqual(s.othersAboveBar, [{ symbol: 'DEF', scoreR: 0.35 }]);
  assert.deepEqual(s.scoreEarlier.map((x) => [x.time, x.scoreR]), [['09:25', 0.1], ['09:35', 0.3]]);
  assert.deepEqual(s.vetoedToday, ['XYZ']);
});

test('the pushes are measured: only the fact the trees read gets credit, a fact and its rank count as one', () => {
  const m = model();
  const me = { retOpenPct: 3, retOpenPct_rk: 1, tVol: 1 };
  const others = [{ retOpenPct: 0.1, retOpenPct_rk: 0.2, tVol: 5 }, { retOpenPct: 0.2, retOpenPct_rk: 0.4, tVol: 9 }];
  const all = factPushes(m, me, others);
  const push = Object.fromEntries(all.map((p) => [p.fact, p.pushR]));
  assert.deepEqual(Object.keys(push).sort(), ['retOpenPct', 'tVol']);
  assert.equal(push.retOpenPct, 0.3); // swap it for the others' values and the 0.3R is gone
  assert.equal(push.tVol, 0);          // the trees never read it
  const { toward, against } = splitPushes(all);
  assert.deepEqual([toward.map((x) => x.fact), against.length], [['retOpenPct'], 0]);
  assert.equal(all.find((p) => p.fact === 'retOpenPct')!.aboveListPct, 100);
});

test('the model of the trade\'s month, not whichever is current', async () => {
  const store = memStore();
  await putJson(store, MODEL_KEY, model({ month: '2026-12', createdAt: 9 }));
  await putJson(store, 'setups/live/models/2026-11-100.json.gz', model({ createdAt: 4 }));
  await putJson(store, 'setups/live/models/2026-11-200.json.gz', model({ createdAt: 5 }));
  const listKeys = async () => ['setups/live/models/2026-11-100.json.gz', 'setups/live/models/2026-11-200.json.gz', 'setups/live/models/2026-12-300.json.gz'];
  assert.equal((await modelFor({ store, listKeys }, DAY, 4))!.createdAt, 4);
  assert.equal((await modelFor({ store, listKeys }, DAY))!.createdAt, 5);
  assert.equal(await modelFor({ store }, DAY), undefined);
});

test('no Dhan requests for the facts while Algo Live may be trading; afterwards they need the login', async () => {
  const store = memStore();
  await putJson(store, MODEL_KEY, model());
  let asked = 0;
  const dhan = { intraday: async () => { asked++; return { t: [], o: [], h: [], l: [], c: [], v: [] }; } };
  const during = await whyPicked({ store, dhan, now: () => IST(DAY, '10:30:00') }, state(), order);
  assert.equal(asked, 0);
  assert.match(during.notes.join(), /after 11:05/);
  assert.equal(during.why.facts, undefined);
  assert.equal(during.why.model?.readsNifty, false);
  const noLogin = await whyPicked({ store, now: () => IST(DAY, '16:00:00') }, state(), order);
  assert.match(noLogin.notes.join(), /Dhan login/);
});

test('saved facts are used again without asking Dhan', async () => {
  const store = memStore();
  await putJson(store, MODEL_KEY, model());
  const facts = { score: 0.3, matchesLive: true, stocksCompared: 9, toward: [], against: [] };
  await putJson(store, `setups/live/${DAY}/why/ABC-20.json.gz`, facts);
  const r = await whyPicked({ store, now: () => IST(DAY, '16:00:00') }, state(), order);
  assert.deepEqual(r.why.facts, facts);
});

test('a trade Algo Live placed is reviewed as the algo\'s; his own trade that day is not', async () => {
  const fs = new FakeSheets();
  const h = [...MONTHLY_ALL];
  const row = (o: Record<string, string | number>) => h.map((k) => String(o[k] ?? ''));
  fs.addTab('november-2026', [h,
    row({ TradeGroupId: 'A', 'Date (IST)': DAY, Symbol: 'ABC', OrderType: 'SELL', Price: 261.95, Qty: 60, NetPnL: 120, 'Time (IST)': '09:35:08', ExitType: 'TARGET', DirFromFills: 'SHORT' }),
    row({ TradeGroupId: 'A', 'Date (IST)': DAY, Symbol: 'ABC', OrderType: 'BUY', Price: 259.5, Qty: 60, NetPnL: 120, 'Time (IST)': '10:40:00' }),
    row({ TradeGroupId: 'M', 'Date (IST)': DAY, Symbol: 'ZZZ', OrderType: 'BUY', Price: 300, Qty: 10, 'Time (IST)': '12:00:00', Setup: 'reversal' }),
    row({ TradeGroupId: 'M', 'Date (IST)': DAY, Symbol: 'ZZZ', OrderType: 'SELL', Price: 301, Qty: 10, 'Time (IST)': '12:10:00' }),
  ]);
  const store = memStore();
  await saveState(store, state());
  await putJson(store, MODEL_KEY, model());
  const deps = { sheets: fs.client(), lookupSecurityId: async () => '7', store, now: () => IST(DAY, '16:00:00') };
  const a = await gatherReview(deps, 'november-2026', 'A');
  assert.ok(a.algo);
  for (const k of ['ALGO_ORDER ', 'WHY_PICKED ', 'ME_VS_ALGO ', 'PROTECT_LEVELS ']) assert.ok(a.message.includes(k), k);
  assert.doesNotMatch(a.message, /"Setup":/); // no setup of his to grade against
  assert.match(a.message, /"InitialStop":264.5/); // the order's own stop when the sheet has none
  const m = await gatherReview(deps, 'november-2026', 'M');
  assert.equal(m.algo, undefined);
  assert.doesNotMatch(m.message, /WHY_PICKED/);
});

test('the algo review holds no entry grade, and says so in its rules', () => {
  const s = toStoredAlgoReview({ headline: 'h', why_picked: ['1', '2', '3', '4', '5'], played_out: [], your_part: ['y'], see_it: [], watch_next: [] }, '', { managed: 'LEFT_ALONE' }, 'GOOD', { at: 't', costInr: 2, model: 'm' });
  assert.equal(s.grade, 'ALGO');
  assert.deepEqual([s.right, s.wrong, s.algo!.whyPicked.length], [[], [], 4]);
  assert.equal(toStoredAlgoReview({}, 'oops', { managed: 'UNKNOWN' }, 'UNKNOWN', { at: 't', costInr: 2, model: 'm' }).grade, 'RAW');
  assert.match(ALGO_REVIEW_RULES, /Never grade or second-guess the entry/);
  assert.equal(ALGO_REVIEW_SCHEMA.additionalProperties, false);
});

test('after hours the facts are rebuilt by the engine itself, prove the live score, and are saved for next time', async () => {
  const store = memStore();
  await putJson(store, MODEL_KEY, model());
  const days = ['2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02'];
  const minutes = (ds: string[], px: (d: string, m: number) => number): Candles => {
    const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
    for (const d of ds) for (let m = 0; m < 375; m++) { const x = px(d, m); c.t.push(IST(d, '09:15:00') / 1000 + m * 60); c.o.push(x); c.h.push(x + 0.1); c.l.push(x - 0.1); c.c.push(x); c.v.push(1000); }
    return c;
  };
  const daily: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < 300; i++) { daily.t.push(IST('2025-06-02', '00:00:00') / 1000 + i * 86400); daily.o.push(260); daily.h.push(263); daily.l.push(257); daily.c.push(260); daily.v.push(1e6); }
  const hist = minutes(days, (_, m) => 260 + Math.sin(m / 7));
  const list = [{ symbol: 'ABC', securityId: '7', prevClose: 260, avgVol: 1e6 }, { symbol: 'DEF', securityId: '8', prevClose: 260, avgVol: 1e6 }, { symbol: 'GHI', securityId: '9', prevClose: 260, avgVol: 1e6 }];
  for (const s of list) await putJson(store, `setups/live/${DAY}/stock/${s.symbol}.json.gz`, { symbol: s.symbol, securityId: s.securityId, daily, history: hist });
  let asked = 0;
  const dhan = { intraday: async (p: { securityId: string }) => {
    asked++;
    if (p.securityId === '19') return minutes([DAY], (_, m) => 24000 + m);
    return minutes([DAY], (_, m) => (p.securityId === '7' ? 260 + m * 0.2 : 260)); // ABC ran; the others did not
  } };
  const deps = { store, dhan, now: () => IST(DAY, '16:00:00') };
  const r = await whyPicked(deps, state({ list }), order);
  assert.deepEqual(r.notes, []);
  assert.equal(r.why.facts!.matchesLive, true);
  assert.equal(r.why.facts!.stocksCompared, 2);
  assert.equal(r.why.facts!.toward[0].fact, 'retOpenPct');
  assert.equal(r.why.facts!.toward[0].pushR, 0.3);
  const before = asked;
  const again = await whyPicked(deps, state({ list }), order);
  assert.equal(asked, before);
  assert.deepEqual(again.why.facts, r.why.facts);
  const off = await whyPicked({ ...deps, store }, state({ list }), { ...order, pred: 0.9, slot: 20, symbol: 'DEF' });
  assert.equal(off.why.facts!.matchesLive, false); // a score that does not come out as it did live is flagged
});
