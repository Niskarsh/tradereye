import test from 'node:test';
import assert from 'node:assert/strict';
import { BookModel } from '../lib/book/model';
import { detectExtreme, findPushes } from '../lib/book/extreme';
import type { DayContext } from '../lib/book/context';

const T0 = Date.parse('2026-10-19T11:30:00+05:30');
const r2 = (x: number) => Math.round(x * 100) / 100;
const ctx = (over: Partial<DayContext> = {}): DayContext => ({
  symbol: 'PFC', securityId: '1', at: T0, date: '2026-10-19', live: true, riskInr: 300,
  dayHigh: 310, dayLow: 300, poc: 305, atr10m: 1, stretchDir: 'UP', stretchRunPct: 80, niftyNowTrend: 'FLAT', niftyLast10Pct: -0.05, ...over,
});

/**
 * PFC-like: a 5000-share sell wall at 310.05 above the high. Push 1 to 309.90 on heavy buying, pullback to 309.30,
 * push 2 to 309.85 on lighter buying, then sellers take over and break 309.30.
 */
function scenario(opts: { noWall?: boolean; newHigh?: boolean } = {}) {
  const m = new BookModel();
  let vol = 1000, t = T0;
  const walls: Record<string, number> = opts.noWall ? {} : { '310.05': 5000 };
  const step = (p: number, side: 'BUY' | 'SELL', qty: number, dt = 2_000) => {
    t += dt;
    const bid = side === 'BUY' ? r2(p - 0.05) : p, ask = side === 'BUY' ? p : r2(p + 0.05);
    const lv = (x: number) => ({ price: r2(x), qty: walls[r2(x).toFixed(2)] ?? 100 + ((t / 1000) % 7), orders: 1 });
    m.onDepth({ securityId: '1', side: 'BID', levels: Array.from({ length: 20 }, (_, i) => lv(bid - i * 0.05)) }, t);
    const asks = Array.from({ length: 20 }, (_, i) => lv(ask + i * 0.05));
    if (!opts.noWall && !asks.some((a) => a.price === 310.05)) asks.push({ price: 310.05, qty: 5000, orders: 1 });
    m.onDepth({ securityId: '1', side: 'ASK', levels: asks }, t);
    vol += qty;
    m.onQuote({ securityId: '1', ltp: side === 'BUY' ? ask : bid, ltq: qty, ltt: 0, volume: vol, totalBuy: 0, totalSell: 0, dayHigh: 0, dayLow: 0 }, t);
  };
  // the wall is there from the start (needs 2+ minutes of age); price works up to the zone
  for (let p = 308.0; p <= 309.0; p = r2(p + 0.1)) step(p, 'BUY', 300, 10_000);
  for (let p = 309.1; p <= 309.9; p = r2(p + 0.1)) step(p, 'BUY', 900);          // push 1: heavy buying
  for (let p = 309.8; p >= 309.3; p = r2(p - 0.1)) step(p, 'SELL', 200);         // pullback to 309.30
  const top2 = opts.newHigh ? 310.0 : 309.85;
  for (let p = 309.4; p < top2; p = r2(p + 0.1)) step(p, 'BUY', 300);            // push 2: lighter buying
  step(top2, 'BUY', 300);
  for (let p = r2(top2 - 0.1); p >= 309.1; p = r2(p - 0.1)) step(p, 'SELL', 900); // sellers take over, break 309.30
  return { m, t };
}

test('findPushes: two pushes into the zone, the pullback between them, wiggles do not count as pushes', () => {
  const pts = [309, 309.5, 309.9, 309.7, 309.3, 309.35, 309.32, 309.6, 309.85, 309.6, 309.2].map((p, i) => ({ t: i * 1000, p }));
  const { pushes, inPush } = findPushes(pts, 'SHORT', 308.5, 0.2);
  assert.equal(inPush, false);
  assert.deepEqual(pushes.map((x) => [x.high, x.low]), [[309.9, 309.3], [309.85, 309.2]]);
});

test('day-high reversal: failed pushes under a sell wall, fading buying, sellers break the swing -> SHORT with a plan', () => {
  const { m, t } = scenario();
  const r = detectExtreme(m, ctx(), { high: 310, low: 300 }, t);
  assert.ok(r, 'expected an alert');
  assert.equal(r.side, 'SHORT');
  assert.equal(r.wall.price, 310.05);
  assert.equal(r.pushes.length, 2);
  assert.ok(r.pushes[1].aggr < r.pushes[0].aggr);
  assert.equal(r.breakLevel, 309.3);
  assert.equal(r.plan.target, 305);
  assert.ok(r.plan.stop > 310.05 && r.plan.stop - r.plan.entry <= 2);
  assert.equal(r.plan.qty, Math.floor(300 / r.plan.risk));
  assert.ok(r.plan.rr >= 1);
});

test('no alert: no wall, not stretched, Nifty running up, or the second push made a real new high', () => {
  { const { m, t } = scenario({ noWall: true }); assert.equal(detectExtreme(m, ctx(), { high: 310, low: 300 }, t), undefined, 'no wall'); }
  { const { m, t } = scenario(); assert.equal(detectExtreme(m, ctx({ stretchRunPct: 50 }), { high: 310, low: 300 }, t), undefined, 'not stretched'); }
  { const { m, t } = scenario(); assert.equal(detectExtreme(m, ctx({ niftyNowTrend: 'RISING', niftyLast10Pct: 0.2 }), { high: 310, low: 300 }, t), undefined, 'Nifty up'); }
  { const { m, t } = scenario({ newHigh: true }); assert.equal(detectExtreme(m, ctx(), { high: 310, low: 300 }, t), undefined, 'new high'); }
});

test('no alert when the POC is too close to be worth the stop', () => {
  const { m, t } = scenario();
  assert.equal(detectExtreme(m, ctx({ poc: 308.9 }), { high: 310, low: 300 }, t), undefined);
});
