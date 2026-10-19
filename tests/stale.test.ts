import test from 'node:test';
import assert from 'node:assert/strict';
import { BookModel } from '../lib/book/model';

const T = (hms: string) => Date.parse(`2026-10-19T${hms}+05:30`);
const r2 = (x: number) => Math.round(x * 100) / 100;
const book = (m: BookModel, bid: number, t: number) => {
  const lv = (p: number) => ({ price: r2(p), qty: 500, orders: 1 });
  m.onDepth({ securityId: '1', side: 'BID', levels: Array.from({ length: 20 }, (_, i) => lv(bid - i * 0.05)) }, t);
  m.onDepth({ securityId: '1', side: 'ASK', levels: Array.from({ length: 20 }, (_, i) => lv(bid + 0.05 + i * 0.05)) }, t);
};
let vol = 1000;
const trade = (m: BookModel, ltp: number, t: number) => { vol += 100; m.onQuote({ securityId: '1', ltp, ltq: 100, ltt: 0, volume: vol, totalBuy: 0, totalSell: 0, dayHigh: 0, dayLow: 0 }, t); };

test('frozen book (FSL 19 Oct): same snapshot keeps arriving while price trades far below it', () => {
  const m = new BookModel(); vol = 1000;
  let t = T('09:25:00');
  book(m, 281.9, t); trade(m, 281.9, t);
  // the same book every 5 s; trades walk down to 278.30
  for (let p = 281.9; p > 278.3; p = r2(p - 0.05)) { t += 5_000; book(m, 281.9, t); trade(m, p, t); }
  assert.equal(m.staleSince(t), T('09:25:00'));
});

test('live book that follows price is never stale', () => {
  const m = new BookModel(); vol = 1000;
  let t = T('09:25:00');
  for (let p = 281.9; p > 278.3; p = r2(p - 0.05)) { t += 5_000; book(m, p, t); trade(m, p, t); }
  assert.equal(m.staleSince(t), undefined);
});

test('quiet stock: an unchanged book with no trades is not stale; with trades for 90 s it is', () => {
  const m = new BookModel(); vol = 1000;
  let t = T('11:00:00');
  book(m, 500, t); trade(m, 500, t);
  for (let i = 0; i < 30; i++) { t += 5_000; book(m, 500, t); }
  assert.equal(m.staleSince(t), undefined, 'no trades: nothing to contradict the book');
  for (let i = 0; i < 6; i++) { t += 2_000; book(m, 500, t); trade(m, 500, t); }
  assert.equal(m.staleSince(t), T('11:00:00'));
});

test('stale kinds: OUTSIDE is proof (reconnect), UNCHANGED may just be a sparse depth stream (no reconnect)', () => {
  const m = new BookModel(); vol = 1000;
  let t = T('11:00:00');
  book(m, 500, t); trade(m, 500, t);
  for (let i = 0; i < 50; i++) { t += 2_000; trade(m, 500, t); } // trades at the book, book unchanged for 100 s
  assert.equal(m.staleKind(t), 'UNCHANGED');
  const f = new BookModel(); vol = 1000; t = T('09:25:00');
  book(f, 281.9, t); trade(f, 281.9, t);
  for (let p = 281.9; p > 278.3; p = r2(p - 0.05)) { t += 5_000; book(f, 281.9, t); trade(f, p, t); }
  assert.equal(f.staleKind(t), 'OUTSIDE');
});
