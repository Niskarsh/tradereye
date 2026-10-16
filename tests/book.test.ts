import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDepth, parseFeed } from '../lib/book/feed';
import { BookModel } from '../lib/book/model';

function depthMsg(code: 41 | 51, secId: number, levels: [number, number][]): ArrayBuffer {
  const b = new ArrayBuffer(332); const dv = new DataView(b);
  dv.setInt16(0, 332, true); dv.setUint8(2, code); dv.setUint8(3, 1); dv.setInt32(4, secId, true);
  levels.forEach(([p, q], i) => { dv.setFloat64(12 + i * 16, p, true); dv.setUint32(20 + i * 16, q, true); dv.setUint32(24 + i * 16, 3, true); });
  return b;
}
function quote(secId: number, ltp: number, volume: number): ArrayBuffer {
  const b = new ArrayBuffer(50); const dv = new DataView(b);
  dv.setUint8(0, 4); dv.setInt16(1, 50, true); dv.setUint8(3, 1); dv.setInt32(4, secId, true);
  dv.setFloat32(8, ltp, true); dv.setInt16(12, 10, true); dv.setInt32(22, volume, true);
  return b;
}
const cat = (...bs: ArrayBuffer[]) => { const out = new Uint8Array(bs.reduce((s, b) => s + b.byteLength, 0)); let o = 0; for (const b of bs) { out.set(new Uint8Array(b), o); o += b.byteLength; } return out.buffer; };

test('parses back-to-back 20-level depth messages (bids 41, asks 51) and quote packets', () => {
  const m = parseDepth(cat(depthMsg(41, 11, [[258, 100], [257.95, 200]]), depthMsg(51, 11, [[258.05, 150], [265, 12000]])));
  assert.equal(m.length, 2);
  assert.deepEqual([m[0].side, m[0].levels.length, m[1].side, m[1].levels[1].qty], ['BID', 2, 'ASK', 12000]);
  const q = parseFeed(quote(11, 258.05, 5000));
  assert.equal(q[0].securityId, '11'); assert.equal(q[0].volume, 5000); assert.ok(Math.abs(q[0].ltp - 258.05) < 1e-3);
});

const asks = (extra: [number, number][] = []): [number, number][] => [[258.05, 100], [258.1, 120], [258.15, 90], [258.2, 110], ...extra];
const bids: [number, number][] = [[258, 100], [257.95, 130], [257.9, 80], [257.85, 100]];

test('a big level is a wall; traded into and still there = HOLDING; old levels are kept when price leaves the window', () => {
  const b = new BookModel(); let t = 1_000_000;
  b.onDepth({ securityId: '1', side: 'BID', levels: bids.map(([price, qty]) => ({ price, qty, orders: 1 })) }, t);
  b.onDepth({ securityId: '1', side: 'ASK', levels: asks([[258.3, 2000]]).map(([price, qty]) => ({ price, qty, orders: 1 })) }, t);
  b.onQuote({ securityId: '1', ltp: 258.05, ltq: 1, ltt: 0, volume: 1000, totalBuy: 0, totalSell: 0, dayHigh: 0, dayLow: 0 }, t);
  let w = b.walls(t).find((x) => x.price === 258.3)!;
  assert.equal(w.status, 'RESTING');
  // buyers trade 800 into 258.30, it is still there
  b.bestAsk = 258.3;
  b.onQuote({ securityId: '1', ltp: 258.3, ltq: 1, ltt: 0, volume: 1800, totalBuy: 0, totalSell: 0, dayHigh: 0, dayLow: 0 }, t += 1000);
  w = b.walls(t).find((x) => x.price === 258.3)!;
  assert.equal(w.status, 'HOLDING');
  // price moves down: a new window without 258.30; the old wall stays known (retained, not wiped)
  b.onDepth({ securityId: '1', side: 'ASK', levels: [[257.5, 100], [257.55, 90], [257.6, 120]].map(([price, qty]) => ({ price, qty, orders: 1 })) }, t += 1000);
  assert.equal(b.levels.get(25830)?.qty, 2000);
});

test('a wall that vanishes without being traded is PULLED; buying with no price progress is flagged as absorbed', () => {
  const b = new BookModel(); let t = 2_000_000;
  b.onDepth({ securityId: '1', side: 'BID', levels: bids.map(([price, qty]) => ({ price, qty, orders: 1 })) }, t);
  b.onDepth({ securityId: '1', side: 'ASK', levels: asks([[258.3, 2000]]).map(([price, qty]) => ({ price, qty, orders: 1 })) }, t);
  b.onDepth({ securityId: '1', side: 'ASK', levels: asks([[258.35, 90]]).map(([price, qty]) => ({ price, qty, orders: 1 })) }, t += 1000);
  assert.equal(b.endedWalls(t)[0]?.status, 'PULLED');
  b.bestAsk = 258.05;
  let v = 1000;
  for (let i = 0; i < 8; i++) b.onQuote({ securityId: '1', ltp: 258.05, ltq: 1, ltt: 0, volume: (v += 500), totalBuy: 0, totalSell: 0, dayHigh: 0, dayLow: 0 }, t += 2000);
  assert.equal(b.flow(t, 60).absorption, 'BUYING_ABSORBED');
  assert.match(b.summary(t), /BUYING ABSORBED/);
});
