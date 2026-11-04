import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCurve, extremes, istMs, tradedRange, positionsFromRows, positionsKey, type PnlPosition } from '../lib/pnlCurve/curve';
import { exitSlippage, positionCards } from '../lib/pnlCurve/card';
import { curveKey, loadCurve } from '../lib/pnlCurve/store';
import { createImageContainer, createCarouselContainer } from '../lib/social/instagram';
import type { Candles } from '../lib/dhan';

const D = '2026-11-04';
const at = (hm: string) => istMs(D, hm);
function candles(rows: [string, number][]): Candles {
  const t = rows.map(([hm]) => at(`${hm}:00`) / 1000), c = rows.map(([, x]) => x);
  return { t, o: c, h: c, l: c, c, v: c.map(() => 1) };
}
const long = (symbol: string, charges = 40): PnlPosition => ({
  symbol, charges, fills: [{ t: at('09:30:10'), side: 'BUY', qty: 100, price: 100 }, { t: at('09:32:30'), side: 'SELL', qty: 100, price: 103 }],
});
const c1 = candles([['09:30', 101], ['09:31', 99], ['09:32', 103], ['09:33', 110]]);

test('curve: open position is marked at the minute close; closed stays flat, whatever the stock does later', () => {
  const v = buildCurve(D, [long('A')], { A: c1 });
  const i = (hm: string) => v.times.indexOf(at(`${hm}:00`));
  assert.equal(v.overall.gross[i('09:29')], 0);
  assert.equal(v.overall.gross[i('09:30')], 100);
  assert.equal(v.overall.gross[i('09:31')], -100);
  assert.equal(v.overall.gross[i('09:32')], 300);
  assert.equal(v.overall.gross[i('09:33')], 300);
  assert.equal(v.overall.gross.at(-1), 300);
  assert.equal(v.times[0], at('09:15:00'));
  assert.equal(v.times.at(-1), at('15:29:00'));
});

test('curve: net starts below zero on entry and ends exactly on gross minus charges', () => {
  const v = buildCurve(D, [long('A')], { A: c1 });
  const i = v.times.indexOf(at('09:30:00'));
  assert.ok(v.overall.net[i] < v.overall.gross[i]);
  assert.equal(v.overall.net.at(-1), 260);
});

test('curve: overall equals the sum of the positions at every minute', () => {
  const b: PnlPosition = { symbol: 'B', charges: 25, fills: [{ t: at('09:31:00'), side: 'SELL', qty: 50, price: 200 }, { t: at('10:00:00'), side: 'BUY', qty: 50, price: 190 }] };
  const v = buildCurve(D, [long('A'), b], { A: c1, B: candles([['09:31', 199], ['09:45', 205], ['10:00', 190]]) });
  v.times.forEach((_, m) => {
    for (const k of ['gross', 'net'] as const) assert.ok(Math.abs(v.overall[k][m] - (v.positions[0][k][m] + v.positions[1][k][m])) < 0.011);
  });
  assert.equal(v.positions[1].gross[v.times.indexOf(at('09:45:00'))], -250);
  assert.equal(v.overall.gross.at(-1), 800);
  assert.equal(v.overall.net.at(-1), 735);
});

test('curve: a running position stays open and the axis stops at now', () => {
  const p: PnlPosition = { symbol: 'A', charges: 10, fills: [{ t: at('09:30:10'), side: 'BUY', qty: 10, price: 100 }] };
  const v = buildCurve(D, [p], { A: c1 }, at('09:33:40'));
  assert.equal(v.times.at(-1), at('09:33:00'));
  assert.equal(v.positions[0].openQty, 10);
  assert.equal(v.overall.gross.at(-1), 100);
});

test('curve: missing candles fall back to the last known price, never to zero', () => {
  const v = buildCurve(D, [long('A')], {});
  assert.equal(v.overall.gross[v.times.indexOf(at('09:31:00'))], 0);
  assert.equal(v.overall.gross.at(-1), 300);
});

test('extremes finds the high and low with their times', () => {
  const v = buildCurve(D, [long('A')], { A: c1 });
  const e = extremes(v.overall.gross, v.times)!;
  assert.equal(e.high.value, 300); assert.equal(e.high.t, at('09:32:00'));
  assert.equal(e.low.value, -100); assert.equal(e.low.t, at('09:31:00'));
});

const row = (o: object) => ({ date: D, Symbol: 'FSL', TradeGroupId: 'g1', Direction: 'LONG', TotalCharges: '30', ...o });

test('journal rows: one position per stock, each trade\'s charges counted once', () => {
  const { positions, undrawable } = positionsFromRows(D, [
    row({ OrderType: 'BUY', Qty: '10', Price: '1,000.50', 'Time (IST)': '9:30:00' }),
    row({ OrderType: 'SELL', Qty: '10', Price: '1,010', 'Time (IST)': '09:40:00', ExitType: 'STOP', LastStop: '1012' }),
    row({ TradeGroupId: 'g2', TotalCharges: '20', OrderType: 'BUY', Qty: '5', Price: '1000', 'Time (IST)': '11:00:00' }),
    row({ date: '2026-11-03', OrderType: 'BUY', Qty: '1', Price: '1', 'Time (IST)': '09:30:00' }),
  ]);
  assert.deepEqual(undrawable, []);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].charges, 50);
  assert.equal(positions[0].fills.length, 3);
  assert.equal(positions[0].fills[0].price, 1000.5);
});

test('journal rows: a fill with no time makes the stock undrawable instead of a wrong curve', () => {
  const { positions, undrawable } = positionsFromRows(D, [row({ OrderType: 'BUY', Qty: '10', Price: '100', 'Time (IST)': '' })]);
  assert.deepEqual(positions, []);
  assert.deepEqual(undrawable, ['FSL']);
});

test('slippage: measured only against a real order price; positive means worse', () => {
  const order = (price: number) => [{ t: 0, price, side: 'SELL' as const, qty: 100, role: 'EXIT' as const }];
  const base = long('A');
  assert.deepEqual(exitSlippage({ ...base, exitType: 'STOP', lastStop: 100 }, order(99.8), 'LONG'), { kind: 'STOP', ref: 100, fill: 99.8, perShare: 0.2, inr: 20 });
  assert.equal(exitSlippage({ ...base, exitType: 'STOP', lastStop: 100 }, order(100.1), 'SHORT')?.inr, 10);
  assert.equal(exitSlippage({ ...base, exitType: 'TARGET', target: 105 }, order(105.2), 'LONG')?.inr, -20);
  assert.equal(exitSlippage({ ...base, exitType: 'MANUAL', lastStop: 100 }, order(99), 'LONG'), undefined);
  assert.equal(exitSlippage({ ...base, exitType: 'STOP' }, order(99), 'LONG'), undefined);
});

test('position card: size, averages, merged orders and P&L', () => {
  const p = { ...long('A'), direction: 'LONG' };
  p.fills = [{ t: at('09:30:10'), side: 'BUY', qty: 60, price: 100 }, { t: at('09:30:11'), side: 'BUY', qty: 40, price: 100.5 }, { t: at('09:32:30'), side: 'SELL', qty: 100, price: 103 }];
  const v = buildCurve(D, [p], { A: c1 });
  const [c] = positionCards(D, [p], v);
  assert.equal(c.qty, 100); assert.equal(c.direction, 'LONG');
  assert.ok(Math.abs(c.avgBuy! - 100.2) < 1e-9); assert.equal(c.avgSell, 103);
  assert.deepEqual(c.orders.map((o) => o.role), ['ENTRY', 'EXIT']);
  assert.equal(c.gross, 280); assert.equal(c.net, 240);
});

function memStore() {
  const m = new Map<string, Uint8Array>();
  return { m, get: async (k: string) => m.get(k), put: async (k: string, b: Uint8Array) => { m.set(k, b); } };
}
const after = () => at('18:00:00');

test('store: built once and saved after the close, then read from S3; edited fills draw it again', async () => {
  const s = memStore();
  const { minuteKey } = await import('../lib/candles/store');
  const { gzip } = await import('../lib/book/record');
  s.m.set(minuteKey('A', D), await gzip(JSON.stringify({ v: 1, kind: '1m', symbol: 'A', securityId: '1', date: D, savedAt: 1, c: c1 })));
  const deps = { store: s, lookupSecurityId: async () => '1', now: after };
  const first = await loadCurve(deps, D, [long('A')]);
  assert.equal(first.fromS3, false); assert.equal(first.saved, true);
  assert.ok(s.m.has(curveKey(D)));
  assert.equal(curveKey(D), 'pnl-curve/2026/november/2026-11-04.json.gz');
  const second = await loadCurve(deps, D, [long('A')]);
  assert.equal(second.fromS3, true);
  assert.deepEqual(second.curve, first.curve);
  const edited = long('A', 99);
  assert.notEqual(positionsKey([edited]), positionsKey([long('A')]));
  const third = await loadCurve(deps, D, [edited]);
  assert.equal(third.fromS3, false);
  assert.equal(third.curve.overall.net.at(-1), 201);
});

test('store: nothing is saved while the day is running', async () => {
  const s = memStore();
  const r = await loadCurve({ store: s, lookupSecurityId: async () => '1', now: () => at('11:00:00'), dhan: { intraday: async () => c1 } as never }, D, [long('A')]);
  assert.equal(r.live, true); assert.equal(r.saved, false);
  assert.equal(s.m.has(curveKey(D)), false);
});

test('Instagram: Story and carousel containers send what the API wants', async () => {
  const calls: URLSearchParams[] = [];
  const f = (async (_u: string, i: RequestInit) => { calls.push(i.body as URLSearchParams); return Response.json({ id: '7' }); }) as unknown as typeof fetch;
  await createImageContainer({ accessToken: 'a', userId: 'u', imageUrl: 'https://x/i.jpg', story: true, caption: 'ignored' }, f);
  assert.equal(calls[0].get('media_type'), 'STORIES'); assert.equal(calls[0].get('caption'), null);
  await createImageContainer({ accessToken: 'a', userId: 'u', imageUrl: 'https://x/i.jpg', carouselItem: true }, f);
  assert.equal(calls[1].get('is_carousel_item'), 'true'); assert.equal(calls[1].get('media_type'), null);
  await createCarouselContainer({ accessToken: 'a', userId: 'u', children: ['1', '2'], caption: 'c' }, f);
  assert.equal(calls[2].get('media_type'), 'CAROUSEL'); assert.equal(calls[2].get('children'), '1,2'); assert.equal(calls[2].get('caption'), 'c');
});

test('traded range: ends just after the last move, keeps a quiet gap between trades, starts just before the first', () => {
  const second: PnlPosition = { symbol: 'B', charges: 10, fills: [{ t: at('11:30:00'), side: 'BUY', qty: 10, price: 100 }, { t: at('12:15:00'), side: 'SELL', qty: 10, price: 101 }] };
  const first: PnlPosition = { symbol: 'A', charges: 10, fills: [{ t: at('09:30:10'), side: 'BUY', qty: 10, price: 100 }, { t: at('10:15:00'), side: 'SELL', qty: 10, price: 102 }] };
  const v = buildCurve(D, [first, second], {});
  const r = tradedRange(v);
  assert.equal(v.times[r.from], at('09:25:00'));
  assert.equal(v.times[r.to], at('12:20:00'));
});

test('traded range: a very short trade still gets a readable window; a running position runs to now', () => {
  const quick: PnlPosition = { symbol: 'A', charges: 0, fills: [{ t: at('10:00:10'), side: 'BUY', qty: 10, price: 100 }, { t: at('10:00:40'), side: 'SELL', qty: 10, price: 101 }] };
  const r = tradedRange(buildCurve(D, [quick], {}));
  assert.ok(r.to - r.from >= 10);
  const open: PnlPosition = { symbol: 'A', charges: 10, fills: [{ t: at('09:30:10'), side: 'BUY', qty: 10, price: 100 }] };
  const c = candles([['09:30', 101], ['09:31', 99], ['09:32', 103], ['09:33', 110], ['09:40', 120], ['09:50', 130]]);
  const o = buildCurve(D, [open], { A: c }, at('09:50:30'));
  assert.equal(tradedRange(o).to, o.times.length - 1);
});

import { dayHook, positionStats } from '../lib/pnlCurve/card';

const hookCurve = (net: number[]) => ({ date: D, times: net.map((_, i) => at('09:30:00') + i * 60_000), overall: { gross: net, net }, positions: [], charges: 20 });

test('the headline says the most striking true thing about the day', () => {
  assert.equal(dayHook(hookCurve([0, -150, 40, 200]), 'net'), 'Down ₹150 at the worst. Finished +₹200.');
  assert.equal(dayHook(hookCurve([0, 400, 100]), 'net'), 'Was up ₹400. Ended +₹100.');
  assert.equal(dayHook(hookCurve([0, 50, 120]), 'net'), '+₹120. Never went red.');
  assert.equal(dayHook(hookCurve([0, -50, -80]), 'net'), 'Lost ₹80. Logged anyway.');
  assert.equal(dayHook({ ...hookCurve([0, 50, 60]), charges: 40 }, 'net'), 'Made ₹60. Charges took ₹40.');
  const algo = [{ symbol: 'A', planInr: -300, myInr: 20, steppedIn: true }];
  assert.equal(dayHook(hookCurve([0, 20]), 'net', algo), 'The algo\'s plan: -₹300. What I did: +₹20.');
  // a small difference, or a trade left alone, is not the story
  assert.equal(dayHook(hookCurve([0, 50, 120]), 'net', [{ symbol: 'A', planInr: 100, myInr: 120, steppedIn: true }]), '+₹120. Never went red.');
  assert.equal(dayHook(hookCurve([0, 50, 120]), 'net', [{ symbol: 'A', planInr: -300, myInr: 120, steppedIn: false }]), '+₹120. Never went red.');
});

test('position stats: best, worst and time held only count while it was open', () => {
  const p = { ...long('A'), direction: 'LONG' };
  p.fills = [{ t: at('09:30:10'), side: 'BUY', qty: 100, price: 100 }, { t: at('09:32:30'), side: 'SELL', qty: 100, price: 103 }];
  const v = buildCurve(D, [p], { A: c1 });
  const [c] = positionCards(D, [p], v);
  const s = positionStats(c, v, 'gross');
  assert.equal(s.heldMin, 2);
  assert.equal(s.line.length, 3);
  assert.ok(s.best >= s.worst);
  assert.equal(s.best, Math.max(...s.line));
});
