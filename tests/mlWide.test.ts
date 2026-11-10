import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candles } from '../lib/dhan';
import { toSessions, type Bar } from '../lib/live/enrich';
import { gridDay, liqBand, ML_COLS, ML_WIDTH, WIDE_LAST_SLOT, wideVol } from '../lib/ml/grid';
import { GridWriter } from '../lib/ml/writer';
import { inLiveWindow, wideDays, wideVerdict, type WideShard } from '../lib/ml/wide';
import { screenerDays, SCREENER } from '../lib/setups/universe';

const IST = 19800;
const sec = (date: string) => Date.parse(`${date}T09:15:00Z`) / 1000 - IST;
const tick = (x: number) => Math.round(x * 20) / 20;
function session(date: string, px: (k: number) => number, scale: number, rnd = () => 0.5): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k < 375; k++) {
    const c = tick(px(k) * scale), o = k ? tick(px(k - 1) * scale) : c;
    out.push({ t: sec(date) + k * 60, o, h: Math.max(o, c) + Math.round(rnd() * 3) * 0.05, l: Math.min(o, c) - Math.round(rnd() * 3) * 0.05, c, v: 5000 });
  }
  return out;
}
function inputs(scale: number, vol: number, seed: number) {
  const b: Bar[] = [];
  for (let i = 0; i < 20; i++) b.push(...session(`2024-12-${String(i + 1).padStart(2, '0')}`, (k) => 300 + Math.sin(k / 6) * 0.6, scale));
  const history = toSessions({ t: b.map((x) => x.t), o: b.map((x) => x.o), h: b.map((x) => x.h), l: b.map((x) => x.l), c: b.map((x) => x.c), v: b.map((x) => x.v) });
  const daily: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < 700; i++) { daily.t.push(i); daily.o.push(300 * scale); daily.h.push(303 * scale); daily.l.push(297 * scale); daily.c.push(300 * scale); daily.v.push(vol); }
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  let p = 300; const px: number[] = []; for (let k = 0; k < 375; k++) { p = Math.round((p + (rnd() - 0.5) * 0.7) * 20) / 20; px.push(p); }
  const date = '2025-01-06';
  return { date, history, day: session(date, (k) => px[k], scale, rnd), nifty: session(date, () => 20000, 1), daily };
}
const col = (c: string) => ML_COLS.indexOf(c) - 2;

test('wide: a stock at ₹340 or less gets exactly the rows of the normal dataset, up to 10:55', () => {
  for (const seed of [1, 2, 3]) for (const vol of [1e6, 4e6, 1.2e7]) {
    const inp = inputs(1, vol, seed);
    const normal = gridDay(inp), wide = gridDay({ ...inp, wide: true });
    assert.ok(wide.length === 10 && normal.length > wide.length);
    assert.deepEqual(wide, normal.filter((r) => r[0] <= WIDE_LAST_SLOT));
  }
});

test('wide: a dearer stock is credited its rupee liquidity and slips more ticks', () => {
  const inp = inputs(2, 1.2e7, 5); // ₹600: 10M+ shares in either measure, so only the tick scaling differs
  const normal = gridDay(inp).filter((r) => r[0] <= WIDE_LAST_SLOT), wide = gridDay({ ...inp, wide: true });
  assert.equal(wide[0][col('avgVol')], wideVol(1.2e7, 600));
  let cost = 0;
  wide.forEach((r, i) => { cost += normal[i][col('nbSx')] - r[col('nbSx')]; assert.equal(r[col('nbS')], normal[i][col('nbS')], 'the label the model learns is unchanged'); });
  assert.ok(cost > 0, `two ticks cost more than one, over the day: ${cost}`);
  assert.equal(liqBand(wideVol(1e6, 680)).ticks, liqBand(2e6).ticks);
});

test('wide: the day list keeps the ₹250-340 screener exactly, and flags it', () => {
  const d: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  const px = [200, 249, 250, 300, 340, 341, 600, 1000, 1001, 320];
  for (let i = 0; i < 400; i++) {
    const c = px[Math.floor(i / 11) % px.length];
    d.t.push(Date.parse('2024-01-01T04:00:00Z') / 1000 + i * 86400); d.o.push(c); d.h.push(c); d.l.push(c); d.c.push(c); d.v.push(i % 37 < 18 ? 4e5 : 7e5);
  }
  const days = wideDays(d, '2024-02-01', '2025-01-30');
  const narrow = days.filter((x) => x.narrow).map((x) => x.date);
  assert.deepEqual(narrow, screenerDays(d, SCREENER, '2024-02-01', '2025-01-30'));
  assert.ok(days.length > narrow.length);
});

test('writer: an extra column is written after the labels; no extra column = the normal file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wide-'));
  const inp = inputs(1, 4e6, 9), rows = gridDay({ ...inp, wide: true });
  const w = new GridWriter(dir, ['inNarrow']);
  w.add('A', inp.date, rows, [1]);
  w.close({ runId: 't', from: inp.date, to: inp.date, mid: inp.date, riskInr: 300 });
  const head = JSON.parse(readFileSync(join(dir, 'grid.json'), 'utf8'));
  assert.equal(head.width, ML_WIDTH + 1); assert.equal(head.cols.at(-1), 'inNarrow');
  const bin = readFileSync(join(dir, 'grid.bin')), f = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  assert.equal(f.length, rows.length * head.width);
  for (let i = 0; i < rows.length; i++) assert.equal(f[i * head.width + ML_WIDTH], 1);
  const dir2 = mkdtempSync(join(tmpdir(), 'wide-')), w2 = new GridWriter(dir2);
  w2.add('A', inp.date, rows); w2.close({ runId: 't', from: inp.date, to: inp.date, mid: inp.date, riskInr: 300 });
  const h2 = JSON.parse(readFileSync(join(dir2, 'grid.json'), 'utf8'));
  assert.equal(h2.width, ML_WIDTH); assert.deepEqual(h2.cols, ML_COLS);
});

test('the run never competes with Algo Live for Dhan requests', () => {
  const at = (d: string, t: string) => Date.parse(`${d}T${t}:00+05:30`);
  assert.equal(inLiveWindow(at('2026-11-10', '08:39')), false);
  assert.equal(inLiveWindow(at('2026-11-10', '08:40')), true);
  assert.equal(inLiveWindow(at('2026-11-10', '11:14')), true);
  assert.equal(inLiveWindow(at('2026-11-10', '11:15')), false);
  assert.equal(inLiveWindow(at('2026-11-14', '09:30')), false, 'Saturday');
});

const dev = (netR: number, t = 3, n = 500, sumR = netR * n) => ({ n, netR, t, sumR });
function world(o: { narrow?: number[]; wide?: number[]; placebo?: ReturnType<typeof dev>; wideT?: number; wideN?: number }): WideShard[] {
  const narrow = o.narrow ?? [0.04, 0.05, 0.06], wide = o.wide ?? [0.09, 0.1, 0.11];
  const seed = (i: number) => (i ? `seed${i + 1}` : 'main');
  return [
    ...narrow.map((netR, i): WideShard => ({ universe: 'narrow', shard: seed(i), strategies: [{ id: 'nF', name: 'control', dev: dev(netR) }] })),
    ...wide.map((netR, i): WideShard => ({ universe: 'wide', shard: seed(i), strategies: [
      { id: 'w3m', name: 'floor', dev: dev(netR, o.wideT ?? 3, o.wideN ?? 500) }, { id: 'wAll', name: 'all', dev: dev(netR - 0.05, 1) },
      ...(i ? [] : [{ id: 'placebo', name: 'p', dev: o.placebo ?? dev(0, 0.2) }]),
    ] })),
  ];
}
test('verdict: the rule fixed before the run', () => {
  const ok = wideVerdict(world({}));
  assert.equal(ok.outcome, 'better'); assert.equal(ok.pick?.id, 'w3m'); assert.equal(ok.wideMean, 0.1);
  assert.equal(wideVerdict(world({ wide: [0.05, 0.05, 0.055] })).checks.beatsNoise, false, 'inside the control\'s training noise');
  assert.equal(wideVerdict(world({ wide: [0.05, 0.05, 0.055] })).outcome, 'not-better');
  assert.equal(wideVerdict(world({ wideT: 1.5 })).outcome, 'not-better', 'no floor clears the bar');
  assert.equal(wideVerdict(world({ wideN: 200 })).checks.moreTotalR, false, 'a better average on far fewer trades');
  assert.equal(wideVerdict(world({ wideN: 200 })).outcome, 'not-better');
  const leak = wideVerdict(world({ placebo: dev(0.1, 3) }));
  assert.equal(leak.outcome, 'not-better'); assert.match(leak.message, /leaks/);
  assert.equal(wideVerdict(world({ wide: [0.1, 0.1] })).outcome, 'incomplete', 'too few draws');
});

test('override: keeps going in market hours, slowed, and rides out Dhan\'s rate limit', async () => {
  const { runWideGrid, LiveWindowError } = await import('../lib/ml/wideJob');
  const { DhanError } = await import('../lib/dhan');
  const files = new Map<string, Uint8Array>();
  const store = { get: async (k: string) => files.get(k), put: async (k: string, b: Uint8Array) => { files.set(k, b); } };
  const tuesday0930 = Date.parse('2026-11-10T09:30:00+05:30');
  const make = (override: boolean, failFirst: number) => {
    let calls = 0;
    const dhan = {
      intraday: async () => { throw new Error('not reached'); },
      daily: async () => { calls++; if (calls <= failFirst) throw new DhanError(429, 'DH-904', 'Too many requests'); return { t: [], o: [], h: [], l: [], c: [], v: [] }; },
    };
    let t = tuesday0930;
    const now = () => (t += 1); // a clock that barely moves keeps the run inside the window
    return { calls: () => calls, run: () => runWideGrid('r', t, { store, dhan, fetchText: async () => '', gridDir: mkdtempSync(join(tmpdir(), 'wide-')), now, override, minGapMs: 0 }) };
  };
  await assert.rejects(make(false, 0).run(), LiveWindowError, 'no override: stops');
  const o = make(true, 2);
  await assert.rejects(o.run(), /no Nifty 500 daily candles/, 'override: went past the window check to the (empty) Dhan reply');
  assert.equal(o.calls(), 3, 'two rate-limited replies retried');
});
