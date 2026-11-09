import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BookModel } from '../lib/book/model';
import { nextClose, pnlAt, situation, type OpenPosition } from '../lib/book/situation';
import { openPositions } from '../lib/book/positions';

const OPEN = Date.parse('2026-11-09T09:15:00+05:30');
const L = (bid: number, ask: number, bq = 200, aq = 200) => [{ side: 'BID' as const, levels: [{ price: bid, qty: bq, orders: 1 }, { price: Math.round((bid - 0.1) * 100) / 100, qty: 100, orders: 1 }] }, { side: 'ASK' as const, levels: [{ price: ask, qty: aq, orders: 1 }, { price: Math.round((ask + 0.1) * 100) / 100, qty: 100, orders: 1 }] }];

/** Plays candles: each entry is [mid at the end of the candle, share of volume that is aggressive buying]. */
function play(m: BookModel, path: [number, number][], from = OPEN, start = path[0][0], atp?: (mid: number) => number, each?: (t: number) => void) {
  let v = (m as unknown as { lastVolume: number }).lastVolume || 1000, mid = start, t = from;
  path.forEach(([to, buyShare], k) => {
    const steps = 60, stepMs = 10_000;
    for (let i = 0; i < steps; i++) {
      const cur = Math.round((mid + ((to - mid) * (i + 1)) / steps) * 20) / 20;
      const bid = Math.round((cur - 0.05) * 100) / 100, ask = Math.round((cur + 0.05) * 100) / 100;
      const flick = i % 2 ? 1200 : 40; // the resting book flips hard every step, as it does live
      for (const s of L(bid, ask, flick, 1240 - flick)) m.onDepth({ securityId: '1', side: s.side, levels: s.levels }, t);
      const buy = (i * 7 + k * 3) % 100 < buyShare * 100;
      m.onQuote({ securityId: '1', ltp: buy ? ask : bid, ltq: 1, ltt: 0, volume: (v += 100), totalBuy: 0, totalSell: 0, dayHigh: 0, dayLow: 0, atp: atp?.(cur) }, t);
      each?.(t);
      t += stepMs;
    }
    mid = to;
  });
  return { t, v };
}
const fall = (n: number, from: number, step: number, share = 0.3): [number, number][] => Array.from({ length: n }, (_, i) => [from - step * (i + 1), share]);

test('falling hour with selling, below VWAP: Sellers ahead', () => {
  const m = new BookModel();
  const { t } = play(m, fall(8, 330, 0.6), OPEN, 330, () => 331);
  const s = situation(m, t);
  assert.equal(s.stance, -1);
  assert.equal(s.label, 'Sellers ahead');
  assert.match(s.structure, /falling/);
  assert.match(s.flow, /sellers \d+% of the volume/);
  assert.match(s.vwap!, /below VWAP 331/);
  assert.ok(s.changeAbove! > 325 && s.changeBelow === undefined);
});

test('it cannot change between 10-minute closes, however hard the book flips', () => {
  const m = new BookModel();
  const { t, v } = play(m, fall(8, 330, 0.6), OPEN, 330, () => 331);
  (m as unknown as { lastVolume: number }).lastVolume = v;
  const seen = new Set<string>();
  // a violent mixed candle: the "right now" label moves, the slow read must not until the candle closes
  const right = new Set<string>();
  play(m, [[325.6, 0.9]], t, 325.2, () => 331, (at) => { const s = situation(m, at); if (at < t + 590_000) { seen.add(s.label + s.since); right.add(m.bias(at).label); } });
  assert.equal(seen.size, 1, [...seen].join(' | '));
  assert.ok(right.size >= 1);
});

test('a single opposite close does not flip it; two change it; a close above the defended high ends the lead at once', () => {
  const base = () => { const m = new BookModel(); return { m, r: play(m, fall(8, 330, 0.6), OPEN, 330, () => 331) }; };
  const a = base(); (a.m as unknown as { lastVolume: number }).lastVolume = a.r.v;
  const one = play(a.m, [[325.3, 0.55]], a.r.t, 325.2, () => 331);
  const s1 = situation(a.m, one.t);
  assert.equal(s1.stance, -1);
  const b = base();
  const two = play(b.m, [[326.2, 0.85], [326.4, 0.85]], b.r.t, 325.2, () => 325.5);
  assert.equal(situation(b.m, two.t).stance, 0, 'lead ended by the close above the last highs');
  const three = play(b.m, [[326.9, 0.85], [327.4, 0.85]], two.t, 326.4, () => 325.5);
  assert.equal(situation(b.m, three.t).stance, 1, 'buyers after they held for two closes');
});

test('with a short open it says whether the read is with or against it, and how it has gone since entry', () => {
  const m = new BookModel();
  const { t } = play(m, fall(8, 330, 0.6), OPEN, 330, () => 331);
  const pos: OpenPosition = { symbol: 'X', securityId: '1', direction: 'SHORT', qty: 40, avgCost: 329, entryTs: OPEN + 15 * 60_000, stop: 334, target: 320 };
  const s = situation(m, t, pos);
  assert.equal(s.forYou, 'with');
  assert.match(s.sinceEntry!, /price down 1\.\d%/);
  assert.match(s.sinceEntry!, /of \d+ closes on your side of VWAP/);
  assert.equal(situation(m, t, { ...pos, direction: 'LONG' }).forYou, 'against');
});

test('not enough candles: says so instead of guessing; a day without VWAP still reads', () => {
  const m = new BookModel();
  const short = play(m, fall(2, 330, 0.6), OPEN, 330);
  assert.match(situation(m, short.t).building!, /has 2/);
  const n = new BookModel();
  const { t } = play(n, fall(8, 330, 0.6), OPEN, 330);
  assert.equal(situation(n, t).stance, -1);
  assert.equal(situation(n, t).vwap, undefined);
});

test('open positions come with the stop and target resting at Dhan', () => {
  const trade = { exchangeTradeId: 't1', orderId: 'o1', tradingSymbol: 'PARAGMILK', securityId: '11', exchangeSegment: 'NSE_EQ', transactionType: 'SELL', tradedQuantity: 40, tradedPrice: 327.05, exchangeTime: '2026-11-09 09:45:10', createTime: '2026-11-09 09:45:10', updateTime: '2026-11-09 09:45:10' };
  const closedTrades = [{ ...trade, exchangeTradeId: 't2', tradingSymbol: 'ABC', securityId: '12' }, { ...trade, exchangeTradeId: 't3', tradingSymbol: 'ABC', securityId: '12', transactionType: 'BUY', exchangeTime: '2026-11-09 09:50:10' }];
  const order = (id: string, type: string, price: number, trigger: number) => ({ orderId: id, tradingSymbol: 'PARAGMILK', securityId: '11', exchangeSegment: 'NSE_EQ', transactionType: 'BUY', orderType: type, orderStatus: 'PENDING', price, triggerPrice: trigger, quantity: 40, filledQty: 0, createTime: '2026-11-09 09:46:00', updateTime: '2026-11-09 09:46:00' });
  const ps = openPositions([trade, ...closedTrades], [order('s', 'STOP_LOSS_MARKET', 0, 334.55), order('t', 'LIMIT', 318, 0)], []);
  assert.equal(ps.length, 1);
  assert.deepEqual([ps[0].symbol, ps[0].direction, ps[0].qty, ps[0].avgCost, ps[0].stop, ps[0].target], ['PARAGMILK', 'SHORT', 40, 327.05, 334.55, 318]);
});

const baseTrade = { exchangeTradeId: 't1', orderId: 'o1', tradingSymbol: 'PARAGMILK', securityId: '11', exchangeSegment: 'NSE_EQ', transactionType: 'SELL', tradedQuantity: 40, tradedPrice: 327.05, createTime: '2026-11-09 09:45:10' };
const pendingOrder = (id: string, type: string, price: number, trigger: number, status = 'PENDING') => ({ orderId: id, tradingSymbol: 'PARAGMILK', securityId: '11', exchangeSegment: 'NSE_EQ', transactionType: 'BUY', orderType: type, orderStatus: status, price, triggerPrice: trigger, quantity: 40, filledQty: 0, createTime: '2026-11-09 09:46:00', updateTime: '2026-11-09 09:46:00' });

test('a target the plain pending check misses is still found, the way the Live tab finds it', () => {
  // a status outside the usual pending list; a limit that echoes a trigger
  const odd = openPositions([baseTrade], [pendingOrder('t', 'LIMIT', 318, 0, 'TRIGGERED')], []);
  assert.equal(odd[0].target, 318);
  const echo = openPositions([baseTrade], [pendingOrder('t', 'LIMIT', 318, 318)], []);
  assert.equal(echo[0].target, 318);
  // cancelled: no longer a target
  assert.equal(openPositions([baseTrade], [pendingOrder('t', 'LIMIT', 318, 0, 'CANCELLED')], [])[0].target, undefined);
  // a bracket's legs from the super-order list
  const sup = [{ orderId: 'E1', orderStatus: 'TRADED', transactionType: 'SELL', orderType: 'MARKET', tradingSymbol: 'PARAGMILK', securityId: '11', exchangeSegment: 'NSE_EQ', quantity: 40, createTime: '2026-11-09 09:45:00', updateTime: '2026-11-09 09:45:10', legDetails: [
    { orderId: 'E1', legName: 'STOP_LOSS_LEG', transactionType: 'BUY', price: 334.55, orderStatus: 'PENDING', remainingQuantity: 40 },
    { orderId: 'E1', legName: 'TARGET_LEG', transactionType: 'BUY', price: 318, orderStatus: 'PENDING', remainingQuantity: 40 } ] }];
  const b = openPositions([baseTrade], [], sup);
  assert.deepEqual([b[0].stop, b[0].target], [334.55, 318]);
});

test('a leg Dhan no longer lists comes from the saved order log', () => {
  const known = new Map([['L', { orderId: 'L', status: 'PENDING', side: 'BUY' as const, kind: 'LIMIT' as const, legNo: 3, symbol: 'PARAGMILK', securityId: '11', segment: 'NSE_EQ', product: 'INTRADAY', triggerPrice: 0, price: 318, qty: 40, filledQty: 0, createTime: '2026-11-09 09:46:00', updateTime: '2026-11-09 09:46:00', history: [{ ts: Date.parse('2026-11-09T09:46:00+05:30'), status: 'PENDING', trigger: 0, price: 318, qty: 40, filled: 0 }], version: 1, src: 'POLL' }]]);
  assert.equal(openPositions([baseTrade], [], [], known)[0].target, 318);
});

test('P&L before and after charges, with part exits booked', () => {
  const p: OpenPosition = { symbol: 'X', securityId: '1', direction: 'SHORT', qty: 40, avgCost: 327.05, entryTs: 0, sellVal: 13082, buyVal: 0, realized: 0 };
  const at = pnlAt(p, 325);
  assert.equal(at.gross, 82);
  assert.ok(at.net < at.gross && at.gross - at.net > 10 && at.gross - at.net < 20, String(at.net));
  assert.equal(pnlAt({ ...p, qty: 20, realized: 50 }, 325).gross, 91);
  assert.equal(pnlAt({ ...p, direction: 'LONG', buyVal: 13082, sellVal: 0 }, 325).gross, -82);
  assert.equal(nextClose(Date.parse('2026-11-09T14:17:30+05:30')), Date.parse('2026-11-09T14:25:00+05:30'));
});

