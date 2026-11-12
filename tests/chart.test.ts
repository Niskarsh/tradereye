import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, heikinAshi, intervalLabel, indexAtOrBefore } from '../packages/candle-chart/src/data';
import { NSE } from '../packages/candle-chart/src/theme';
import { ema, rsi, sessionVwap, sma, prevDay } from '../packages/candle-chart/src/indicators/math';
import { getIndicator, listIndicators } from '../packages/candle-chart/src/indicators/registry';
import { algoQuietMs } from '../lib/chart/quiet';
import { parseQuotes } from '../lib/chart/feed';
import { levelsFrom } from '../lib/chart/algo';
import type { Bar } from '../packages/candle-chart/src/types';

const IST = 19800;
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 - IST;
const istMs = (date: string, hhmm: string, ss = 0) => (at(date, hhmm) + ss) * 1000;

/** one session of 1-minute bars, close = 100 + minute index */
function session(date: string, n = 375): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k < n; k++) out.push({ t: at(date, '09:15') + k * 60, o: 100 + k, h: 101 + k, l: 99 + k, c: 100 + k, v: 10 });
  return out;
}

test('10-minute bars start at 09:15, hourly at 09:15 / 10:15 like TradingView on NSE', () => {
  const m1 = session('2026-11-12');
  const ten = aggregate(m1, '10', NSE);
  assert.equal(ten.length, 38); // 37 full bars + the 15:25 bar (5 minutes)
  assert.equal(ten[0].t, at('2026-11-12', '09:15'));
  assert.equal(ten[1].t, at('2026-11-12', '09:25'));
  assert.deepEqual([ten[0].o, ten[0].h, ten[0].l, ten[0].c, ten[0].v], [100, 110, 99, 109, 100]);
  const hour = aggregate(m1, '60', NSE);
  assert.equal(hour[0].t, at('2026-11-12', '09:15'));
  assert.equal(hour[1].t, at('2026-11-12', '10:15'));
  assert.equal(hour.length, 7);
});

test('daily -> weekly starts on Monday; -> monthly on the 1st', () => {
  const days: Bar[] = ['2026-11-09', '2026-11-10', '2026-11-13', '2026-11-16'].map((d, i) => ({ t: at(d, '00:00'), o: i, h: i + 1, l: i - 1, c: i, v: 1 }));
  const w = aggregate(days, 'W', NSE);
  assert.equal(w.length, 2);
  assert.equal(w[0].t, at('2026-11-09', '00:00'));
  assert.equal(w[0].v, 3);
  const m = aggregate(days, 'M', NSE);
  assert.equal(m.length, 1);
  assert.equal(m[0].t, at('2026-11-01', '00:00'));
});

test('labels and lookups', () => {
  assert.equal(intervalLabel('10'), '10m');
  assert.equal(intervalLabel('60'), '1h');
  assert.equal(intervalLabel('D'), '1D');
  const bars = session('2026-11-12', 5);
  assert.equal(indexAtOrBefore(bars, bars[2].t + 30), 2);
  assert.equal(indexAtOrBefore(bars, bars[0].t - 1), -1);
});

test('SMA / EMA / RSI match hand-worked values', () => {
  const x = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(sma(x, 3).slice(2), [2, 3, 4, 5]);
  const e = ema(x, 3); // seed = mean(1,2,3) = 2, k = 0.5
  assert.ok(Number.isNaN(e[1]));
  assert.equal(e[2], 2);
  assert.equal(e[3], 3);
  assert.equal(e[4], 4);
  const up = rsi([1, 2, 3, 4, 5, 6, 7, 8], 3);
  assert.equal(up[7], 100);
  const r = rsi([10, 11, 10, 11, 10, 11, 10, 11, 10], 2);
  for (const v of r.filter(Number.isFinite)) assert.ok(v >= 0 && v <= 100);
});

test('session VWAP and previous-day levels reset each day', () => {
  const a = session('2026-11-11', 3), b = session('2026-11-12', 3);
  const bars = [...a, ...b];
  const { vwap } = sessionVwap(bars, bars.map((x) => x.c), IST);
  assert.equal(vwap[0], 100);
  assert.equal(vwap[3], 100); // a new day starts again from its first bar
  const p = prevDay(bars, IST);
  assert.ok(Number.isNaN(p.ph[0]));
  assert.equal(p.ph[3], 103);
  assert.equal(p.pl[3], 99);
  assert.equal(p.pc[3], 102);
});

test('every indicator computes without throwing and returns full-length plots', () => {
  const bars = [...session('2026-11-10'), ...session('2026-11-11'), ...session('2026-11-12')];
  for (const d of listIndicators()) {
    const inputs = Object.fromEntries(d.inputs.map((i) => [i.key, i.default]));
    const out = d.compute(bars, inputs, { time: NSE, intervalMin: 1 });
    if (d.special) continue;
    for (const p of d.plots) assert.equal(out[p.key]?.length, bars.length, `${d.id}.${p.key}`);
  }
  assert.ok(getIndicator('vwap'));
});

test('Heikin Ashi', () => {
  const ha = heikinAshi([{ t: 0, o: 10, h: 12, l: 9, c: 11, v: 1 }, { t: 60, o: 11, h: 13, l: 10, c: 12, v: 1 }]);
  assert.equal(ha[0].c, 10.5);
  assert.equal(ha[1].o, (ha[0].o + ha[0].c) / 2);
});

test('charts keep off Dhan REST for 2 minutes after each Algo Live close, on weekdays only', () => {
  const d = '2026-11-12'; // a Thursday
  assert.equal(algoQuietMs(istMs(d, '09:24', 59)), 0);
  assert.ok(algoQuietMs(istMs(d, '09:25', 0)) > 119_000);
  assert.ok(algoQuietMs(istMs(d, '09:26', 30)) > 0);
  assert.equal(algoQuietMs(istMs(d, '09:27', 0)), 0);
  assert.ok(algoQuietMs(istMs(d, '10:55', 10)) > 0);
  assert.equal(algoQuietMs(istMs(d, '11:05', 10)), 0);
  assert.equal(algoQuietMs(istMs('2026-11-14', '09:25', 5)), 0); // Saturday
});

test('feed packets: ticker (index) and quote (stock)', () => {
  const buf = new ArrayBuffer(16 + 50);
  const dv = new DataView(buf);
  dv.setUint8(0, 2); dv.setInt16(1, 16, true); dv.setUint8(3, 0); dv.setInt32(4, 19, true); dv.setFloat32(8, 22000.5, true); dv.setInt32(12, 1, true);
  dv.setUint8(16, 4); dv.setInt16(17, 50, true); dv.setUint8(19, 1); dv.setInt32(20, 1333, true); dv.setFloat32(24, 280.5, true); dv.setInt32(16 + 22, 123456, true);
  const q = parseQuotes(buf, 5);
  assert.equal(q.length, 2);
  assert.deepEqual([q[0].securityId, q[0].ltp, q[0].volume], ['19', 22000.5, undefined]);
  assert.deepEqual([q[1].securityId, q[1].ltp, q[1].volume], ['1333', 280.5, 123456]);
});

test('Algo levels are rebuilt from the model facts (distance in 10-min ATRs)', () => {
  // price 200, ATR 1% = 2: VWAP 1 ATR below price, PDH 2.5 ATR above, POC 0.5 below, a missing fact is skipped
  const lv = levelsFrom({ priceRs: 200, atrPct: 1, distVwapAtr: 1, distHiAtr: 0.5, distLoAtr: 3, pdhAtr: 2.5, pdlAtr: -4, pocAtr: -0.5, vaHiAtr: null, ema10Atr: null });
  const by = Object.fromEntries(lv.map((l) => [l.key, l.price]));
  assert.equal(by.vwap, 198);
  assert.equal(by.dayHi, 201);
  assert.equal(by.dayLo, 194);
  assert.equal(by.pdh, 205);
  assert.equal(by.pdl, 192);
  assert.equal(by.poc, 199);
  assert.equal(by.vah, undefined);
  assert.equal(levelsFrom({ priceRs: null, atrPct: 1 }).length, 0);
});
