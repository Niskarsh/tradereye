import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candles } from '../lib/dhan';
import { toSessions, type Bar } from '../lib/live/enrich';
import { toSlots, type B10 } from '../lib/setups/engine';
import { onTick } from '../lib/study/mine';
import { FAST_STOP_FRAC, gridDay, liqBand, ML_COLS, ML_WIDTH, NEAR_TARGET_ADR, OPEN_SLIP_TICKS, ride, WIDE_STOP_ADR, LATE_END } from '../lib/ml/grid';
import { F_FIRST, F_LAST, I17_COLS, I17_PATH_COLS, I17_STRUCT_KEYS, iter17Day, placeboShift, simShort, structureFacts } from '../lib/ml/iter17';
import { nseDate, parseBoardMeetings, parseIndexIds, parseIndustries, resultsFlag, sectorPlan } from '../lib/ml/iter17Data';

const IST = 19800;
const sec = (date: string) => Date.parse(`${date}T09:15:00Z`) / 1000 - IST;
const tick = (x: number) => Math.round(x * 20) / 20;
function session(date: string, px: (k: number) => number, rnd = () => 0.5, v = 5000): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k < 375; k++) {
    const c = tick(px(k)), o = k ? tick(px(k - 1)) : c;
    out.push({ t: sec(date) + k * 60, o, h: Math.max(o, c) + Math.round(rnd() * 3) * 0.05, l: Math.min(o, c) - Math.round(rnd() * 3) * 0.05, c, v });
  }
  return out;
}
function inputs(vol: number, seed: number, drift = 0) {
  const b: Bar[] = [];
  for (let i = 0; i < 20; i++) b.push(...session(`2024-12-${String(i + 1).padStart(2, '0')}`, (k) => 300 + Math.sin(k / 6) * 0.6));
  const history = toSessions({ t: b.map((x) => x.t), o: b.map((x) => x.o), h: b.map((x) => x.h), l: b.map((x) => x.l), c: b.map((x) => x.c), v: b.map((x) => x.v) });
  const daily: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < 700; i++) { daily.t.push(i); daily.o.push(300); daily.h.push(303); daily.l.push(297); daily.c.push(300); daily.v.push(vol); }
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  let p = 300; const px: number[] = []; for (let k = 0; k < 375; k++) { p = Math.round((p + (rnd() - 0.5) * 1.2 + drift) * 20) / 20; px.push(p); }
  const date = '2025-01-06';
  const sector = session(date, (k) => 10000 + k, () => 0.5);
  return { date, history, day: session(date, (k) => px[k], rnd), nifty: session(date, () => 20000), daily, sector, resDay: 1, key: `S|${date}` };
}
const col = (c: string) => ML_COLS.indexOf(c) - 2;

test('iter17: the rows are the normal dataset\'s rows, the new facts appended', () => {
  for (const seed of [1, 2, 3, 4]) {
    const inp = inputs(4e6, seed);
    const base = gridDay(inp), r = iter17Day(inp);
    assert.equal(r.rows.length, base.length);
    r.rows.forEach((row, i) => {
      assert.deepEqual(row.slice(0, base[i].length), base[i]);
      assert.equal(row.length, ML_WIDTH - 2 + I17_COLS.length);
      assert.equal(row[base[i].length + I17_COLS.indexOf('resDay')], 1);
    });
    const secDay = r.rows.map((row) => row[base[0].length + I17_COLS.indexOf('secDay')]);
    assert.ok(secDay.every((x) => Number.isFinite(x) && x > 0), 'the sector index rose all day');
  }
});

test('iter17: F\'s path with no stop move is exactly the realistic-fill result (nbSx)', () => {
  let n = 0, moved = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) for (const vol of [1e6, 4e6, 1.2e7]) for (const drift of [0, -0.02, 0.02]) {
    const inp = inputs(vol, seed, drift);
    const r = iter17Day(inp);
    assert.equal(r.paths.length, r.pathRow.length);
    r.paths.forEach((rec, j) => {
      const row = r.rows[r.pathRow[j]], k = row[0];
      assert.ok(k >= F_FIRST && k <= F_LAST, 'paths only for F\'s moments');
      assert.equal(rec.length, I17_PATH_COLS.length - 1);
      assert.equal(rec[0], row[col('nbSx')], `net0 = nbSx at slot ${k}`);
      if (rec[1] !== rec[0] || rec[2] !== rec[0]) moved++;
      n++;
    });
  }
  assert.ok(n > 100 && moved > 0, `${n} moments, ${moved} changed by the break-even move`);
});

test('iter17: simShort = ride() for the short, and break-even after costs never loses more than the stop', () => {
  for (const seed of [11, 12, 13, 14]) {
    const inp = inputs(2e6, seed, -0.01);
    const day = toSlots(inp.day)!;
    const band = liqBand(2e6);
    for (let k = 20; k <= 100; k += 10) {
      const price = day.c[k - 1], adr = 6;
      const f = { slip: Math.max(k < 20 ? OPEN_SLIP_TICKS : 1, band.ticks), through: band.ticks, stopPct: band.stopPct, fast: FAST_STOP_FRAC, outSlip: band.ticks };
      const stop = onTick(price + WIDE_STOP_ADR * adr, 1), tgt = onTick(price - NEAR_TARGET_ADR * adr, -1);
      const a = simShort(day, k, price, stop, tgt, 300, f)!, b = ride(day, k, -1, price, stop, tgt, LATE_END, 300, f);
      assert.equal(a.net, b.net); assert.equal(a.r, b.r);
      const be = simShort(day, k, price, stop, tgt, 300, f, 0.8)!;
      if (be.moved && be.kind === -1) assert.ok(be.r > -0.2, `a moved stop exits near break-even: ${be.r}`);
    }
  }
});

const c = (o: number, h: number, l: number, cl: number): B10 => ({ o, h, l, c: cl, v: 1000 });
test('iter17: structure facts on hand-made candles', () => {
  // a pop above the day high that closes back below it (a sweep), after a lower high
  let t = [c(100, 101, 99.5, 100.8), c(100.8, 102, 100.5, 101.8), c(101.8, 101.9, 100.9, 101), c(101, 101.6, 100.6, 101.2), c(101.2, 102.4, 101, 101.5)];
  let f = structureFacts(t, 101.5, 0.5, 105);
  assert.equal(f.sweep, 1); assert.equal(f.sweepAgo, 0); assert.ok(Math.abs(f.sweepAtr - 0.8) < 1e-9); assert.equal(f.sweepPdh, 0);
  // yesterday's high swept
  f = structureFacts(t, 101.5, 0.5, 102.2);
  assert.equal(f.sweepPdh, 1);
  // a bearish fair value gap: candle 0's low (100) above candle 2's high (99); then a return into it
  t = [c(101, 101.5, 100, 100.2), c(100.2, 100.3, 98.5, 98.8), c(98.8, 99, 98, 98.2), c(98.2, 98.6, 97.8, 98.4), c(98.4, 99.5, 98.3, 99.2)];
  f = structureFacts(t, 99.2, 0.5, 103);
  assert.equal(f.fvgCount, 1); assert.equal(f.fvgIn, 1); assert.equal(f.fvgTouch, 1); assert.equal(f.fvgDistAtr, 0); assert.ok(Math.abs(f.fvgSizeAtr - 2) < 1e-9);
  // the first sharp down candle (1.5+ ATR) is candle 1; its base is candle 0, and the last candle has not come back to 100
  assert.ok(Math.abs(f.supplyDistAtr - 1.6) < 1e-9); assert.equal(f.supplyBack, 0);
  // break of structure: a swing low (candle 2) closed below later; flip: the open lost and retested
  t = [c(100, 100.5, 99.6, 99.8), c(99.8, 100.2, 99.2, 99.5), c(99.5, 99.7, 98.9, 99.4), c(99.4, 99.9, 99.2, 99.6), c(99.6, 99.7, 98.6, 98.7), c(98.7, 99.95, 98.5, 99.3)];
  f = structureFacts(t, 99.3, 0.5, 103);
  assert.equal(f.bosDown, 1); assert.equal(f.bosAgo, 1);
  assert.equal(f.flipOpen, 1); assert.ok(Math.abs(f.flipDistAtr - 1.4) < 1e-9);
  // shift = 0 is the real facts; a shifted copy differs and is fixed per stock-day
  const sh = placeboShift('S|2025-01-06', 6);
  assert.equal(sh, placeboShift('S|2025-01-06', 6)); assert.ok(Math.abs(sh) >= 0.5 && Math.abs(sh) <= 1.5 + 1e-9);
  assert.deepEqual(structureFacts(t, 99.3, 0.5, 103, 0), f);
  const g = structureFacts(t, 99.3, 0.5, 103, sh);
  assert.ok(I17_STRUCT_KEYS.some((k) => !(Object.is(g[k], f[k]))), 'the placebo is not the real thing');
});

test('iter17: results days and sectors', () => {
  assert.equal(nseDate('05-Feb-2024'), '2024-02-05'); assert.equal(nseDate('05-02-2024'), '2024-02-05');
  const m = parseBoardMeetings([
    { bm_symbol: 'ABC', bm_date: '02-Feb-2024', bm_purpose: 'Financial Results' },
    { bm_symbol: 'ABC', bm_date: '10-Feb-2024', bm_purpose: 'Fund Raising' },
    { bm_symbol: 'XYZ', bm_date: '03-Feb-2024', bm_purpose: 'Financial Results/Dividend' },
  ]);
  assert.deepEqual([...m.get('ABC')!], ['2024-02-02']);
  assert.equal(resultsFlag(m.get('ABC'), '2024-02-02', '2024-02-01'), 1, 'the results day');
  assert.equal(resultsFlag(m.get('ABC'), '2024-02-05', '2024-02-02'), 1, 'the next session');
  assert.equal(resultsFlag(m.get('ABC'), '2024-02-06', '2024-02-05'), 0);
  assert.equal(resultsFlag(m.get('XYZ'), '2024-02-05', '2024-02-02'), 1, 'a Saturday meeting: Monday reacts');
  assert.equal(resultsFlag(undefined, '2024-02-05', '2024-02-02'), 0);
  const ind = parseIndustries('Company Name,Industry,Symbol,Series,ISIN Code\n"A Ltd.",Information Technology,AAA,EQ,X\nB,Textiles,BBB,EQ,Y\n');
  const ids = parseIndexIds('SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_TRADING_SYMBOL\nNSE,I,29,INDEX,NIFTY IT\nNSE,E,1,EQUITY,AAA\n');
  const p = sectorPlan(ind, ids);
  assert.deepEqual(p.bySymbol.get('AAA'), { index: 'NIFTY IT', securityId: '29' });
  assert.ok(!p.bySymbol.has('BBB')); assert.deepEqual(p.missing, ['Textiles']); assert.equal(p.indices.length, 1);
});

test('iter17: the Run button starts the iteration the models script reports', async () => {
  const { readFileSync } = await import('node:fs');
  const { I17_ITERATION } = await import('../lib/ml/iter17Meta');
  const py = readFileSync(new URL('../scripts/ml_iter17.py', import.meta.url), 'utf8');
  assert.equal(Number(/^ITERATION = (\d+)/m.exec(py)![1]), I17_ITERATION);
});

test('iter17: the downloaded Markdown carries the verdict, every version, the rule, the lessons and the data notes', async () => {
  const { mlToMarkdown } = await import('../lib/ml/exportMd');
  const p = { n: 100, netR: 0.05, t: 2.1, monthsGreen: 20, monthsTraded: 30, pass: true };
  const row = (id: string) => ({ id, version: id, be: 0, name: id, dev: p, exam: p, untouched: { ...p, lessons: [] }, draws: { main: { n: 100, netR: 0.05, sizeR: 0.01 } }, atSize: { dev: p, exam: p } });
  const md = mlToMarkdown({
    iteration: 17, runId: 'r1', createdAt: 0, strategies: [],
    iter17: {
      table: [row('A'), row('B')],
      verdict: { message: 'No version passes', outcome: 'not-better', versions: [{ id: 'B', name: 'B', gain: 0, checks: [{ label: 'passes the exam', ok: true }], pass: false }], breakEven: [{ id: 'A_be80', version: 'A', at: 80, dev: 0.01, exam: -0.01, untouched: 0, pass: false }], placeboCGap: 0.04, placeboClean: true },
      lessons: { B: { final: { exit1: { cases: 50, stocks: 25, maxShare: 0.08, quarters: [5, 6], looMin: 3, total: 9, pass: true } }, active: [{ month: '2024-01', active: ['exit1'] }] } },
      losses: { A: { win: 60, fast: 10 } },
      data: { sectors: { ok: true, indices: ['NIFTY IT'], stockDaysWithSector: 5, stockDays: 10 }, results: { ok: false, error: 'HTTP 403' } },
    },
  });
  for (const s of ['## Verdict', 'No version passes', '## Every version', '| B |', '## The rule, version by version', '## Break-even', '## Lessons from losses: B', 'exit1', '## How the trades ended', 'HTTP 403']) assert.ok(md.includes(s), s);
});
