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

/* ---- the numbers behind "who is in control" (Nov 2026 audit, from a live PARAGMILK screen) ---- */
const Qm = (ltp: number, volume: number, extra: Record<string, number> = {}) => ({ securityId: '1', ltp, ltq: 1, ltt: 0, volume, totalBuy: 0, totalSell: 0, dayHigh: 0, dayLow: 0, ...extra });
const seed = (b: BookModel, bidL: [number, number][], askL: [number, number][], t: number) => { b.onDepth({ securityId: '1', side: 'BID', levels: L(bidL) }, t); b.onDepth({ securityId: '1', side: 'ASK', levels: L(askL) }, t); };

test('wide spread on a 1-paisa stock: the book compares both sides from their own best price, never "976 vs 0"', () => {
  const b = new BookModel(); const t = T('09:56:00');
  seed(b, [[327.1, 217], [327.09, 200], [327.08, 180], [327.05, 190], [327.0, 189]], [[327.68, 257], [327.7, 190], [327.75, 170], [327.95, 261], [328, 410]], t);
  b.onQuote(Qm(327.12, 1000), t);
  const near = b.nearBook(t);
  assert.equal(near.bidQ, 976);
  assert.equal(near.askQ, 1288); // was 0: every offer is more than 10 paise above the last price
  assert.match(b.bias(t).why, /976 to buy vs 1\.3k to sell/);
  // the same screen's tape (14.8k bought, 8.9k sold) with an honest book is not "Buyers in control"
  const screen = new BookModel(); let at = T('09:47:00'), v = 1000;
  seed(screen, [[326.1, 217], [326.09, 200], [326.08, 180], [326.05, 190], [326, 189]], [[326.68, 257], [326.7, 190], [326.75, 170], [326.95, 261], [327, 410]], at);
  screen.onQuote(Qm(326.68, v), at);
  for (let i = 1; i <= 36; i++) {
    at += 15_000;
    const up = Math.min(i * 0.2, 1); // the move is all in the first minute and a bit, then it sits
    seed(screen, [[326.1 + up, 217], [326.09 + up, 200], [326.08 + up, 180], [326.05 + up, 190], [326 + up, 189]], [[326.68 + up, 257], [326.7 + up, 190], [326.75 + up, 170], [326.95 + up, 261], [327 + up, 410]], at);
    if (i % 5 === 3) screen.onQuote(Qm(326.1 + up, v += 1270), at); else screen.onQuote(Qm(326.68 + up, v += 510), at);
  }
  const f = screen.flow(at, 600);
  assert.deepEqual([f.buy, f.sell], [14790, 8890]);
  assert.equal(screen.bias(at).label, 'Balanced');
});

test('the old best bid / offer is gone when the best moves away: no phantom level or wall', () => {
  const b = new BookModel(); let t = T('10:00:00');
  seed(b, [[100, 5000], [99.9, 100], [99.8, 100], [99.7, 100]], [[100.2, 100], [100.3, 100], [100.4, 100]], t);
  assert.ok(b.walls(t).some((w) => w.price === 100 && w.side === 'BID'));
  b.onDepth({ securityId: '1', side: 'BID', levels: L([[99.9, 100], [99.8, 100], [99.7, 100]]) }, t += 1000);
  assert.equal(b.levels.get(10000)?.qty, 0);
  assert.ok(!b.walls(t).some((w) => w.price === 100));
  assert.equal(b.endedWalls(t).filter((w) => w.price === 100).length, 1);
});

test('volume missed during a silence is not booked as one huge trade', () => {
  const b = new BookModel(); let t = T('10:00:00');
  seed(b, bids, asks(), t);
  b.onQuote(Qm(258.05, 1000), t);
  b.onQuote(Qm(258.05, 90000), t += 20 * 60_000);
  assert.equal(b.flow(t, 600).buy + b.flow(t, 600).sell, 0);
  b.onQuote(Qm(258.05, 90100), t += 1000);
  assert.equal(b.flow(t, 600).buy, 100);
});

test('trades between bid and ask go to the nearer side; exactly in the middle, to the direction of the price change', () => {
  const b = new BookModel(); let t = T('10:00:00');
  seed(b, [[100, 100], [99.99, 100]], [[100.5, 100], [100.51, 100]], t);
  b.onQuote(Qm(100, 1000), t);
  b.onQuote(Qm(100.4, 1100), t += 1000);            // nearer the ask: buyer
  assert.deepEqual([b.flow(t, 60).buy, b.flow(t, 60).sell], [100, 0]);
  b.onQuote(Qm(100.1, 1300), t += 1000);            // nearer the bid: seller
  assert.deepEqual([b.flow(t, 60).buy, b.flow(t, 60).sell], [100, 200]);
  b.onQuote(Qm(100.25, 1400), t += 1000);           // the middle, price went up: buyer
  assert.deepEqual([b.flow(t, 60).buy, b.flow(t, 60).sell], [200, 200]);
});

test('a wall that really traded away is EATEN whichever feed reported first', () => {
  const run = (depthFirst: boolean) => {
    const b = new BookModel(); let t = T('10:00:00');
    seed(b, [[100, 2000], [99.95, 100], [99.9, 100], [99.85, 100]], [[100.05, 100], [100.1, 100], [100.15, 100]], t);
    b.onQuote(Qm(100, 1000), t); t += 1000;
    const gone = () => b.onDepth({ securityId: '1', side: 'BID', levels: L([[99.95, 100], [99.9, 100], [99.85, 100]]) }, t);
    const print = () => b.onQuote(Qm(99.95, 3000), t + 200);
    if (depthFirst) { gone(); print(); } else { print(); gone(); }
    return b.endedWalls(t + 500).find((w) => w.price === 100)?.status;
  };
  assert.equal(run(true), 'EATEN');
  assert.equal(run(false), 'EATEN');
});

test('absorption is judged in money, not ticks: a few paise on a 1-paisa stock is still "not going up"', () => {
  const b = new BookModel(); let t = T('10:00:00');
  seed(b, [[327.1, 100], [327.09, 100]], [[327.12, 100], [327.13, 100]], t);
  b.onQuote(Qm(327.12, 1000), t);
  let v = 1000;
  for (let i = 0; i < 8; i++) { seed(b, [[327.1 + i * 0.01, 100], [327.09, 100]], [[327.12 + i * 0.01, 100], [327.2, 100]], t += 5000); b.onQuote(Qm(327.12 + i * 0.01, v += 300), t); }
  const f = b.flow(t, 600);
  assert.ok(f.moveTicks > 1);
  assert.equal(f.absorption, 'BUYING_ABSORBED');
});

test('"in control" needs price to agree: a stalled bid is only "leaning", a move the other way is Mixed', () => {
  const stalled = new BookModel(); let t = T('10:00:00'); let v = 1000;
  seed(stalled, [[99.5, 500], [99.49, 400]], [[100, 50], [100.01, 50]], t);
  stalled.onQuote(Qm(99.5, v), t);
  for (let i = 1; i <= 40; i++) {
    t += 15_000;
    const bid = Math.min(99.5 + i * 0.05, 100.5); // climbs for 5 minutes, then flat
    seed(stalled, [[bid, 500], [bid - 0.01, 400]], [[bid + 0.5, 50], [bid + 0.51, 50]], t);
    stalled.onQuote(Qm(bid + (i % 3 ? 0.5 : 0), v += i % 3 ? 300 : 100), t);
  }
  const s = stalled.bias(t);
  assert.equal(s.label, 'Buyers leaning');
  assert.match(s.why, /bid has not advanced/);

  const mixed = new BookModel(); t = T('10:00:00'); v = 1000;
  seed(mixed, [[100, 500], [99.99, 400]], [[100.2, 50], [100.21, 50]], t);
  mixed.onQuote(Qm(100.2, v), t);
  for (let i = 1; i <= 20; i++) {
    t += 15_000;
    const bid = 100 - i * 0.05;
    seed(mixed, [[bid, 500], [bid - 0.01, 400]], [[bid + 0.2, 50], [bid + 0.21, 50]], t);
    mixed.onQuote(Qm(bid + 0.2, v += 200), t); // prints at the offer all the way down: looks like buying, price still falls
  }
  assert.equal(mixed.bias(t).label, 'Buying absorbed'); // 100% buying with price falling is absorption, checked first

  const against = new BookModel(); t = T('10:00:00'); v = 1000;
  seed(against, [[100, 500], [99.99, 400]], [[100.2, 50], [100.21, 50]], t);
  against.onQuote(Qm(100.2, v), t);
  for (let i = 1; i <= 20; i++) {
    t += 15_000;
    const bid = 100 - i * 0.05;
    seed(against, [[bid, 500], [bid - 0.01, 400]], [[bid + 0.2, 50], [bid + 0.21, 50]], t);
    against.onQuote(Qm(i % 2 ? bid + 0.2 : bid, v += i % 2 ? 300 : 220), t); // a little more buying, big bids, price falling
  }
  assert.equal(against.flow(t, 600).absorption, undefined);
  const m = against.bias(t);
  assert.equal(m.label, 'Mixed');
  assert.match(m.why, /price went the other way/);
});

test('banner says how much of the 10 minutes it really has; the book when looking back is the book of that moment', () => {
  const b = new BookModel(); let t = T('10:00:00');
  seed(b, [[100, 100], [99.99, 100]], [[100.05, 300], [100.06, 300]], t);
  b.onQuote(Qm(100.05, 1000), t);
  const then = t + 10_000;
  let v = 1000;
  for (let i = 0; i < 6; i++) { t += 30_000; seed(b, [[100, 100], [99.99, 100]], [[100.05, 900], [100.06, 900]], t); b.onQuote(Qm(100.05, v += 100), t); }
  assert.match(b.bias(t).why, /^3 of the last 10 min recorded/);
  assert.equal(b.nearBook(then).askQ, 600);
});

test('quote packets carry the VWAP and whole-book totals, and they survive recording', () => {
  const buf = quote(11, 258.05, 5000); const dv = new DataView(buf);
  dv.setFloat32(18, 257.5, true); dv.setInt32(26, 4000, true); dv.setInt32(30, 6000, true);
  const q = parseFeed(buf)[0];
  assert.ok(Math.abs(q.atp! - 257.5) < 1e-3);
  const b = new BookModel();
  applyEvent(b, ['Q', 1000, 258.05, 5000, q.totalBuy, q.totalSell, 257.5], '11');
  assert.deepEqual([b.totalBuy, b.totalSell, b.atp], [6000, 4000, 257.5]);
  applyEvent(b, ['Q', 2000, 258.05, 5100], '11'); // an old chunk: no totals, nothing breaks
  assert.equal(b.atp, 257.5);
});
