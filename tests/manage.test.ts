import test from 'node:test';
import assert from 'node:assert/strict';
import { toSlots } from '../lib/setups/engine';
import { LATE_END, ride, WIDE_STOP_ADR } from '../lib/ml/grid';
import { manage, stage, variants, combo, type ManagedTrade, type Row, type Variant } from '../lib/ml/manage';
import { roundTripCharges, sizeFor } from '../lib/setups/costs';
import { onTick, TICK } from '../lib/study/mine';
import type { Bar } from '../lib/live/enrich';

const IST = 19800;
const sec = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 - IST;
/** a day whose closes follow px(k); each minute's high / low a tick or so around it */
function dayOf(px: (k: number) => number, wick = 0.05): NonNullable<ReturnType<typeof toSlots>> {
  const bars: Bar[] = [];
  for (let k = 0; k < 375; k++) { const c = Math.round(px(k) * 20) / 20, o = k ? Math.round(px(k - 1) * 20) / 20 : c; bars.push({ t: sec('2025-03-03', '09:15') + k * 60, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c, v: 1000 }); }
  return toSlots(bars)!;
}
const V = (id: string) => variants().find((v) => v.id === id)!;
const base: Variant = { id: 'base', family: 'base', label: '' };

test('manage: "as now" is exactly the label the model learned (random days)', () => {
  let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  let n = 0;
  for (let i = 0; i < 40; i++) {
    let p = 300; const path: number[] = [];
    for (let k = 0; k < 375; k++) { p += (rnd() - 0.5) * 0.9; path.push(p); }
    const day = dayOf((k) => path[k], 0.05 + rnd() * 0.2);
    for (const k of [20, 30, 50, 90]) for (const tAdr of [0.5, 0.75, 1]) {
      const close = day.c[k - 1], adr = 6;
      const want = ride(day, k, -1, close, onTick(close + WIDE_STOP_ADR * adr, 1), onTick(close - tAdr * adr, -1), LATE_END, 300).net;
      assert.equal(manage({ day, k, close, adr, targetAdr: tAdr }, base).net, want);
      n++;
    }
  }
  assert.ok(n > 400);
});

// a short at 300 (entry 299.95), stop 303 (½ of a 6-rupee daily range), target ½ range = 297
const T = (px: (k: number) => number, over: Partial<ManagedTrade> = {}): ManagedTrade => ({ day: dayOf(px), k: 20, close: 300, adr: 6, targetAdr: 0.5, ...over });

test('manage: break-even turns a full loss into a scratch', () => {
  // falls 1.8 (60% of the way to the target), then rallies through the stop
  const px = (k: number) => (k < 20 ? 300 : k < 60 ? 300 - (1.8 * (k - 20)) / 40 : 298.2 + (6 * (k - 60)) / 40);
  const now = manage(T(px), base), be = manage(T(px), V('be0.4'));
  assert.equal(now.how, 'stop'); assert.ok(now.net < -1);
  assert.equal(be.how, 'stop'); assert.ok(be.be && be.net > -0.2 && be.net < 0, `a scratch costs only ticks and charges: ${be.net}`);
});

test('manage: an add moves the stop to where the WHOLE position risks the budget, never to an entry', () => {
  // a straight slide to a 1x-range target (294): the add at 40% of the way to 297 (298.77) fills a tick lower
  const px = (k: number) => (k < 20 ? 300 : 300 - 0.03 * (k - 20));
  const rule = V('a1-m0.4-x1-b1-tx1-r1');
  const out = manage(T(px), rule);
  assert.equal(out.adds, 1); assert.equal(out.how, 'target');
  const E = 299.95, stop0 = 303, dist = stop0 - E, q = sizeFor(300, dist), A = Math.round((299.95 + (297 - 299.95) * 0.4) * 1e6) / 1e6 - TICK;
  // stop for both: total loss at the stop = 1R  ->  (q*E + q*A + 1R) / 2q, rounded up to a tick
  const st = onTick((q * E + q * A + q * dist) / (2 * q), 1);
  assert.ok(st < stop0 && st > A + 1, `the add has room: stop ${st} vs add ${A}`);
  const exit = 294;
  const want = (q * (E - exit) - roundTripCharges(q, E, exit, -1) + q * (A - exit) - roundTripCharges(q, A, exit, -1)) / (q * dist);
  assert.ok(Math.abs(out.net - want) < 0.002, `${out.net} vs ${want}`);
  // the same move, stopped right after the add: the whole position loses about the budget (1R) plus ticks and charges
  const back = (k: number) => (k < 20 ? 300 : k < 60 ? 300 - 0.03 * (k - 20) : 298.8 + 0.1 * (k - 60));
  const lost = manage(T(back), rule);
  assert.equal(lost.adds, 1); assert.equal(lost.how, 'stop');
  assert.ok(lost.net < -1 && lost.net > -1.35, `about 1R plus two sets of ticks and charges: ${lost.net}`);
  const zero = manage(T(back), V('a1-m0.4-x1-b0-tx1-r1'));
  assert.ok(zero.net > -0.3 && zero.net < 0, `budget 0: a scratch on both, i.e. two sets of ticks and charges ${zero.net}`);
});

test('manage: no room, no add (near the target, or a budget stop that would sit on the market)', () => {
  // at 60% of the way to a ½-range target there is not 1.5x the stop room left with a 1R budget and same size
  const px = (k: number) => (k < 20 ? 300 : 300 - 0.03 * (k - 20));
  const out = manage(T(px), V('a1-m0.6-x1-b1-tkeep-r1.5'));
  assert.equal(out.adds, 0);
  assert.equal(out.net, manage(T(px), base).net, 'skipped add = the trade as now');
  // moving the target to 1x the range leaves room for the same add
  assert.equal(manage(T(px), V('a1-m0.6-x1-b1-tx1-r1.5')).adds, 1);
});

test('manage: a pullback add waits for the bounce and the re-break; a straight slide never pulls back', () => {
  const straight = (k: number) => (k < 20 ? 300 : 300 - 0.02 * (k - 20));
  assert.equal(manage(T(straight, { targetAdr: 1 }), V('a1-p0.4-x1-b1-tkeep-r1')).adds, 0);
  // down past the trigger (40% of 6 = 2.4 below), bounce 0.8 (> 0.2R = 0.6), then down again
  const pb = (k: number) => (k < 20 ? 300 : k < 60 ? 300 - (2.8 * (k - 20)) / 40 : k < 80 ? 297.2 + (0.9 * (k - 60)) / 20 : 298.1 - 0.03 * (k - 80));
  const out = manage(T(pb, { targetAdr: 1 }), V('a1-p0.4-x1-b1-tkeep-r1'));
  assert.equal(out.adds, 1);
  assert.equal(manage(T(pb, { targetAdr: 1 }), V('a1-m0.4-x1-b1-tkeep-r1')).adds, 1);
});

test('manage: adding twice adds again when the move leaves room, with one stop for all three', () => {
  const px = (k: number) => (k < 20 ? 300 : 300 - 0.02 * (k - 20));
  const tr = T(px, { targetAdr: 1 });
  const once = manage(tr, V('a1-m0.4-x0.5-b0-tx1.5-r1'));
  const twice = manage(tr, V('a2r-m0.4-x0.5-b0-tx1.5-r1'));
  assert.equal(once.adds, 1); assert.equal(twice.adds, 2);
  assert.ok(twice.net > once.net && once.net > manage(tr, base).net, 'a clean run: more adds, more profit');
  // halfway to a 1x target leaves too little for a second add with that much room: it is skipped
  assert.equal(manage(tr, V('a2h-m0.4-x0.5-b0-tkeep-r1.5')).adds, 1);
  // straight back up after the first add: one shared stop, and with budget 0 the whole position about scratches
  const back = (k: number) => (k < 20 ? 300 : k < 140 ? 300 - 0.02 * (k - 20) : 297.6 + 0.1 * (k - 140));
  const lost = manage(T(back, { targetAdr: 1 }), V('a2r-m0.4-x0.5-b0-tx1.5-r1'));
  assert.equal(lost.how, 'stop'); assert.ok(lost.net > -0.35 && lost.net < 0.1, `${lost.net}`);
});

test('stage: components picked on the first half, combinations judged on the second half only', () => {
  const all = variants();
  const months = Array.from({ length: 20 }, (_, i) => `2024-${String((i % 12) + 1).padStart(2, '0')}`.replace('2024', i < 12 ? '2024' : '2025'));
  const rows: Row[] = [];
  for (const m of months) for (let i = 0; i < 30; i++) {
    const net: Record<string, number> = {}, adds: Record<string, number> = {};
    for (const v of all) { net[v.id] = Math.sin(i * 7 + m.length) * 0.5; adds[v.id] = 0; }
    // in the first half, one add rule looks great; in the second half, only break-even 0.6 helps
    if (m < '2024-11') net['a1-m0.4-x1-b1-tkeep-r1'] += 0.3;
    else net['be0.6'] += 0.2;
    rows.push({ month: m, net, adds });
  }
  const st = stage(rows, all, (be, as) => as.map((a) => { const c = combo(be, a); for (const r of rows) { r.net[c.id] = r.net.base; r.adds[c.id] = 0; } return c; }));
  assert.ok(st.picked.includes('a1-m0.4-x1-b1-tkeep-r1'), 'stage 1 picked the first-half winner');
  const l = st.stage2.find((x) => x.id === 'a1-m0.4-x1-b1-tkeep-r1')!;
  assert.ok(Math.abs(l.diff) < 1e-9, 'and stage 2 shows it adds nothing on the second half');
  assert.ok(st.half2[0] > st.half1[1] && st.nHalf1 + st.nHalf2 === rows.length);
});

import { manageAll } from '../lib/ml/manageRun';
import { dailyKey, monthKey, putJson } from '../lib/setups/store';
import type { Candles } from '../lib/dhan';

test('manageAll: reads each trade day from S3, "as now" matches the model\'s result, exam months never enter', async () => {
  const mem = new Map<string, Uint8Array>();
  const store = { get: async (k: string) => mem.get(k), put: async (k: string, b: Uint8Array) => { mem.set(k, b); } };
  // 30 trading days in Jan-Feb 2025 for one stock; 15 daily candles before them with a 6-rupee range
  const daily: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < 15; i++) { daily.t.push(Date.parse(`2024-12-${String(i + 1).padStart(2, '0')}T00:00:00Z`) / 1000 - 19800); daily.o.push(300); daily.h.push(303); daily.l.push(297); daily.c.push(300); daily.v.push(1e6); }
  await putJson(store, dailyKey('ABC'), { v: 1, c: daily });
  const trades: (string | number)[][] = [];
  let s = 3;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (const month of ['2025-01', '2025-02', '2026-06']) {
    const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
    for (let dd = 2; dd <= 12; dd++) {
      const date = `${month}-${String(dd).padStart(2, '0')}`;
      let p = 300;
      for (let k = 0; k < 375; k++) { const o = p; p = Math.round((p + (rnd() - 0.52) * 0.8) * 20) / 20; c.t.push(sec(date, '09:15') + k * 60); c.o.push(o); c.h.push(Math.max(o, p) + 0.05); c.l.push(Math.min(o, p) - 0.05); c.c.push(p); c.v.push(1000); }
      const day = toSlots(c.t.slice(-375).map((t, i) => ({ t, o: c.o.at(-375 + i)!, h: c.h.at(-375 + i)!, l: c.l.at(-375 + i)!, c: c.c.at(-375 + i)!, v: 1000 })))!;
      const close = day.c[19];
      const net = ride(day, 20, -1, close, onTick(close + 3, 1), onTick(close - 3, -1), LATE_END, 300).net;
      trades.push([date, 'ABC', '09:35', -1, 0.1, net, 0, 0, 0]);
    }
    await putJson(store, monthKey('ABC', month), { v: 1, complete: true, c });
  }
  const out = await manageAll({ examFrom: '2026-05', strategies: [{ id: 'shortNear', name: 'F', targetAdr: 0.5, tradeCols: ['day', 'sym', 'time', 'side', 'pred', 'net', 'gross', 'p1', 'p3'], trades }] }, store);
  assert.equal(out.length, 1);
  const m = out[0];
  assert.equal(m.trades, 22, 'the exam month (2026-06) never enters');
  assert.equal(m.baseMismatch, 0, '"as now" replays exactly the model\'s results');
  assert.equal(m.baseChecked, 22);
  assert.ok(m.stage1.length === variants().length && m.stage2.length >= 2 && m.winner);
});

import { confirmAll, CONFIRM } from '../lib/ml/manageRun';

test('confirmAll: the fixed rule and "as now" on decide, exam, untouched and shadow trades; nothing chosen', async () => {
  const mem = new Map<string, Uint8Array>();
  const store = { get: async (k: string) => mem.get(k), put: async (k: string, b: Uint8Array) => { mem.set(k, b); } };
  const daily: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < 15; i++) { daily.t.push(Date.parse(`2021-12-${String(i + 1).padStart(2, '0')}T00:00:00Z`) / 1000 - 19800); daily.o.push(300); daily.h.push(303); daily.l.push(297); daily.c.push(300); daily.v.push(1e6); }
  await putJson(store, dailyKey('XYZ'), { v: 1, c: daily });
  let s = 11;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const byMonth: Record<string, (string | number)[][]> = {};
  for (const month of ['2022-03', '2025-01', '2026-06', '2026-12']) {
    const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
    byMonth[month] = [];
    for (let dd = 2; dd <= 12; dd++) {
      const date = `${month}-${String(dd).padStart(2, '0')}`;
      let p = 300;
      const start = c.t.length;
      for (let k = 0; k < 375; k++) { const o = p; p = Math.round((p + (rnd() - 0.53) * 0.8) * 20) / 20; c.t.push(sec(date, '09:15') + k * 60); c.o.push(o); c.h.push(Math.max(o, p) + 0.05); c.l.push(Math.min(o, p) - 0.05); c.c.push(p); c.v.push(1000); }
      const day = toSlots(c.t.slice(start).map((t, i) => ({ t, o: c.o[start + i], h: c.h[start + i], l: c.l[start + i], c: c.c[start + i], v: 1000 })))!;
      const close = day.c[19];
      const net = ride(day, 20, -1, close, onTick(close + 3, 1), onTick(close - 4.5, -1), LATE_END, 300).net;
      byMonth[month].push([date, 'XYZ', '09:35', -1, 0.1, net, 0, 0, 0]);
    }
    await putJson(store, monthKey('XYZ', month), { v: 1, complete: true, c });
  }
  const cols = ['day', 'sym', 'time', 'side', 'pred', 'net', 'gross', 'p1', 'p3'];
  const out = await confirmAll({
    examFrom: '2026-05', shadowFrom: '2026-11',
    strategies: [{ id: 'wideShort', name: 'B', targetAdr: 0.75, tradeCols: cols, trades: [...byMonth['2025-01'], ...byMonth['2026-06'], ...byMonth['2026-12']] }],
    untouched: [{ id: 'wideShort', name: 'B', targetAdr: 0.75, tradeCols: cols, trades: byMonth['2022-03'] }],
  }, store);
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.rule, CONFIRM.wideShort);
  assert.equal(c.baseMismatch, 0, '"as now" replays the model\'s results exactly');
  assert.equal(c.decide.n, 11); assert.equal(c.untouched?.n, 11); assert.equal(c.shadow?.n, 11); assert.equal(c.exam.n, 11);
  assert.ok(Math.abs(c.decide.diff - (c.decide.rule - c.decide.base)) < 0.002);
});
