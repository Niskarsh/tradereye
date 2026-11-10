import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candles } from '../lib/dhan';
import { toSessions, type Bar } from '../lib/live/enrich';
import { gridDay, liqBand, ML_COLS, ML_WIDTH, WIDE_LAST_SLOT, wideVol } from '../lib/ml/grid';
import { GridWriter } from '../lib/ml/writer';
import { etfSymbols, inLiveWindow, LIQ_SHARES_BP, WIDE_ITERATION, wideDays, wideVerdict, wideVerdict15, type WideShard } from '../lib/ml/wide';
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
  assert.equal(inLiveWindow(at('2026-11-11', '08:39')), false);
  assert.equal(inLiveWindow(at('2026-11-11', '08:40')), true);
  assert.equal(inLiveWindow(at('2026-11-11', '11:14')), true);
  assert.equal(inLiveWindow(at('2026-11-11', '11:15')), false);
  assert.equal(inLiveWindow(at('2026-11-10', '09:30')), false, 'Diwali Balipratipada: NSE holiday');
  assert.equal(inLiveWindow(at('2026-12-25', '09:30')), false, 'Christmas');
  assert.equal(inLiveWindow(at('2026-11-14', '09:30')), false, 'Saturday');
});

const dev = (netR: number, t = 3, n = 500, sumR = netR * n) => ({ n, netR, t, sumR });
const examOk = { n: 60, netR: 0.05, t: 1, pass: true }, examBad = { n: 60, netR: -0.05, t: -1, pass: false };
const FLOORS = [50, 100, 170], CAPS3 = [3, 4];
type CellFn = (size: number, f: number, c: number, gate: boolean) => number;
type ExamFn = (size: number, f: number, c: number, gate: boolean) => boolean;
/** iteration 15: the block at ₹10 lakh (and gated) in 'wide' with draws, the ladder in 'ladder' (main only) */
function world(o: { cell?: CellFn; exam?: ExamFn; seedsOf?: number[]; narrow?: number[]; placebo?: ReturnType<typeof dev>; pools?: Record<string, number> }): WideShard[] {
  const cell = o.cell ?? (() => 0.0), exam = o.exam ?? (() => true);
  const narrow = o.narrow ?? [0.01, 0.02, 0.03];
  const pools = o.pools ?? { 50: 117, 100: 70, 170: 55 };
  const block = (size: number, gate: boolean, bump: number) => FLOORS.flatMap((f) => CAPS3.map((c) => ({
    id: `w${size}_f${f}_c${c}${gate ? '_g' : ''}`, name: `₹${size} lakh · ₹${f} cr · ${c}${gate ? ' · gate' : ''}`, dev: dev(cell(size, f, c, gate) + bump),
    exam: exam(size, f, c, gate) ? examOk : examBad, money: { tradesPerMonth: 10 * c, stopPct: 2.32 } })));
  const seeds = o.seedsOf ?? [0, 0.01, -0.01];
  const seed = (i: number) => (i ? `seed${i + 1}` : 'main');
  return [
    ...narrow.map((netR, i): WideShard => ({ universe: 'narrow', shard: seed(i), strategies: [{ id: 'nT10', name: 'control at size', dev: dev(netR), money: { tradesPerMonth: 20, stopPct: 2.32 } }] })),
    ...seeds.map((b, i): WideShard => ({ universe: 'wide', shard: seed(i), pools, strategies: [...block(10, false, b), ...block(10, true, b), ...(i ? [] : [{ id: 'placebo', name: 'p', dev: o.placebo ?? dev(0, 0.2) }])] })),
    { universe: 'ladder', shard: 'main', pools, strategies: [5, 8, 12, 15].flatMap((k) => block(k, false, 0)) },
  ];
}
// bigger orders cost more impact: R a trade falls with size
const sized: CellFn = (size, f, c) => 0.11 - size * 0.003 + (f === 100 ? 0.005 : 0) + (c === 4 ? 0.002 : 0);
test('verdict (iteration 15): the block that holds and makes the most rupees a month wins', () => {
  const v = wideVerdict15(world({ cell: sized }));
  assert.equal(v.outcome, 'better', v.message);
  assert.equal(v.blocks?.length, 6, '5 sizes + the gated ₹10 lakh block');
  assert.ok(v.blocks?.every((b) => b.holds), JSON.stringify(v.blocks));
  // R a month x size: 15 lakh makes the most rupees even at a lower R a trade
  assert.equal(v.pick?.id, 'w15_f100_c4');
  assert.equal(v.goal?.position, 1_500_000); assert.equal(v.goal?.riskPerTrade, 34800);
  assert.equal(v.grid?.length, 36);
});
test('verdict (iteration 15): iteration 14 again (good decide months, the exam lost in most cells) holds nowhere', () => {
  // the shape iteration 14 had at ₹10 lakh: 2 of 6 cells profitable on the exam
  const exam: ExamFn = (_s, f, c) => (f === 50 && c === 3) || (f === 100 && c === 4);
  const v = wideVerdict15(world({ cell: () => 0.07, exam }));
  assert.equal(v.outcome, 'not-better'); assert.equal(v.checks.floor, false); assert.equal(v.pick, null);
  assert.match(v.message, /No block holds.*2\/6 profitable on the exam/);
});
test('verdict (iteration 15): one weak cell is fine, two are not', () => {
  const one = wideVerdict15(world({ cell: (s, f, c) => (f === 170 && c === 3 ? 0.01 : 0.07) }));
  assert.equal(one.outcome, 'better', one.message);
  const two = wideVerdict15(world({ cell: (s, f) => (f === 170 ? 0.01 : 0.07) }));
  assert.equal(two.checks.floor, false); assert.equal(two.outcome, 'not-better');
});
test('verdict (iteration 15): the gated block can win where the plain one fails the exam', () => {
  const v = wideVerdict15(world({ cell: () => 0.07, exam: (s, f, c, g) => g }));
  assert.equal(v.outcome, 'better', v.message); assert.equal(v.pick?.id.endsWith('_g'), true);
  assert.equal(v.blocks?.find((b) => b.gate)?.holds, true); assert.equal(v.blocks?.find((b) => !b.gate && b.size === 10)?.holds, false);
});
test('verdict (iteration 15): a pick with too few stocks a day is not solid; training luck or a leak fails', () => {
  const thin = wideVerdict15(world({ cell: () => 0.07, pools: { 50: 30, 100: 20, 170: 10 } }));
  assert.equal(thin.checks.floor, true); assert.equal(thin.pick, null); assert.equal(thin.outcome, 'not-better');
  const near = wideVerdict15(world({ cell: () => 0.06, narrow: [0.06, 0.07, 0.065] }));
  assert.equal(near.checks.beatsNoise, false); assert.equal(near.outcome, 'not-better');
  const leak = wideVerdict15(world({ cell: () => 0.08, placebo: dev(0.1, 3) }));
  assert.equal(leak.outcome, 'not-better'); assert.match(leak.message, /leaks/);
});

// iteration 16: references and liquidity-sized versions in 'wide' (5 draws), the control in 'narrow'
type LiqFn = (bp: number | null, floor: number, gate: boolean) => { netR: number; exam?: boolean; inr?: number; examInr?: number };
function world16(o: { cell: LiqFn; ns?: { sumR: number; n: number; exam?: boolean }; narrow?: number[]; placebo?: ReturnType<typeof dev>; pools?: Record<string, number> }): WideShard[] {
  const narrow = o.narrow ?? [0.01, 0.02, 0.03];
  const pools = o.pools ?? { 100: 70, 170: 41 };
  const mk = (bp: number | null, f: number, g: boolean, bump: number) => {
    const c = o.cell(bp, f, g), id = `${bp === null ? 'w10' : `l${bp}`}_f${f}_c3${g ? '_g' : ''}`;
    return { id, name: id, dev: dev(c.netR + bump), exam: c.exam === false ? examBad : examOk, money: { tradesPerMonth: 27, stopPct: 2.3 },
      inr: { perMonth: c.inr ?? 50000, examPerMonth: c.examInr ?? 10000, avgPosition: 1_000_000, avgRisk: 23000, capital: 600000 } };
  };
  const all = (bump: number) => [
    mk(null, 100, false, bump), mk(null, 100, true, bump),
    ...[false, true].flatMap((g) => [100, 170].flatMap((f) => LIQ_SHARES_BP.map((bp) => mk(bp, f, g, bump)))),
  ];
  const seed = (i: number) => (i ? `seed${i + 1}` : 'main');
  return [
    ...narrow.map((netR, i): WideShard => ({ universe: 'narrow', shard: seed(i), strategies: [{ id: 'nT10', name: 'c', dev: dev(netR), money: { tradesPerMonth: 20, stopPct: 2.3 } }] })),
    ...[0, 0.01, -0.01].map((b, i): WideShard => ({ universe: 'wide', shard: seed(i), pools, strategies: [...all(b), ...(i ? [] : [
      { id: 'placebo', name: 'p', dev: o.placebo ?? dev(0, 0.2) },
      ...(o.ns ? [{ id: 'l20_f100_c3_g_ns', name: 'ns', dev: dev(0.08), exam: o.ns.exam === false ? examBad : examOk, nsCheck: { base: 'l20_f100_c3_g', decide: { months: 3, n: o.ns.n, sumR: o.ns.sumR, rupees: 0 }, exam: { months: 1, n: 0, sumR: 0, rupees: 0 } } },
        { id: 'w10_f100_c3_g_ns', name: 'ns', dev: dev(0.08), exam: examOk, nsCheck: { base: 'w10_f100_c3_g', decide: { months: 3, n: o.ns.n, sumR: o.ns.sumR, rupees: 0 }, exam: { months: 1, n: 0, sumR: 0, rupees: 0 } } }] : []),
    ])] })),
  ];
}
const liq: LiqFn = (bp, f, g) => ({ netR: 0.08, inr: bp === 20 && f === 100 && g ? 80000 : bp === null ? 55000 : 60000 });
test('verdict (iteration 16): the liquidity-sized version making the most rupees beats iteration 15\'s pick', () => {
  const v = wideVerdict(world16({ cell: liq, ns: { sumR: 4, n: 30 } }));
  assert.equal(v.outcome, 'better', v.message); assert.equal(v.pick?.id, 'l20_f100_c3_g');
  assert.equal(v.goal?.perMonth, 80000); assert.equal(v.standAside?.drop, true); assert.match(v.message, /Drop the stand-aside/);
  assert.equal(v.liquidity?.find((c) => c.id === 'l20_f100_c3_g')?.neighboursOk, 3);
});
test('verdict (iteration 16): no winner keeps iteration 15\'s pick; the stand-aside stays when its months lost', () => {
  const v = wideVerdict(world16({ cell: (bp) => ({ netR: 0.08, inr: bp === null ? 55000 : 40000 }), ns: { sumR: -2, n: 30 } }));
  assert.equal(v.outcome, 'not-better'); assert.equal(v.pick?.id, 'w10_f100_c3_g'); assert.match(v.message, /stays the pick.*Keep the stand-aside/);
  assert.equal(v.standAside?.drop, false);
});
test('verdict (iteration 16): neighbours, the exam in rupees and training luck each block a winner', () => {
  // its share neighbours lose on the exam, and ₹170 crore at the same share too: 0 of 3
  const lonely = wideVerdict(world16({ cell: (bp, f, g) => ({ netR: 0.08, exam: bp === 20 && f === 100 && g, inr: bp === 20 && f === 100 && g ? 90000 : 50000 }) }));
  assert.notEqual(lonely.pick?.id, 'l20_f100_c3_g');
  const examRs = wideVerdict(world16({ cell: (bp, f, g) => ({ netR: 0.08, inr: bp === 20 && f === 100 && g ? 90000 : 50000, examInr: bp === 20 && f === 100 && g ? -5000 : 10000 }) }));
  assert.notEqual(examRs.pick?.id, 'l20_f100_c3_g');
  const luck = wideVerdict(world16({ cell: liq, narrow: [0.08, 0.09, 0.085] }));
  assert.equal(luck.checks.beatsNoise, false); assert.match(luck.message, /do not move Algo Live/);
  const thin = wideVerdict(world16({ cell: liq, pools: { 100: 30, 170: 20 } }));
  assert.equal(thin.pick, null);
});

test('ETFs are left out: by instrument type, by fund name, by symbol', () => {
  const csv = [
    'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_TRADING_SYMBOL,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME',
    'NSE,E,1,EQUITY,CUPID,ES,EQ,CUPID LIMITED',
    'NSE,E,2,EQUITY,MONQ50,ES,EQ,"MOTILAL OSWAL NASDAQ 100 ETF"',
    'NSE,E,3,EQUITY,GOLDBEES,ES,EQ,NIPPON INDIA GOLD',
    'NSE,E,4,EQUITY,ABCFUND,ETF,EQ,SOMETHING',
    'NSE,E,5,EQUITY,HDFCNIF,ES,EQ,HDFC NIFTY 50 INDEX FUND',
    'NSE,E,6,EQUITY,TATACHEM,ES,EQ,TATA CHEMICALS LTD',
    'BSE,E,7,EQUITY,OTHERETF,ES,A,BSE ONE',
  ].join('\n');
  const e = etfSymbols(csv);
  for (const s of ['MONQ50', 'GOLDBEES', 'ABCFUND', 'HDFCNIF', 'NIFTYBEES']) assert.ok(e.has(s), s);
  for (const s of ['CUPID', 'TATACHEM', 'OTHERETF']) assert.ok(!e.has(s), s);
});

test('override: keeps going in market hours, slowed, and rides out Dhan\'s rate limit', async () => {
  const { runWideGrid, LiveWindowError } = await import('../lib/ml/wideJob');
  const { DhanError } = await import('../lib/dhan');
  const files = new Map<string, Uint8Array>();
  const store = { get: async (k: string) => files.get(k), put: async (k: string, b: Uint8Array) => { files.set(k, b); } };
  const tuesday0930 = Date.parse('2026-11-11T09:30:00+05:30'); // a Wednesday, in fact: a trading day
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

test('holiday not in the list: from 09:20 the run sees no Nifty candles today and goes full speed', async () => {
  const { runWideGrid, LIVE_WINDOW_GAP_MS } = await import('../lib/ml/wideJob');
  const files = new Map<string, Uint8Array>();
  const store = { get: async (k: string) => files.get(k), put: async (k: string, b: Uint8Array) => { files.set(k, b); } };
  const go = async (start: string, todayBars: boolean, override = true) => {
    let checks = 0; const logs: string[] = [];
    let t = Date.parse(start);
    const dhan = {
      intraday: async () => { checks++; const s = Math.floor(t / 1000); return todayBars ? { t: [s], o: [1], h: [1], l: [1], c: [1], v: [1] } : { t: [], o: [], h: [], l: [], c: [], v: [] }; },
      daily: async () => ({ t: [], o: [], h: [], l: [], c: [], v: [] }),
    };
    const began = Date.now();
    await runWideGrid('r', t, { store, dhan, fetchText: async () => '', gridDir: mkdtempSync(join(tmpdir(), 'wide-')), now: () => (t += 1), override, minGapMs: 0, log: (m) => logs.push(m) }).catch(() => {});
    return { checks, logs, waited: Date.now() - began };
  };
  const closed = await go('2027-01-04T09:30:00+05:30', false); // a Monday not in the list, no candles
  assert.equal(closed.checks, 1); assert.ok(closed.logs.some((l) => /closed today/.test(l)), closed.logs.join('|'));
  const trading = await go('2027-01-04T09:30:00+05:30', true);
  assert.equal(trading.checks, 1); assert.ok(!trading.logs.some((l) => /closed today/.test(l)), 'a trading day stays slow');
  const early = await go('2027-01-04T09:00:00+05:30', false);
  assert.equal(early.checks, 0, 'before 09:20 an empty reply proves nothing: no check');
  assert.ok(LIVE_WINDOW_GAP_MS >= 1000);
});

test('a "no data plan" reply on one stock skips it when the profile says the plan is active; a lapsed plan still stops', async () => {
  const { runWideGrid } = await import('../lib/ml/wideJob');
  const { DhanError } = await import('../lib/dhan');
  const files = new Map<string, Uint8Array>();
  const store = { get: async (k: string) => files.get(k), put: async (k: string, b: Uint8Array) => { files.set(k, b); } };
  const csv = 'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_TRADING_SYMBOL,SEM_SERIES\nNSE,E,11,EQUITY,AAA,EQ\nNSE,E,22,EQUITY,BBB,EQ\n';
  const daily = () => { const d: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] }; for (let i = 0; i < 40; i++) { d.t.push(Date.parse('2026-09-01T04:00:00Z') / 1000 + i * 86400); d.o.push(300); d.h.push(303); d.l.push(297); d.c.push(300); d.v.push(4e6); } return d; };
  const go = async (plan: string) => {
    const logs: string[] = [];
    const dhan = {
      daily: async (p: { securityId: string }) => { if (p.securityId === '22') throw new DhanError(400, 'DH-902', 'Data APIs not subscribed'); return daily(); },
      intraday: async () => ({ t: [], o: [], h: [], l: [], c: [], v: [] }),
      profile: async () => ({ dhanClientId: 'x', dataPlan: plan, dataValidity: '2026-12-01' }),
    };
    let t = Date.parse('2026-11-14T20:00:00+05:30');
    const r = await runWideGrid('r', t, { store, dhan, fetchText: async () => csv, gridDir: mkdtempSync(join(tmpdir(), 'wide-')), now: () => (t += 1), minGapMs: 0, from: '2026-10-01', log: (m) => logs.push(m) }).then(() => 'ok', (e: Error) => e.message);
    return { r, logs };
  };
  const ok = await go('Active');
  assert.equal(ok.r, 'ok', ok.r); assert.ok(ok.logs.some((l) => /BBB daily: Dhan replied HTTP 400 DH-902/.test(l)), ok.logs.join('|'));
  const lapsed = await go('Inactive');
  assert.match(lapsed.r, /profile says the data plan is "Inactive"/);
});

test('the Run card names the iteration the models script actually runs', () => {
  const py = readFileSync(join(__dirname, '..', 'scripts', 'ml_wide.py'), 'utf8');
  assert.equal(Number(/^ITERATION = (\d+)/m.exec(py)?.[1]), WIDE_ITERATION);
});
