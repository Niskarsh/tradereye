import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candles } from '../lib/dhan';
import { toSessions, type Bar } from '../lib/live/enrich';
import { gridDay, ML_COLS, wideVol } from '../lib/ml/grid';
import { dailyBefore } from '../lib/algoLive/features';
import { modelKey, MODEL_KEY, WIDE_MODEL_KEY, versionOf, type LiveModel } from '../lib/algoLive/model';
import { gateBlocks, gateFor, loadSettings, orderFor, passes, pick, universeOf, POSITION_DEFAULT, type DayState, type Scored } from '../lib/algoLive/engine';
import { avgVolOf, gateToday, hotAgainst, hotOfHistory, median, quantile, ret20dOf, turnoverOf } from '../lib/algoLive/wide';
import { onTick } from '../lib/study/mine';
import { sizeFor } from '../lib/setups/costs';

/**
 * Algo Live's wide model (iteration 15's pick): the screener, the turnover floor, the market gate and the position sizing
 * work out what scripts/ml_live_wide.py and the wide dataset (lib/ml/grid.ts with `wide`) did; the narrow model is unchanged.
 */

const IST = 19800;
const sec = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 - IST;
const dailyAt = (base: number, vol: number): Candles => {
  const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < 700; i++) { c.t.push(sec('2023-01-02', '09:15') + i * 86400); c.o.push(base + Math.sin(i / 9) * 4); c.h.push(base + 5 + Math.sin(i / 9) * 4); c.l.push(base - 4 + Math.sin(i / 9) * 4); c.c.push(base + 1 + Math.sin(i / 7) * 4); c.v.push(vol + (i % 7) * 1e4); }
  return c;
};

const wideModel: LiveModel = {
  v: 1, strategy: 'w10_f100_c3_g', iteration: 15, universe: 'wide', month: '2026-12', createdAt: 0, train: ['2024-03', '2026-08'], val: ['2026-09', '2026-11'],
  features: ['x'], ranked: [], threshold: 0.1, standAside: false, valTrades: 100, valR: 0.1, valDays: 60,
  rules: { firstSlot: 20, lastSlot: 100, cap: 3, stopAdr: 0.5, targetAdr: 0.5, exitSlot: 360, riskInr: 300, minTurnoverRs: 1e9, refPrice: 340, positionInr: 1e6 },
  gate: { days: 250, min: 60, q: 2 / 3, history: [], hot: [] },
  models: [{ baseline: 0, trees: [] }],
};
const state = (o: Partial<DayState> = {}): DayState => ({ v: 1, date: '2026-12-01', list: [], prepared: [], vetoes: [], armed: true, ticks: {}, orders: [], log: [], version: 'wide', ...o });
const sc = (symbol: string, pred: number, thin = false): Scored => ({ symbol, pred, price: 600, adr: 18, above: pred > 0.1 && !thin, thin });
const cool = { move: 1, bar: 3, hot: false, history: 250, stocks: 400 };

test('algo live wide: the screener is the wide dataset\'s (₹250-1000, volume scaled to a ₹340 stock) and keeps the 20-day move', () => {
  const date = new Date((dailyAt(600, 4e5).t[650] + IST) * 1000).toISOString().slice(0, 10);
  // ₹600 with 4 lakh shares a day: under 5 lakh as shares, above it scaled to a ₹340 stock (4 lakh x 600/340 = 7 lakh)
  const d = dailyAt(600, 4e5);
  assert.equal(passes(d, date), undefined, 'the narrow screener: out of its price range');
  const p = passes(d, date, universeOf('wide'));
  assert.ok(p, 'the wide screener takes it');
  const before = dailyBefore(d, date), n = before.c.length;
  assert.equal(p!.ret20d, (before.c[n - 1] / before.c[n - 21] - 1) * 100);
  assert.equal(passes(dailyAt(200, 2e6), date, universeOf('wide')), undefined, 'under ₹250');
  assert.equal(passes(dailyAt(1100, 2e6), date, universeOf('wide')), undefined, 'over ₹1000');
  assert.equal(passes(dailyAt(300, 3e5), date, universeOf('wide')), undefined, 'thin: 3 lakh shares at ₹300 is not scaled up');
  assert.equal(passes(dailyAt(300, 7e5), date)?.ret20d, undefined, 'the narrow list is as before');
});

test('algo live wide: the turnover is the dataset\'s avgVol label x min(price, ₹340)', () => {
  // the dataset's avgVol label, from gridDay itself (the wide dataset), equals avgVolOf on the same daily candles
  const date = '2025-04-07';
  const bars = (d: string, base: number): Bar[] => Array.from({ length: 375 }, (_, k) => { const c = base + Math.sin(k / 11) * 2; return { t: sec(d, '09:15') + k * 60, o: c, h: c + 0.4, l: c - 0.4, c, v: 900 + (k % 5) * 100 }; });
  const hb = Array.from({ length: 20 }, (_, i) => bars(`2025-03-${String(i + 1).padStart(2, '0')}`, 600)).flat();
  const history = toSessions({ t: hb.map((b) => b.t), o: hb.map((b) => b.o), h: hb.map((b) => b.h), l: hb.map((b) => b.l), c: hb.map((b) => b.c), v: hb.map((b) => b.v) });
  const d = dailyBefore(dailyAt(600, 4e5), date);
  const rows = gridDay({ date, history, day: bars(date, 600), nifty: bars(date, 22000), daily: d, wide: true });
  assert.ok(rows.length);
  const label = rows[0][ML_COLS.indexOf('avgVol') - 2]; // rows have no sym / date columns
  assert.ok(Math.abs(label - avgVolOf(d, true)) < 1e-6, `${label} vs ${avgVolOf(d, true)}`);
  assert.equal(avgVolOf(d, true), wideVol(d.v.slice(-10).reduce((a, b) => a + b, 0) / 10, d.c.at(-1)!));
  assert.equal(turnoverOf(3e6, 600), 3e6 * 340, 'priced at ₹340 above it (avgVol is already scaled)');
  assert.equal(turnoverOf(3e6, 300), 9e8);
});

test('algo live wide: numpy\'s quantile and pandas\' median', () => {
  assert.equal(quantile([1, 2, 3, 4], 2 / 3), 3);
  assert.ok(Math.abs(quantile([0, 10, 5, 1], 2 / 3) - 5) < 1e-12);
  assert.ok(Math.abs(quantile([1, 2, 3, 4, 5], 0.4) - 2.6) < 1e-12);
  assert.equal(median([3, NaN, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Number.isNaN(median([NaN])));
});

test('algo live wide: the gate is hot above the top third of the last 250 days, only with 60 days of history', () => {
  const g = { days: 250, min: 60, q: 2 / 3 };
  assert.equal(hotAgainst(Array(59).fill(0), 5, g).hot, false, '59 days: off');
  assert.equal(hotAgainst(Array(60).fill(0), 5, g).hot, true);
  assert.equal(hotAgainst(Array(60).fill(0), 0, g).hot, false, 'equal to the bar is not above it');
  // only the last 250 days count: an old high history does not raise today's bar
  const past = [...Array(100).fill(50), ...Array(250).fill(1)];
  assert.equal(hotAgainst(past, 2, g).hot, true);
  // the same as Python's hot_days (tests/py/test_ml_wide.py's own case)
  const mk = [...Array(59).fill(0), 5, ...Array(40).fill(0), 0, 5, -1];
  const hot = mk.map((v, i) => hotAgainst(mk.slice(0, i), v, g).hot);
  assert.deepEqual([hot[59], hot[100], hot[101], hot[102]], [false, false, true, false]);
});

test('algo live wide: today\'s gate uses the model\'s history, then the days saved since, then the list\'s median 20-day move', () => {
  const history: [string, number][] = Array.from({ length: 300 }, (_, i) => [`2025-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, i % 3]);
  const m = { ...wideModel, gate: { ...wideModel.gate!, history } };
  const t = gateToday(m, {}, '2026-12-01', [1, 2, 3]);
  assert.equal(t.move, 2);
  assert.equal(t.hot, false, 'the bar of 0,1,2 repeating is 2 (not above it)');
  assert.equal(t.history, 250);
  // the days saved since the model's data ended count, later ones push the oldest out
  const saved = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`, -1]));
  const t2 = gateToday(m, saved, '2026-12-01', [0, 0.5]);
  assert.equal(t2.bar, -1);
  assert.equal(t2.hot, true);
  assert.equal(gateToday(m, { '2026-12-01': 99, '2027-01-01': 99 }, '2026-12-01', [1]).history, 250, 'today and later are never history');
  const none = gateFor(m, [{ symbol: 'A', securityId: '1', prevClose: 500, avgVol: 1 }], '2026-12-01', {});
  assert.equal(none?.move, null, 'no 20-day moves: unknown');
  assert.equal(gateFor({ ...m, gate: undefined }, [], '2026-12-01', {}), undefined, 'the narrow model has no gate');
});

test('algo live wide: the gate the live engine works out on the model\'s own history matches the hot days Python exported', () => {
  const vals = Array.from({ length: 320 }, (_, i) => Math.sin(i / 7) * 3 + (i % 11) / 5);
  const history: [string, number][] = vals.map((v, i) => [`d${String(i).padStart(3, '0')}`, v]);
  // Python's rule, written out here once more: the days with 250 past days in the export
  const want = vals.map((v, i) => (i >= 250 && v > quantile(vals.slice(i - 250, i), 2 / 3) ? `d${String(i).padStart(3, '0')}` : null)).filter((x): x is string => !!x);
  const r = hotOfHistory({ days: 250, min: 60, q: 2 / 3, history, hot: want });
  assert.equal(r.checked.length, 70);
  assert.deepEqual(r.hot, want);
  assert.ok(want.length > 0);
});

test('algo live wide: no trade on a hot or unknown gate day, none under the turnover floor, at most 3 a day', () => {
  const scored = [sc('A', 0.5), sc('B', 0.4, true), sc('C', 0.3), sc('D', 0.2), sc('E', 0.15)];
  assert.deepEqual(pick(wideModel, state({ gate: cool }), scored, 20).map((x) => x.symbol), ['A', 'C', 'D'], 'B is too thin; 3 a day');
  assert.deepEqual(pick(wideModel, state({ gate: { ...cool, hot: true } }), scored, 20), []);
  assert.deepEqual(pick(wideModel, state(), scored, 20), [], 'gate unknown: no trades');
  assert.deepEqual(pick(wideModel, state({ gate: { ...cool, move: null } }), scored, 20), []);
  assert.match(gateBlocks(wideModel, state({ gate: { ...cool, hot: true, move: 4.2 } }))!, /top third/);
  assert.equal(gateBlocks(wideModel, state({ gate: cool })), null);
  const narrow = { ...wideModel, universe: undefined, gate: undefined, rules: { ...wideModel.rules, cap: 2 } };
  assert.equal(gateBlocks(narrow, state()), null, 'the narrow model has no gate');
});

test('algo live wide: the order is sized as a position (rupees of stock), the narrow one still by risk', () => {
  const x: Scored = { symbol: 'TATAMOTORS', pred: 0.2, price: 712.4, adr: 21.3, above: true };
  const o = orderFor(wideModel, x, '2026-12-01', 30, '3456', 300, 150_000);
  assert.equal(o.qty, Math.floor(150_000 / 712.4));
  assert.equal(o.stop, onTick(712.4 + 0.5 * 21.3, 1));
  assert.equal(o.target, onTick(712.4 - 0.5 * 21.3, -1));
  assert.ok(o.qty * o.stop < 150_000 * 1.06, 'within a BOT_MAX_NOTIONAL of 6% above the position');
  const n = orderFor(wideModel, x, '2026-12-01', 30, '3456', 300);
  assert.equal(n.qty, sizeFor(300, n.stop - (712.4 - 0.05)), 'no position: sized by risk as before');
});

test('algo live wide: settings default to the narrow model; each version has its own model key', async () => {
  const mem = new Map<string, Buffer>();
  const store = { get: async (k: string) => mem.get(k), put: async (k: string, b: Buffer) => { mem.set(k, b); } };
  const s = await loadSettings(store as never);
  assert.deepEqual(s, { riskInr: 300, version: 'narrow', positionInr: POSITION_DEFAULT });
  mem.set('setups/live/settings.json', Buffer.from(JSON.stringify({ riskInr: 400, version: 'wide', positionInr: 5 })));
  const w = await loadSettings(store as never);
  assert.equal(w.version, 'wide'); assert.equal(w.riskInr, 400); assert.equal(w.positionInr, POSITION_DEFAULT, 'out of range: the default');
  assert.equal(modelKey('narrow'), MODEL_KEY);
  assert.equal(modelKey('wide'), WIDE_MODEL_KEY);
  assert.equal(versionOf(wideModel), 'wide');
  assert.equal(versionOf({ universe: undefined }), 'narrow', 'models before Dec 2026 are narrow');
  assert.equal(ret20dOf({ t: [], o: [], h: [], l: [], c: [1, 2], v: [] }), NaN);
});
