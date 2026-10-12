/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planBackfill, runBackfill } from '../lib/live/backfill';
import { DhanError, parseCandles, previousClose, type Candles } from '../lib/dhan';
import { MONTHLY_BASE } from '../lib/live/schema';
import { FakeSheets, IST } from './helpers';

const DAY = '2026-10-12';
const weekdays = (from: string, to: string) => {
  const out: string[] = [];
  for (let ms = Date.parse(from + 'T00:00:00Z'); ms <= Date.parse(to + 'T00:00:00Z'); ms += 86400_000) {
    const d = new Date(ms); if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10));
  }
  return out;
};
function candles(from: string, to: string, base: number, vol: number): Candles {
  const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const d of weekdays(from, to)) {
    for (let m = 0; m < 375; m++) {
      const price = base + Math.sin(m / 20) * 2 + (d === to ? m * 0.01 : 0);
      c.t.push(IST(d, '09:15:00') / 1000 + m * 60);
      c.o.push(price); c.h.push(price + 0.5); c.l.push(price - 0.5); c.c.push(price + 0.1); c.v.push(vol + (m < 5 ? 5 * vol : 0));
    }
  }
  return c;
}
const dhan = (opts: { fail?: DhanError } = {}) => ({
  calls: [] as string[],
  async intraday(p: any) { this.calls.push(`I ${p.securityId} ${p.from}`); if (opts.fail) throw opts.fail; return candles(p.from, p.to, p.securityId === '19' ? 20000 : 100, 1000); },
  async daily(p: any) { this.calls.push(`D ${p.from}`); return { t: [IST('2026-10-09', '15:30:00') / 1000], o: [100], h: [101], l: [99], c: [100.5], v: [1] } as Candles; },
});

function sheetWithTrade() {
  const f = new FakeSheets();
  f.addTab('october-2026', [[...MONTHLY_BASE, 'Setup'],
    ['TRD-1', DAY, 'ABC', 'SHORT', 'BUY', '100', '10', '0', '0', '0', 'WIN', '09:40:00', '1200', 'YES', '2', 'my note', '', 'momentum'],
    ['TRD-1', DAY, 'ABC', 'SHORT', 'SELL', '102', '10', '0', '0', '0', 'WIN', '09:25:00', '1200', 'YES', '1', 'my note', '', 'momentum']]);
  return f;
}

test('plan lists trades that need data; run fills columns, keeps Setup/comment, never changes existing values', async () => {
  const f = sheetWithTrade();
  const plan = await planBackfill(f.client());
  assert.equal(plan.pending, 1); assert.equal(plan.items[0].fills, 2);

  const d = dhan();
  const res = await runBackfill({ dhan: d as any, sheets: f.client(), lookupSecurityId: async () => '11', sleep: async () => {}, now: () => IST(DAY, '16:00:00') }, [{ tab: 'october-2026', groupId: 'TRD-1' }]);
  assert.equal(res.results[0].status, 'OK', res.results[0].detail);
  const rows = f.table('october-2026');
  for (const r of rows) {
    assert.equal(r.Setup, 'momentum'); assert.equal(r.Comment, 'my note'); assert.equal(r.EnrichStatus, 'OK');
    assert.ok(r.Nifty500First5Pct !== '' && r.RvolAtEntry !== '' && r.RvolDay5 !== '' && r.Atr2 !== '' && r.MfeR !== '');
    assert.equal(r.SecurityId, '11'); assert.equal(r.EntryTime, '09:25:00'); assert.equal(r.ExitTime, '09:40:00'); assert.equal(r.DirFromFills, 'SHORT');
    assert.equal(r.Direction, 'SHORT'); assert.equal(r.NetPnL, '0');
  }
  assert.equal(rows[0].AvgEntry, '102'); assert.equal(rows[0].AvgExit, '100'); assert.equal(rows[0].RBasis, '2ATR');
  assert.equal((await planBackfill(f.client())).pending, 0);
  assert.equal((await planBackfill(f.client(), { redo: true })).pending, 1);
});

test('direction comes from the first fill even when the sheet says otherwise (sell first = SHORT)', async () => {
  const f = sheetWithTrade();
  f.rows('october-2026').forEach((r, i) => { if (i) r[3] = 'LONG'; }); // user toggled wrongly
  await runBackfill({ dhan: dhan() as any, sheets: f.client(), lookupSecurityId: async () => '11', sleep: async () => {} }, [{ tab: 'october-2026', groupId: 'TRD-1' }]);
  assert.equal(f.table('october-2026')[0].DirFromFills, 'SHORT');
  assert.equal(f.table('october-2026')[0].Direction, 'LONG'); // existing value is never rewritten
});

test('stops cleanly when the Data API plan is not active', async () => {
  const f = sheetWithTrade();
  const res = await runBackfill({ dhan: dhan({ fail: new DhanError(401, 'DH-902', 'Data API not subscribed') }) as any, sheets: f.client(), lookupSecurityId: async () => '11', sleep: async () => {} }, [{ tab: 'october-2026', groupId: 'TRD-1' }]);
  assert.equal(res.aborted, 'NO_DATA_PLAN');
  assert.equal(f.table('october-2026')[0].EnrichStatus, ''); // stays pending for the next run
});

test('missing instrument id marks the trade FAILED with a reason and carries on', async () => {
  const f = sheetWithTrade();
  const res = await runBackfill({ dhan: dhan() as any, sheets: f.client(), lookupSecurityId: async () => undefined, sleep: async () => {} }, [{ tab: 'october-2026', groupId: 'TRD-1' }]);
  assert.equal(res.results[0].status, 'FAILED');
  assert.match(f.table('october-2026')[0].EnrichStatus, /^FAILED/);
});

test('candle parsing handles Unix and 1980-based epochs; previous close picks the right day', () => {
  const unix = IST(DAY, '09:15:00') / 1000;
  const a = parseCandles({ open: [1], high: [1], low: [1], close: [1], volume: [1], timestamp: [unix] }, IST(DAY, '12:00:00'));
  const b = parseCandles({ open: [1], high: [1], low: [1], close: [1], volume: [1], timestamp: [unix - 315532800] }, IST(DAY, '12:00:00'));
  assert.equal(a.t[0], unix); assert.equal(b.t[0], unix);
  assert.equal(previousClose({ t: [IST('2026-10-09', '15:30:00') / 1000, IST(DAY, '15:30:00') / 1000], o: [], h: [], l: [], c: [5, 6], v: [] }, DAY), 5);
});

test('TradingView-style rvol divides by the full-day average, so it is far smaller than the same-time ratio', async () => {
  const f = sheetWithTrade();
  await runBackfill({ dhan: dhan() as any, sheets: f.client(), lookupSecurityId: async () => '11', sleep: async () => {} }, [{ tab: 'october-2026', groupId: 'TRD-1' }]);
  const r = f.table('october-2026')[0];
  assert.ok(Number(r.RvolDay5) > 0 && Number(r.RvolDay5) < Number(r.Rvol5) / 10, `${r.RvolDay5} vs ${r.Rvol5}`);
});
