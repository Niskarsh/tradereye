import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candles } from '../lib/dhan';
import { NeedsDhanError, dailyKey, loadTradeCandles, minuteKey, weekdaysBack, type Store } from '../lib/candles/store';
import { buildDaily, buildIntraday, emaSeries, sessionVwap, tradeFacts } from '../lib/candles/chart';
import { tradeMarks } from '../lib/book/marks';

const IST = 19800;
const sec = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 - IST;

/** A full session of 1-minute candles; `px(k)` = close of minute k (0 = 09:15). */
function session(date: string, px: (k: number) => number, vol: (k: number) => number = () => 1000): Candles {
  const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let k = 0; k < 375; k++) {
    const close = px(k), open = k ? px(k - 1) : close;
    c.t.push(sec(date, '09:15') + k * 60); c.o.push(open); c.c.push(close);
    c.h.push(Math.max(open, close) + 0.05); c.l.push(Math.min(open, close) - 0.05); c.v.push(vol(k));
  }
  return c;
}
function join(...cs: Candles[]): Candles {
  const out: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const c of cs) for (const k of ['t', 'o', 'h', 'l', 'c', 'v'] as const) out[k].push(...c[k]);
  return out;
}

function fakeStore() {
  const files = new Map<string, Uint8Array>();
  const store: Store = { get: async (k) => files.get(k), put: async (k, b) => { files.set(k, b); } };
  return { files, store };
}

test('candle paths: one file per stock per day, by month', () => {
  assert.equal(minuteKey('fsl', '2026-10-15'), 'candles/1m/2026/october/FSL_2026-10-15.json.gz');
  assert.equal(dailyKey('FSL', '2026-10-15'), 'candles/daily/2026/october/FSL_2026-10-15.json.gz');
  assert.deepEqual(weekdaysBack('2026-10-19', 3), ['2026-10-16', '2026-10-19']); // Fri, (Sat, Sun skipped), Mon
});

test('first open asks Dhan once per kind and saves; the second open is all S3; holidays are remembered', async () => {
  const { files, store } = fakeStore();
  const days = weekdaysBack('2026-10-15', 28).filter((d) => d !== '2026-10-02'); // Oct 2 = a holiday: no candles
  const stock = join(...days.map((d) => session(d, (k) => 290 + k * 0.01)));
  const calls: string[] = [];
  const dhan = {
    intraday: async (p: { securityId: string; from: string; to: string }) => { calls.push(`intraday ${p.securityId} ${p.from} ${p.to}`); return p.securityId === '19' ? join(...days.slice(-5).map((d) => session(d, () => 22000))) : stock; },
    daily: async (p: { from: string; to: string }) => { calls.push(`daily ${p.to}`); return { t: [sec('2026-10-14', '00:00'), sec('2026-10-15', '00:00')], o: [1, 2], h: [1, 2], l: [1, 2], c: [1, 2], v: [1, 2] }; },
  };
  const deps = { store, dhan, lookupSecurityId: async () => '777', now: () => Date.parse('2026-10-19T12:00:00Z'), sleep: async () => {} };

  const a = await loadTradeCandles(deps, { symbol: 'FSL', date: '2026-10-15' });
  assert.equal(a.counts.dhanCalls, 3);
  assert.equal(calls.filter((c) => c.startsWith('intraday 777')).length, 1);
  assert.ok(calls.includes('daily 2026-10-16'), 'daily asks for the day after (Dhan toDate is exclusive)');
  assert.equal(a.securityId, '777');
  assert.equal(a.live, false);
  assert.ok(files.has(minuteKey('FSL', '2026-10-15')) && files.has(minuteKey('NIFTY500', '2026-10-15')) && files.has(dailyKey('FSL', '2026-10-15')));
  assert.ok(files.has(minuteKey('FSL', '2026-10-02')), 'holiday saved as empty so it is not asked for again');

  calls.length = 0;
  const b = await loadTradeCandles(deps, { symbol: 'FSL', date: '2026-10-15' });
  assert.equal(b.counts.dhanCalls, 0);
  assert.deepEqual(calls, []);
  assert.equal(b.securityId, '777', 'security id comes back from the saved files');
  assert.equal(b.minute.t.length, a.minute.t.length);
  assert.deepEqual(b.daily, a.daily);
});

test('today, market still open: shown but nothing of today is saved; the trade day is never marked empty', async () => {
  const { files, store } = fakeStore();
  const today = '2026-10-19';
  const dhan = {
    intraday: async () => join(session('2026-10-16', () => 100), { t: [sec(today, '09:15')], o: [100], h: [101], l: [99], c: [100.5], v: [10] }),
    daily: async () => ({ t: [sec('2026-10-16', '00:00')], o: [1], h: [1], l: [1], c: [1], v: [1] }),
  };
  const r = await loadTradeCandles({ store, dhan, lookupSecurityId: async () => '5', now: () => Date.parse(`${today}T05:00:00Z`), sleep: async () => {} }, { symbol: 'ABC', date: today, parts: ['minute', 'daily'] });
  assert.equal(r.live, true);
  assert.ok(r.minute.t.includes(sec(today, '09:15')));
  assert.ok(!files.has(minuteKey('ABC', today)));
  assert.ok(files.has(minuteKey('ABC', '2026-10-16')));
  assert.ok(!files.has(dailyKey('ABC', today)), 'daily not saved while today has no daily candle');
});

test('a failed S3 save does not break the chart', async () => {
  const store: Store = { get: async () => undefined, put: async () => { throw new Error('AccessDenied'); } };
  const dhan = { intraday: async () => session('2026-10-15', () => 50), daily: async () => ({ t: [], o: [], h: [], l: [], c: [], v: [] }) };
  const r = await loadTradeCandles({ store, dhan, lookupSecurityId: async () => '5', now: () => Date.parse('2026-10-19T12:00:00Z'), sleep: async () => {} }, { symbol: 'ABC', date: '2026-10-15', parts: ['minute'] });
  assert.equal(r.minute.t.length, 375);
  assert.equal(r.counts.saved, 0);
  assert.ok(r.counts.s3Errors > 0);
});

test('EMA and VWAP: EMA blank while warming up; VWAP restarts each day', () => {
  const e = emaSeries([1, 2, 3, 4], 3);
  assert.equal(e[0], undefined); assert.equal(e[1], undefined); assert.ok(e[2] !== undefined);
  const v = sessionVwap([
    { t: 0, o: 1, h: 2, l: 0, c: 1, v: 10, date: 'a' }, { t: 1, o: 1, h: 4, l: 2, c: 3, v: 10, date: 'a' },
    { t: 2, o: 9, h: 10, l: 8, c: 9, v: 5, date: 'b' },
  ]);
  assert.equal(v[1], 2); assert.equal(v[2], 9);
});

test('daily: the trade day is built from minutes when Dhan has no daily candle for it yet', () => {
  const d = buildDaily({ t: [sec('2026-10-16', '00:00')], o: [10], h: [11], l: [9], c: [10], v: [5] }, session('2026-10-19', (k) => 20 + k * 0.01), '2026-10-19');
  assert.equal(d.bars.length, 2);
  assert.equal(d.bars[1].date, '2026-10-19');
  assert.equal(d.bars[1].o, 20);
});

test('short trade: average entry, 1R from the stop, peak, 0.8R with Nifty against, VWAP reclaimed against him', () => {
  const day = '2026-10-15', prev = '2026-10-14';
  // falls 300 -> ~290 by 11:15 (minute 120), then rallies back above the open on heavy volume after 12:15
  const px = (k: number) => (k <= 120 ? 300 - k * 0.08 : k <= 180 ? 290.4 : 290.4 + (k - 180) * 0.2);
  const vol = (k: number) => (k >= 180 && k < 200 ? 9000 : 1000);
  const minute = join(session(prev, () => 300), session(day, px, vol));
  const nifty = join(session(prev, () => 22000), session(day, (k) => 22000 + k * 2)); // Nifty rising all day (~0.09% per 10 min)
  const intra = buildIntraday(minute, nifty, day);
  assert.equal(intra.sessions.length, 2);
  assert.ok(intra.niftyPct[intra.bars.length - 1]! > 0);

  const marks = tradeMarks(day, 'SHORT', [
    { time: '09:45:00', side: 'SELL', qty: 41, price: 297.6 },
    { time: '12:59:00', side: 'BUY', qty: 41, price: 298.2 },
  ]);
  const f = tradeFacts(intra, { date: day, direction: 'SHORT', marks, initialStop: 301.6 })!;
  assert.equal(f.avgEntry, 297.6);
  assert.equal(f.rBasis, 'STOP');
  assert.equal(f.oneR!.toFixed(2), '4.00');
  assert.ok(f.mfe && f.mfe.price < 290.5 && f.mfe.r! > 1.7, `peak ${JSON.stringify(f.mfe)}`);
  const kinds = f.signals.map((s) => s.kind);
  assert.ok(kinds.includes('R08'));
  assert.match(f.signals.find((s) => s.kind === 'R08')!.label, /Nifty against/);
  assert.ok(kinds.includes('GIVEBACK'));
  assert.ok(kinds.includes('VWAP_RECLAIM'), kinds.join(','));
  assert.deepEqual([...f.signals].sort((a, b) => a.t - b.t), f.signals, 'signals in time order');
});

test('no stop: 1R falls back to 2 x ATR(10m) at entry, like MfeR', () => {
  const day = '2026-10-15';
  const minute = join(session('2026-10-13', (k) => 100 + Math.sin(k / 5)), session('2026-10-14', (k) => 100 + Math.sin(k / 5)), session(day, (k) => 100 + k * 0.01));
  const intra = buildIntraday(minute, { t: [], o: [], h: [], l: [], c: [], v: [] }, day);
  const f = tradeFacts(intra, { date: day, direction: 'LONG', marks: tradeMarks(day, 'LONG', [{ time: '10:00:00', side: 'BUY', qty: 10, price: 100.4 }, { time: '11:00:00', side: 'SELL', qty: 10, price: 101 }]) })!;
  assert.equal(f.rBasis, '2ATR');
  assert.ok(f.oneR! > 0);
});

test('no Dhan token: saved charts load from S3; an unsaved trade day asks for Dhan; unsaved older days are skipped', async () => {
  const { files, store } = fakeStore();
  const days = weekdaysBack('2026-10-15', 28);
  const dhan = {
    intraday: async (p: { securityId: string }) => (p.securityId === '19' ? join(...days.slice(-6).map((d) => session(d, () => 22000))) : join(...days.map((d) => session(d, () => 100)))),
    daily: async () => ({ t: [sec('2026-10-15', '00:00')], o: [1], h: [1], l: [1], c: [1], v: [1] }),
  };
  const base = { store, lookupSecurityId: async () => '7', now: () => Date.parse('2026-10-19T12:00:00Z'), sleep: async () => {} };
  // nothing saved, no token: the trade day is a must -> asks for Dhan
  await assert.rejects(loadTradeCandles(base, { symbol: 'ABC', date: '2026-10-15' }), NeedsDhanError);
  // saved once (with a token) ...
  await loadTradeCandles({ ...base, dhan }, { symbol: 'ABC', date: '2026-10-15' });
  // ... then everything loads with no token at all
  const r = await loadTradeCandles(base, { symbol: 'ABC', date: '2026-10-15' });
  assert.equal(r.counts.dhanCalls, 0);
  assert.equal(r.minute.t.length, days.length * 375);
  assert.ok(r.daily && r.daily.t.length === 1);
  // an older day's file lost: still shown, the gap is counted, nothing thrown
  files.delete(minuteKey('ABC', days[0]));
  const q = await loadTradeCandles(base, { symbol: 'ABC', date: '2026-10-15' });
  assert.equal(q.counts.notSaved, 1);
  assert.equal(q.minute.t.length, (days.length - 1) * 375);
});
