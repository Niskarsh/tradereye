import test from 'node:test';
import assert from 'node:assert/strict';
import { FeedProbe } from '../lib/book/probe';
import { buildFeedReport, reportForClaude } from '../lib/book/feedreport';

const T0 = Date.parse('2026-10-19T13:10:00+05:30');
function depth(code: number, sid: number, best: number, seq = 0): ArrayBuffer {
  const b = new ArrayBuffer(332), d = new DataView(b);
  d.setInt16(0, 332, true); d.setUint8(2, code); d.setUint8(3, 1); d.setInt32(4, sid, true); d.setUint32(8, seq, true);
  for (let i = 0; i < 20; i++) { d.setFloat64(12 + i * 16, code === 41 ? best - i * 0.05 : best + i * 0.05, true); d.setUint32(20 + i * 16, 100 + i, true); d.setUint32(24 + i * 16, 2, true); }
  return b;
}
function quote(sid: number, ltp: number, vol: number, ltt: number): ArrayBuffer {
  const b = new ArrayBuffer(50), d = new DataView(b);
  d.setUint8(0, 4); d.setInt16(1, 50, true); d.setUint8(3, 1); d.setInt32(4, sid, true);
  d.setFloat32(8, ltp, true); d.setInt16(12, 10, true); d.setInt32(14, ltt, true); d.setInt32(22, vol, true); d.setFloat32(42, 340, true); d.setFloat32(46, 330, true);
  return b;
}
const cat = (...bs: ArrayBuffer[]) => { const o = new Uint8Array(bs.reduce((s, b) => s + b.byteLength, 0)); let i = 0; for (const b of bs) { o.set(new Uint8Array(b), i); i += b.byteLength; } return o.buffer; };

test('feed report: raw packets kept byte-exact per stock, facts computed from them', () => {
  const p = new FeedProbe();
  p.event('depth', 'subscribe {"RequestCode":23,"InstrumentList":[{"SecurityId":"14299"}]}', T0 - 1000);
  p.event('feed', 'subscribe {"RequestCode":17,"InstrumentList":[{"SecurityId":"14299"}]}', T0 - 1000);
  const listed = new Set(['14299', '1660']);
  // book frozen at 333.00 / 333.05 (same bytes, only the ignored sequence number changes) while trades walk down
  for (let i = 0; i < 30; i++) {
    const t = T0 + i * 5000;
    p.depthMessage(cat(depth(41, 14299, 333.0, i), depth(51, 14299, 333.05, i), depth(41, 1660, 410, i)), listed, t);
    p.feedMessage(quote(14299, 333 - i * 0.05, 100000 + i * 500, 1000 + i * 5), t + 100);
  }
  const r = buildFeedReport(p, 'PFC', '14299', T0 + 150_000, 5 * 60_000, 0.05);
  assert.equal(r.subscribed.depth, true);
  assert.equal(r.facts.depthPackets.bid, 30);
  assert.equal(r.facts.depthPackets.duplicates, 58, 'all but the first bid and ask are identical');
  assert.equal(r.facts.quotePackets, 30);
  assert.ok(r.facts.tradesOutsideBook.count > 0);
  assert.ok((r.facts.longestUnchangedBookWhileTrading?.sec ?? 0) >= 140);
  assert.equal(r.facts.lttAdvancedSec, 145);
  // raw is byte-exact: the first depth packet decodes back to the bytes sent
  const raw0 = Buffer.from(r.raw[0].b64, 'base64');
  assert.ok(raw0.equals(Buffer.from(depth(41, 14299, 333.0, 0))));
  assert.ok(r.raw.every((x) => x.feed === 'depth' || x.code === 4));
  const text = reportForClaude(r);
  assert.match(text, /TRADES 2\+ TICKS OUTSIDE THE LATEST BOOK: [1-9]/);
  assert.ok(!text.includes(r.raw[0].b64), 'no raw bytes in what goes to Claude');
});

test('feed report: a stock that never got packets says so, with zero counts', () => {
  const p = new FeedProbe();
  const r = buildFeedReport(p, 'EMMVEE', '759728', T0, 5 * 60_000);
  assert.equal(r.facts.depthPackets.bid, 0);
  assert.equal(r.facts.quotePackets, 0);
  assert.equal(r.subscribed.depth, false);
  assert.equal(r.facts.depthGaps[0].sec, 300);
});
