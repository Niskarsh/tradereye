import test from 'node:test';
import assert from 'node:assert/strict';
import { FeedProbe, DIAG_RE, depthHeaders, diagKey } from '../lib/book/probe';

function depth(code: number, sid: number, seg = 1): ArrayBuffer {
  const b = new ArrayBuffer(332); const dv = new DataView(b);
  dv.setInt16(0, 332, true); dv.setUint8(2, code); dv.setUint8(3, seg); dv.setInt32(4, sid, true);
  dv.setFloat64(12, 100, true); dv.setUint32(20, 50, true);
  return b;
}
const cat = (...bs: ArrayBuffer[]) => { const o = new Uint8Array(bs.reduce((s, b) => s + b.byteLength, 0)); let i = 0; for (const b of bs) { o.set(new Uint8Array(b), i); i += b.byteLength; } return o.buffer; };

test('probe: counts depth per stock, flags ids not on the list, snapshots a stock with trades but no book', () => {
  const p = new FeedProbe();
  const got: string[] = [];
  p.onSnapshot = (s) => got.push(s.symbol);
  const list = [{ symbol: 'PFC', securityId: '14299' }, { symbol: 'EMMVEE', securityId: '7777' }];
  const listed = new Set(list.map((w) => w.securityId));
  const t0 = Date.parse('2026-10-19T11:36:00+05:30');
  p.event('depth', 'subscribe {...}', t0);
  // PFC depth arrives; EMMVEE's never does, but something comes under an unknown id
  p.depthMessage(cat(depth(41, 14299), depth(51, 14299), depth(41, 9999)), listed, t0);
  assert.deepEqual(depthHeaders(cat(depth(41, 1), depth(51, 1))).map((h) => h.code), [41, 51]);
  assert.equal(p.stats.get('14299')?.depthBid, 1);
  assert.equal(p.unknownIds['9999'], 1);
  for (let i = 0; i < 6; i++) { p.quote('7777', t0 + i * 15_000); p.check('7777', 'EMMVEE', list, t0 + i * 15_000); }
  for (let i = 0; i < 6; i++) { p.quote('14299', t0 + i * 15_000); p.check('14299', 'PFC', list, t0 + i * 15_000); }
  assert.deepEqual(got, ['EMMVEE']);
  const snap = p.snapshots.get('7777')!;
  assert.equal(snap.stock.quotes, 5); // taken as soon as 5 trades span 60 s
  assert.equal(snap.oddDepth.length, 1);
  p.check('7777', 'EMMVEE', list, t0 + 600_000);
  assert.equal(got.length, 1, 'once per stock');
  assert.ok(DIAG_RE.test(diagKey('EMMVEE', t0)), diagKey('EMMVEE', t0));
});

test('probe: raw messages are kept whole and byte-exact (a 25-stock depth message is ~33 KB)', () => {
  const p = new FeedProbe();
  const big = cat(...Array.from({ length: 50 }, (_, i) => depth(i % 2 ? 51 : 41, 1000 + (i >> 1))));
  new Uint8Array(big)[big.byteLength - 1] = 0xab; // a marker in the very last byte
  p.depthMessage(big, new Set(['1000']), Date.now());
  const raw = p.rawDepth[0];
  const back = Buffer.from(raw.b64, 'base64');
  assert.equal(raw.bytes, big.byteLength);
  assert.equal(back.length, big.byteLength);
  assert.ok(back.equals(Buffer.from(big)), 'decodes to the exact bytes Dhan sent');
  assert.equal(back[back.length - 1], 0xab);
});

test('probe: whole-session snapshot has every stock\'s counts and when each feed last spoke', () => {
  const p = new FeedProbe();
  const list = [{ symbol: 'PFC', securityId: '14299' }, { symbol: 'ITC', securityId: '1660' }];
  p.depthMessage(cat(depth(41, 14299), depth(51, 14299)), new Set(['14299', '1660']), 1000);
  p.quote('1660', 2000);
  const s = p.snapshotAll('trade feed silent 60 s while the depth feed kept flowing', list, { depth: 5000, feed: 2000 }, 6000);
  assert.equal(s.symbol, 'ALL');
  assert.deepEqual(s.allStocks?.PFC, { depthBid: 1, depthAsk: 1, quotes: 0, firstDepthAt: 1000, lastDepthAt: 1000 });
  assert.equal(s.allStocks?.ITC.quotes, 1);
  assert.equal(s.lastMsg?.feed, 2000);
  assert.ok(DIAG_RE.test(diagKey(s.symbol, s.takenAt)));
});
