import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, loginMessage, openOrderSocket, type SocketState } from '../lib/live/orderSocket';

class FakeWS {
  static all: FakeWS[] = [];
  static mode: 'ok' | 'refuse' = 'ok';
  onopen: any; onmessage: any; onclose: any; onerror: any; sent: string[] = [];
  constructor(public url: string) {
    FakeWS.all.push(this);
    queueMicrotask(() => { if (FakeWS.mode === 'ok') this.onopen?.(); else this.onclose?.(); });
  }
  send(s: string) { this.sent.push(s); }
  close() { this.onclose?.(); }
}
const tick = () => new Promise((r) => setImmediate(r));

test('logs in, relays frames, ignores junk, closes cleanly', async () => {
  FakeWS.all = []; FakeWS.mode = 'ok';
  const states: SocketState[] = []; const msgs: unknown[] = [];
  const h = openOrderSocket({ token: 'T', clientId: 'C', onState: (s) => states.push(s), onMessage: (m) => msgs.push(m), WebSocketImpl: FakeWS as any });
  await tick();
  assert.equal(FakeWS.all[0].sent[0], loginMessage('C', 'T'));
  assert.deepEqual(JSON.parse(FakeWS.all[0].sent[0]), { LoginReq: { MsgCode: 42, ClientId: 'C', Token: 'T' }, UserType: 'SELF' });
  FakeWS.all[0].onmessage({ data: '{"Type":"order_alert","Data":{"OrderNo":"1"}}' });
  FakeWS.all[0].onmessage({ data: 'not json' });
  assert.equal(msgs.length, 1);
  h.close();
  assert.equal(states.at(-1), 'closed');
});

test('gives up after repeated refusals instead of retrying forever', async () => {
  FakeWS.all = []; FakeWS.mode = 'refuse';
  const states: SocketState[] = [];
  const timers: (() => void)[] = [];
  openOrderSocket({ token: 'T', clientId: 'C', onState: (s) => states.push(s), onMessage: () => {}, WebSocketImpl: FakeWS as any, maxFailures: 3,
    setTimeoutImpl: (fn) => { timers.push(fn); return timers.length; }, clearTimeoutImpl: () => {} });
  for (let i = 0; i < 5; i++) { await tick(); timers.shift()?.(); }
  await tick();
  assert.equal(states.at(-1), 'failed'); assert.equal(FakeWS.all.length, 3);
});

test('backoff grows and is capped', () => {
  assert.deepEqual([1, 2, 3, 10].map(backoffMs), [1000, 2000, 4000, 30000]);
});
