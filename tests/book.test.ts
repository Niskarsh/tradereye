import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDepth, parseFeed } from '../lib/book/feed';
import { BookModel } from '../lib/book/model';
import { applyEvent, chunkKey, decodeLines, encodeLines, gunzip, gzip, keyframe, replayChunk, slotOf, slotsUpTo, KEY_RE, type Event } from '../lib/book/record';
import { cleanSymbols } from '../lib/book/ocr';

const T = (hms: string, date = '2026-10-16') => Date.parse(`${date}T${hms}+05:30`);
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
  assert.deepEqual([m[0].side, m[0].levels.length, m[1].side, m[1].levels[1].qty], ['BID', 2, 'ASK', 12000]);
  const q = parseFeed(quote(11, 258.05, 5000));
  assert.equal(q[0].volume, 5000); assert.ok(Math.abs(q[0].ltp - 258.05) < 1e-3);
});

const L = (xs: [number, number][]) => xs.map(([price, qty]) => ({ price, qty, orders: 1 }));
const bids: [number, number][] = [[258, 100], [257.95, 130], [257.9, 80], [257.85, 100]];
const asks = (extra: [number, number][] = []): [number, number][] => [[258.05, 100], [258.1, 120], [258.15, 90], [258.2, 110], ...extra];

test('walls: traded into and still there = HOLDING; old levels stay (as segments) after price leaves the window', () => {
  const b = new BookModel(); let t = T('10:00:00');
  b.onDepth({ securityId: '1', side: 'BID', levels: L(bids) }, t);
  b.onDepth({ securityId: '1', side: 'ASK', levels: L(asks([[258.3, 2000]])) }, t);
  b.onQuote({ securityId: '1', ltp: 258.05, ltq: 1, ltt: 0, volume: 1000, totalBuy: 0, totalSell: 0, dayHigh: 0, dayLow: 0 }, t);
  assert.equal(b.walls(t).find((x) => x.price === 258.3)?.status, 'RESTING');
  b.bestAsk = 258.3;
  b.onQuote({ securityId: '1', ltp: 258.3, ltq: 1, ltt: 0, volume: 1800, totalBuy: 0, totalSell: 0, dayHigh: 0, dayLow: 0 }, t += 1000);
  assert.equal(b.walls(t).find((x) => x.price === 258.3)?.status, 'HOLDING');
  b.onDepth({ securityId: '1', side: 'ASK', levels: L([[257.5, 100], [257.55, 90], [257.6, 120]]) }, t += 1000);
  const seg = b.segments.find((s) => s.p === 25830)!;
  assert.equal(seg.qty, 2000); assert.equal(seg.t1, undefined); // still drawn
  assert.ok(seg.seenTill < t);                                   // ...but not seen since: fades
});

test('a wall that disappears with little traded is PULLED, not "eaten"; heavy buying with no progress = absorbed', () => {
  const b = new BookModel(); let t = T('10:00:00');
  b.onDepth({ securityId: '1', side: 'BID', levels: L(bids) }, t);
  b.onDepth({ securityId: '1', side: 'ASK', levels: L(asks([[258.3, 2000]])) }, t);
  b.onDepth({ securityId: '1', side: 'ASK', levels: L(asks([[258.35, 90]])) }, t += 1000);
  assert.equal(b.endedWalls(t)[0]?.status, 'PULLED');
  // a bid wall that price passes through with almost nothing traded: also not "eaten"
  b.onDepth({ securityId: '1', side: 'BID', levels: L([[258, 100], [257.95, 2500], [257.9, 80], [257.85, 100]]) }, t += 1000);
  b.onDepth({ securityId: '1', side: 'ASK', levels: L([[257.95, 90], [258, 100], [258.05, 80]]) }, t += 1000);
  assert.ok(!b.endedWalls(t).some((w) => w.status === 'EATEN'));
  b.bestAsk = 258.05; let v = 1000;
  for (let i = 0; i < 8; i++) b.onQuote({ securityId: '1', ltp: 258.05, ltq: 1, ltt: 0, volume: (v += 500), totalBuy: 0, totalSell: 0, dayHigh: 0, dayLow: 0 }, t += 2000);
  assert.equal(b.flow(t, 60).absorption, 'BUYING_ABSORBED');
});

test('slots: 10 minutes aligned to 09:15, keys in order-book/<year>/<month>/<SYMBOL>_<date>/<slot>.gz', () => {
  assert.equal(slotOf(T('09:15:00')), '0915');
  assert.equal(slotOf(T('09:24:59')), '0915');
  assert.equal(slotOf(T('13:31:10')), '1325');
  assert.deepEqual(slotsUpTo('2026-10-16', T('09:40:00')), ['0915', '0925', '0935']);
  const k = chunkKey('taril', '2026-10-16', '1325');
  assert.equal(k, 'order-book/2026/october/TARIL_2026-10-16/1325.gz');
  assert.ok(KEY_RE.test(k)); assert.ok(!KEY_RE.test('screenshots/x.png'));
});

test('a chunk replays to exactly the live picture, and stands on its own from its keyframe', async () => {
  const live = new BookModel(); const events: Event[] = []; let t = T('10:00:00');
  const push = (e: Event) => { applyEvent(live, e, '1'); events.push(e); };
  push(['D', t, 'B', bids]); push(['D', t, 'A', asks([[258.3, 2000]])]); push(['Q', t, 258.05, 1000]);
  const key = keyframe(live, t);
  const later: Event[] = [['Q', t += 1000, 258.3, 1800], ['S', t += 4000, 'A'], ['D', t += 1000, 'A', asks([[258.3, 1500]])], ['Q', t += 500, 258.1, 2100]];
  for (const e of later) push(e);
  const text = encodeLines({ v: 1, symbol: 'X', securityId: '1', date: '2026-10-16', slot: '0955' }, key, later);
  const back = decodeLines(await gunzip(await gzip(text)));
  const replayed = new BookModel();
  replayChunk(replayed, back, '1');
  assert.equal(replayed.ltp, live.ltp);
  assert.deepEqual(replayed.walls(t).map((w) => [w.price, w.qty, w.status]), live.walls(t).map((w) => [w.price, w.qty, w.status]));
  assert.equal(replayed.flow(t, 60).buy, live.flow(t, 60).buy - 0); // trades after the keyframe match
});

test('screenshot reply -> unique tickers', () => {
  assert.deepEqual(cleanSymbols('{"symbols": ["TARIL", "hindpetro", "NSE:LTF", "TARIL"]}'), ['TARIL', 'HINDPETRO', 'LTF']);
  assert.deepEqual(cleanSymbols('Symbols: TARIL, LTF'), ['TARIL', 'LTF']);
});

test('bias: absorption first, then tape + book near price', () => {
  const b = new BookModel(); let t = T('11:00:00');
  b.onDepth({ securityId: '1', side: 'BID', levels: L([[258, 900], [257.95, 800], [257.9, 700]]) }, t);
  b.onDepth({ securityId: '1', side: 'ASK', levels: L([[258.05, 100], [258.1, 120], [258.15, 90]]) }, t);
  b.onQuote({ securityId: '1', ltp: 258.05, ltq: 1, ltt: 0, volume: 1000, totalBuy: 0, totalSell: 0, dayHigh: 0, dayLow: 0 }, t);
  let v = 1000;
  for (let i = 0; i < 3; i++) b.onQuote({ securityId: '1', ltp: 258.05 + i * 0.05, ltq: 1, ltt: 0, volume: (v += 300), totalBuy: 0, totalSell: 0, dayHigh: 0, dayLow: 0 }, t += 5000);
  assert.equal(b.bias(t).side, 'UP');
  assert.match(b.bias(t).why, /book near price/);
});

test('Dhan disconnect packets (code 50) are read on both feeds, with the reason in plain words', async () => {
  const { disconnectCode, disconnectReason } = await import('../lib/book/feed');
  const feed = new ArrayBuffer(10); const f = new DataView(feed); f.setUint8(0, 50); f.setInt16(1, 10, true); f.setInt16(8, 805, true);
  const depth = new ArrayBuffer(14); const d = new DataView(depth); d.setInt16(0, 14, true); d.setUint8(2, 50); d.setInt16(12, 807, true);
  assert.equal(disconnectCode(feed, 'feed'), 805);
  assert.equal(disconnectCode(depth, 'depth'), 807);
  assert.match(disconnectReason(805), /5 per account/);
  const q = new ArrayBuffer(50); new DataView(q).setUint8(0, 4);
  assert.equal(disconnectCode(q, 'feed'), undefined);
});
