import test from 'node:test';
import assert from 'node:assert/strict';
import { computeEnrichment, toSessions } from '../lib/live/enrich';
import type { Candles } from '../lib/dhan';
import { IST } from './helpers';

function day(date: string, bar: (m: number) => { o: number; h: number; l: number; c: number }, until = 375): Candles {
  const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let m = 0; m < until; m++) {
    const b = bar(m);
    c.t.push(IST(date, '09:15:00') / 1000 + m * 60); c.o.push(b.o); c.h.push(b.h); c.l.push(b.l); c.c.push(b.c); c.v.push(1000);
  }
  return c;
}
const merge = (...cs: Candles[]): Candles => ({ t: cs.flatMap((c) => c.t), o: cs.flatMap((c) => c.o), h: cs.flatMap((c) => c.h), l: cs.flatMap((c) => c.l), c: cs.flatMap((c) => c.c), v: cs.flatMap((c) => c.v) });

test('ATR at entry includes the 10-minute bar still forming (a violent open is not ignored)', () => {
  const dates = ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-05'];
  const calm = dates.map((d) => day(d, () => ({ o: 100, h: 100.5, l: 99.5, c: 100 })));
  // trade day: gaps up and swings 10 points inside the first minutes
  const wild = day('2026-10-12', (m) => (m < 6 ? { o: 100 + m, h: 112 - m, l: 99 + m * 0.2, c: 105 } : { o: 105, h: 105.5, l: 104.5, c: 105 }), 30);
  const stock = toSessions(merge(...calm, wild));
  const r = computeEnrichment({ date: '2026-10-12', entryMs: IST('2026-10-12', '09:21:30'), exitMs: IST('2026-10-12', '09:40:00'), direction: 'SHORT', entryPrice: 105, stock, nifty: [] });
  assert.ok(r.atr10m! > 1.5, `atr10m=${r.atr10m} should reflect the wild opening bar, not the calm prior-day value of ~1`);
  assert.ok(Math.abs(r.atr2! - r.atr10m! * 2) < 0.001);
});

test('ATR uses nothing from after the entry minute', () => {
  const dates = ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-05'];
  const calm = dates.map((d) => day(d, () => ({ o: 100, h: 100.5, l: 99.5, c: 100 })));
  const a = day('2026-10-12', () => ({ o: 100, h: 100.5, l: 99.5, c: 100 }), 40);
  const b = day('2026-10-12', (m) => (m >= 10 ? { o: 100, h: 130, l: 70, c: 100 } : { o: 100, h: 100.5, l: 99.5, c: 100 }), 40); // chaos only AFTER entry
  const run = (c: Candles) => computeEnrichment({ date: '2026-10-12', entryMs: IST('2026-10-12', '09:21:00'), exitMs: IST('2026-10-12', '09:50:00'), direction: 'LONG', entryPrice: 100, stock: toSessions(merge(...calm, c)), nifty: [] }).atr10m;
  assert.equal(run(a), run(b));
});
