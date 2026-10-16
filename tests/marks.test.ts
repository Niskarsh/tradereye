import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeMarks } from '../lib/book/marks';
import { loadChunks } from '../lib/book/recorder';
import { encodeLines, gzip } from '../lib/book/record';

test('journal marks: split fills are one order; later same-side order is an add; opposite side is the exit', () => {
  const m = tradeMarks('2026-10-16', 'LONG', [
    { time: '10:40:00', side: 'BUY', qty: 60, price: 339.2 }, { time: '10:40:01', side: 'BUY', qty: 40, price: 339.3 },
    { time: '10:43:00', side: 'BUY', qty: 50, price: 339.8 }, { time: '10:46:00', side: 'SELL', qty: 150, price: 340.4 },
  ]);
  assert.deepEqual(m.map((x) => [x.role, x.side, x.qty]), [['ENTRY', 'BUY', 100], ['ADD', 'BUY', 50], ['EXIT', 'SELL', 150]]);
  assert.equal(m[0].price.toFixed(2), '339.24');
  assert.equal(new Date(m[0].t + 19800_000).toISOString().slice(11, 19), '10:40:00');
});

test('journal marks: a short enters with a sell', () => {
  const m = tradeMarks('2026-10-16', 'SHORT', [{ time: '9:30:00', side: 'SELL', qty: 10, price: 100 }, { time: '09:35:00', side: 'BUY', qty: 10, price: 99 }]);
  assert.deepEqual(m.map((x) => x.role), ['ENTRY', 'EXIT']);
});

test('parallel chunk download still replays in time order and skips missing chunks', async () => {
  const slots = ['0915', '0925', '0935', '0945', '0955', '1005', '1015', '1025', '1035', '1045', '1055', '1105'];
  const files = new Map<string, Uint8Array>();
  for (const s of slots) if (s !== '0945') files.set(s, await gzip(encodeLines({ v: 1, symbol: 'X', securityId: '1', date: '2026-10-16', slot: s }, ['K', 0, 5, 0, null, null, null, []], [['Q', 1, 1, 1]])));
  let active = 0, maxActive = 0;
  const api = async (path: string) => {
    active++; maxActive = Math.max(maxActive, active);
    const slot = decodeURIComponent(path).match(/(\d{4})\.gz/)![1];
    await new Promise((r) => setTimeout(r, Math.random() * 30));
    active--;
    const b = files.get(slot);
    return b ? new Response(b as BodyInit) : new Response('{}', { status: 404 });
  };
  const order: string[] = [];
  let last = '';
  const err = await loadChunks(api, 'X', '2026-10-16', slots, (s) => order.push(s), (d, t) => { last = `${d}/${t}`; });
  assert.equal(err, undefined);
  assert.deepEqual(order, slots.filter((s) => s !== '0945'));
  assert.ok(maxActive > 1 && maxActive <= 8);
  assert.equal(last, '12/12');
});
