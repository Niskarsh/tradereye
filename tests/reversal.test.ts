import test from 'node:test';
import assert from 'node:assert/strict';
import { BookModel } from '../lib/book/model';
import { ReversalWatch, detectReversal, type ReversalAlert } from '../lib/book/reversal';

const T = (hms: string) => Date.parse(`2026-10-16T${hms}+05:30`);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** A book around `bid`: 10 levels a side of 100 shares, plus optional walls { price: qty }. */
function book(m: BookModel, bid: number, t: number, walls: Record<string, number> = {}) {
  const lv = (p: number) => ({ price: r2(p), qty: walls[r2(p).toFixed(2)] ?? 100, orders: 1 });
  m.onDepth({ securityId: '1', side: 'BID', levels: Array.from({ length: 10 }, (_, i) => lv(bid - i * 0.05)) }, t);
  m.onDepth({ securityId: '1', side: 'ASK', levels: Array.from({ length: 10 }, (_, i) => lv(bid + 0.05 + i * 0.05)) }, t);
}
let vol = 10_000;
const trade = (m: BookModel, ltp: number, qty: number, t: number) => {
  vol += qty;
  m.onQuote({ securityId: '1', ltp, ltq: qty, ltt: 0, volume: vol, totalBuy: 0, totalSell: 0, dayHigh: 0, dayLow: 0 }, t);
};

/** Price falls from 260 to 258 (10:00 - 10:06), then sits on a 5000-share buy wall at 258 while sellers hit it. */
function fallIntoBuyWall(opts: { eat?: boolean; noMove?: boolean } = {}) {
  const m = new BookModel();
  vol = 10_000;
  let t = T('10:00:00');
  book(m, 260, t); trade(m, 260, 1, t);
  if (!opts.noMove) {
    for (let p = 260; p > 258.04; p = r2(p - 0.05)) { t += 9_000; book(m, p, t, { '258.00': 5000 }); trade(m, p, 300, t); }
  } else t = T('10:06:00');
  const startBid = opts.noMove ? 260 : 258;
  const wall = opts.noMove ? { '260.00': 5000 } : { '258.00': 5000 };
  // the stall: 2.5 minutes of sellers hitting the bid at the wall, the wall refilling, price not falling
  for (let i = 0; i < 30; i++) {
    t += 5_000;
    // eaten: from here on price trades below the wall and the wall is gone
    if (opts.eat && i >= 25) { book(m, r2(startBid - 0.2), t); trade(m, r2(startBid - 0.2), 400, t); continue; }
    // trades eat into the wall and it refills: the book keeps changing, as a live one does
    const live = Object.fromEntries(Object.entries(wall).map(([k, q]) => [k, i % 2 ? q - 400 : q]));
    book(m, startBid, t, live);
    trade(m, startBid, 400, t);
  }
  return { m, t };
}

test('reversal long: price fell into a holding buy wall and the selling is absorbed', () => {
  const { m, t } = fallIntoBuyWall();
  const r = detectReversal(m, t);
  assert.ok(r, 'expected a reversal');
  assert.equal(r.side, 'LONG');
  assert.equal(r.wallPrice, 258);
  assert.equal(r.wallSide, 'BID');
  assert.match(r.why, /selling absorbed/);
});

test('reversal short: the mirror image (rose into a holding sell wall, buying absorbed)', () => {
  const m = new BookModel();
  vol = 10_000;
  let t = T('11:00:00');
  // asks start at bid + 0.05: the wall at 262.05 is the best ask once the bid reaches 262
  book(m, 260, t); trade(m, 260.05, 1, t);
  for (let p = 260; p < 261.96; p = r2(p + 0.05)) { t += 9_000; book(m, p, t, { '262.05': 5000 }); trade(m, r2(p + 0.05), 300, t); }
  for (let i = 0; i < 30; i++) { t += 5_000; book(m, 262, t, { '262.05': i % 2 ? 4600 : 5000 }); trade(m, 262.05, 400, t); }
  const r = detectReversal(m, t);
  assert.ok(r, 'expected a reversal');
  assert.equal(r.side, 'SHORT');
  assert.equal(r.wallPrice, 262.05);
  assert.match(r.why, /buying absorbed/);
});

test('no alert when the wall gets eaten (price traded through it)', () => {
  const { m, t } = fallIntoBuyWall({ eat: true });
  assert.equal(detectReversal(m, t), undefined);
});

test('no alert without a move into the wall first (nothing to reverse)', () => {
  const { m, t } = fallIntoBuyWall({ noMove: true });
  assert.equal(detectReversal(m, t), undefined);
});

test('watch: checks at most every 2 s and fires once per wall within the cooldown', () => {
  const { m, t } = fallIntoBuyWall();
  const got: ReversalAlert[] = [];
  const w = new ReversalWatch((a) => got.push(a));
  w.check('1', 'TEST', m, t);
  w.check('1', 'TEST', m, t + 500);    // too soon, not checked
  w.check('1', 'TEST', m, t + 3_000);  // checked, same wall: cooldown
  assert.equal(got.length, 1);
  assert.equal(got[0].symbol, 'TEST');
  assert.equal(got[0].side, 'LONG');
  w.check('1', 'TEST', m, t + 16 * 60_000); // after 15 min the same wall may alert again (if still a setup)
  assert.ok(got.length <= 2);
});
