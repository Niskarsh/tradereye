import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candles } from '../lib/dhan';
import { toSessions, type Bar } from '../lib/live/enrich';
import { runDay, toSlots, valueArea, simulate, swingStop, Zone, DEFAULT_PARAMS } from '../lib/setups/engine';
import { roundTripCharges, sizeFor } from '../lib/setups/costs';
import { buildSummary, lookupFor, pack, passes, statsOf, unpack, applyFilter } from '../lib/setups/stats';
import { stretchBucket, timeBucket, slot30, EXIT_KEYS, TARGET_KEYS, type Signal, type Outcome } from '../lib/setups/cases';
import { screenerDays, monthsNeeded } from '../lib/setups/universe';

const IST = 19800;
const sec = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 - IST;

/** One session of 1-minute bars; px(k) = close of minute k (0 = 09:15). */
function session(date: string, px: (k: number) => number, vol: (k: number) => number = () => 1000, n = 375): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k < n; k++) {
    const c = px(k), o = k ? px(k - 1) : c;
    out.push({ t: sec(date, '09:15') + k * 60, o, h: Math.max(o, c) + 0.05, l: Math.min(o, c) - 0.05, c, v: vol(k) });
  }
  return out;
}
const toCandles = (bars: Bar[]): Candles => ({ t: bars.map((b) => b.t), o: bars.map((b) => b.o), h: bars.map((b) => b.h), l: bars.map((b) => b.l), c: bars.map((b) => b.c), v: bars.map((b) => b.v) });

/** 20 quiet prior sessions around 300 (gently waving, so ATR is about 0.5) */
function history(): ReturnType<typeof toSessions> {
  const bars: Bar[] = [];
  const start = Date.parse('2026-09-01T00:00:00Z');
  let n = 0;
  for (let i = 0; n < 20; i++) {
    const d = new Date(start + i * 86400_000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const date = d.toISOString().slice(0, 10);
    bars.push(...session(date, (k) => 300 + Math.sin(k / 6) * 0.6));
    n++;
  }
  return toSessions(toCandles(bars));
}
/** ~700 daily candles: 300 close, 6 rupee range (ADR 6) */
function dailyBefore(): Candles {
  const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < 700; i++) { c.t.push(sec('2024-01-01', '09:15') + i * 86400); c.o.push(300); c.h.push(303); c.l.push(297); c.c.push(300); c.v.push(4e6); }
  return c;
}

const DATE = '2026-10-01';

test('slots: the day must start at 09:15, gaps are filled flat', () => {
  const bars = session(DATE, () => 300).filter((_, k) => k !== 3);
  const s = toSlots(bars)!;
  assert.equal(s.n, 375);
  assert.equal(s.v[3], 0);
  assert.equal(s.c[3], s.c[2]);
  assert.equal(toSlots(session(DATE, () => 300).slice(1)), undefined);
});

test('M1 fires when the first 10-min candle breaks with Nifty up, and the trade is followed to its outcome', () => {
  // flat 09:15-09:24, then a steady climb; Nifty up 0.3% in the first 5 minutes
  const day = session(DATE, (k) => (k < 10 ? 300 : 300 + (k - 9) * 0.05));
  const nifty = session(DATE, (k) => 20000 * (1 + Math.min(k, 30) * 0.0006));
  const sigs = runDay({ symbol: 'TEST', date: DATE, history: history(), day, nifty, daily: dailyBefore(), simulate: true });
  const m1 = sigs.find((s) => s.case === 'M1' && s.dir === 1);
  assert.ok(m1, `M1 long expected, got ${sigs.map((s) => s.case + s.dir).join(',')}`);
  assert.equal(m1!.nFirst5, 'WITH');
  assert.equal(m1!.slot % 10, 0, 'decided at a 10-minute close');
  assert.equal(m1!.slot, 20, 'the first 10-min close beyond the opening candle (09:35)');
  assert.equal(m1!.out!.T1.hit, true);
  assert.ok(m1!.out!.T1.net < m1!.out!.T1.r, 'charges are taken off');
  // no short opening-range break on a straight climb
  assert.equal(sigs.some((s) => s.case === 'M1' && s.dir === -1), false);
});

test('no momentum trade when Nifty is against him', () => {
  const day = session(DATE, (k) => (k < 10 ? 300 : 300 + (k - 9) * 0.05));
  const nifty = session(DATE, (k) => 20000 * (1 - Math.min(k, 30) * 0.0006));
  const sigs = runDay({ symbol: 'TEST', date: DATE, history: history(), day, nifty, daily: dailyBefore(), simulate: true });
  assert.equal(sigs.some((s) => s.case === 'M1' && s.dir === 1), false);
});

test('R1: a run of 50%+ of the daily range that turns at the high is a reversal short to the POC', () => {
  // most volume around 300 (the POC), a run to 305 by 11:05, then a 10-min candle that drops back a rupee
  const day = session(DATE, (k) => (k < 60 ? 300 + Math.sin(k) * 0.1 : k < 110 ? 300 + (k - 60) * (5 / 49) : k < 120 ? 305 - (k - 109) * 0.15 : 303.5 - (k - 119) * 0.03),
    (k) => (k < 60 ? 5000 : 800));
  const nifty = session(DATE, () => 20000);
  const sigs = runDay({ symbol: 'TEST', date: DATE, history: history(), day, nifty, daily: dailyBefore(), simulate: true });
  const r1 = sigs.find((s) => s.case === 'R1');
  assert.ok(r1, `R1 expected, got ${sigs.map((s) => s.case + s.dir).join(',')}`);
  assert.equal(r1!.dir, -1);
  assert.equal(r1!.slot, 120, 'the 11:05 candle closes below the previous one: decided at 11:15');
  assert.ok(r1!.stretch >= 50 && r1!.stretch < 80, `stretch ${r1!.stretch}`);
  assert.equal(r1!.testNo, 1);
  assert.ok(Math.abs(r1!.target - 300) < 0.5, `target near the POC, got ${r1!.target}`);
  assert.ok(r1!.stop > r1!.entry);
  assert.equal(r1!.out!.TS.hit, true);
});

test('no hindsight: the live run on the day so far gives exactly the backtest signals up to that minute', () => {
  const day = session(DATE, (k) => 300 + Math.sin(k / 23) * 4 + k * 0.004, (k) => 1000 + (k % 13) * 120);
  const nifty = session(DATE, (k) => 20000 + Math.sin(k / 15) * 30 + k * 0.2);
  const base = { symbol: 'TEST', date: DATE, history: history(), nifty, daily: dailyBefore() };
  const full = runDay({ ...base, day });
  assert.ok(full.length > 3, 'the wavy day should produce some signals');
  for (const cut of [40, 100, 200, 300]) {
    const live = runDay({ ...base, day: day.slice(0, cut), nifty: nifty.slice(0, cut) });
    const want = full.filter((s) => s.slot <= cut).map((s) => `${s.case}${s.dir}@${s.slot}:${s.entry}/${s.stop}/${s.target}`);
    const got = live.map((s) => `${s.case}${s.dir}@${s.slot}:${s.entry}/${s.stop}/${s.target}`);
    assert.deepEqual(got, want, `cut at ${cut}`);
  }
});

test('outcome: a stop and a target in the same minute counts as the stop', () => {
  const day = toSlots(session(DATE, () => 300))!;
  day.h[20] = 302; day.l[20] = 298;
  const sig = { case: 'M1', dir: 1, entry: 300, stop: 299, target: 302, slot: 15, atr: 1 } as Signal;
  const o = simulate(sig, day, DEFAULT_PARAMS);
  assert.equal(o.T1.hit, false);
  assert.equal(o.T1.r, -1);
  assert.equal(o.XA.r, -1, 'discretionary exits are stopped too');
});

test('outcome: nothing reached -> closed at 15:00', () => {
  const day = toSlots(session(DATE, (k) => 300 + k * 0.001))!;
  const sig = { case: 'M1', dir: 1, entry: 300, stop: 299, target: 302, slot: 15, atr: 1 } as Signal;
  const o = simulate(sig, day, DEFAULT_PARAMS);
  assert.equal(o.T1.hit, false);
  assert.ok(o.T1.r > 0.3 && o.T1.r < 0.35, `r ${o.T1.r}`);
});

test('M9 limit order: filled 0.5 ATR back, or no trade', () => {
  const day = toSlots(session(DATE, (k) => (k < 20 ? 300 : 299.5 + (k - 20) * 0.05)))!;
  const sig = { case: 'M9', dir: 1, entry: 300, stop: 299, target: 302, slot: 15, atr: 1 } as Signal;
  const o = simulate(sig, day, DEFAULT_PARAMS);
  assert.equal(o.filled, true);
  assert.equal(o.T1.hit, true);
  const flat = toSlots(session(DATE, () => 301))!;
  assert.equal(simulate({ ...sig, entry: 301, stop: 300 }, flat, DEFAULT_PARAMS).filled, false);
});

test('charges: about ₹110 for a ₹300-risk trade with a 50 paise stop', () => {
  const qty = sizeFor(300, 0.5);
  assert.equal(qty, 600);
  const c = roundTripCharges(qty, 300, 300.5, 1);
  assert.ok(c > 100 && c < 120, `charges ${c}`); // ~0.37R: tight stops mean big size and big charges
});

test('value area holds 70% of the volume around the POC', () => {
  const bars = session(DATE, (k) => 300 + (k % 20) * 0.1, (k) => ((k % 20) >= 8 && (k % 20) <= 12 ? 10000 : 100));
  const va = valueArea(bars, 30)!;
  assert.ok(va.val <= va.poc && va.poc <= va.vah);
  assert.ok(va.poc > 300.7 && va.poc < 301.3, `poc ${va.poc}`);
});

test('buckets and stats', () => {
  assert.equal(stretchBucket(-5), '<0');
  assert.equal(stretchBucket(55), '50-60');
  assert.equal(stretchBucket(97), '95+');
  assert.equal(timeBucket(10), '09:20-09:45');
  assert.equal(timeBucket(120), '11:00-13:00');
  const mk = (i: number, hit: boolean): Signal => {
    const out = { mfe: 1, mae: 0.5, costR: 0.1 } as Outcome;
    for (const k of [...TARGET_KEYS, ...EXIT_KEYS]) out[k] = { hit, r: hit ? 1 : -1, net: hit ? 0.9 : -1.1, min: 10 };
    return {
      case: 'R1', symbol: 'X', date: i < 60 ? '2025-01-02' : '2026-01-02', slot: 100, dir: -1, entry: 300, stop: 301, target: 298, stopAtr: 1, atr: 1, capped: false, stopType: 'SWING',
      time: '09:45-11:00', nFirst5: 'FLAT', nDay: 'FLAT', nRecent: 'FLAT', rvol: 'LOW', openBusy: false, stretch: 85, emaInWay: false, gapPct: 0,
      testNo: i % 3 + 1, tests: i % 3 ? [40, 90] : [40], level: '', pullbackNo: 0, with: [], out,
    };
  };
  const sigs = Array.from({ length: 120 }, (_, i) => mk(i, i % 10 < 7));
  const st = statsOf(sigs, 'PRIMARY', '2025-07-01');
  assert.equal(st.n, 120);
  assert.equal(st.hit, 0.7);
  assert.ok(st.netR > 0);
  assert.equal(st.h1.n, 60);
  assert.equal(passes(st, { minHit: 0.6 }), true);
  assert.equal(passes(st, { minHit: 0.75 }), false);
  const sum = buildSummary(sigs, { runId: 't', createdAt: 0, period: { from: '2025-01-01', to: '2026-06-30', mid: '2025-07-01' }, universe: { source: 'test', symbols: 1, stockDays: 1 }, params: {} });
  const r1 = sum.cases.find((c) => c.id === 'R1')!;
  assert.equal(r1.stretchAtLeast!['80%+'].n, 120);
  assert.equal(r1.stretchAtLeast!['90%+'].n, 0);
  assert.deepEqual(r1.tests!.map((t) => [t.test, t.stats.n]), [['1', 40], ['2', 40], ['3+', 40]]);
  assert.equal(r1.tests![0].bySlot['10:45'].n, 40);
  assert.equal(r1.byOut.X6.n, 120);
  assert.equal(sum.cases.find((c) => c.id === 'A')!.stretchUnder!['under 50%'].n, 0);
  // a FAR signal (solid swing beyond 2x ATR) is counted as skipped, never as a trade
  const far = { ...mk(0, true), stopType: 'FAR' as const, out: undefined };
  const sum2 = buildSummary([...sigs, far], { runId: 't', createdAt: 0, period: { from: '2025-01-01', to: '2026-06-30', mid: '2025-07-01' }, universe: { source: 'test', symbols: 1, stockDays: 1 }, params: {} });
  assert.equal(sum2.cases.find((c) => c.id === 'R1')!.skippedFar, 1);
  assert.equal(sum2.cases.find((c) => c.id === 'R1')!.all.n, 120);
  assert.equal(slot30(100), '10:45');
  const hit = lookupFor(sum, { case: 'R1', stretch: 85, time: '09:45-11:00', nDay: 'FLAT' });
  assert.equal(hit?.key, 'R1|80-90|09:45-11:00|FLAT');
  assert.equal(lookupFor(sum, { case: 'M1', stretch: 10, time: '09:45-11:00', nDay: 'WITH' }), undefined);
  // packing round-trips
  assert.deepEqual(unpack(JSON.parse(JSON.stringify(pack(sigs)))), sigs);
  assert.equal(applyFilter(sigs, { time: ['11:00-13:00'] }).length, 0);
  assert.equal(applyFilter(sigs, { minStretch: 80 }).length, 120);
});

test('screener: price 250-340 at the previous close and 10-day average volume above 3M', () => {
  const d: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  const days = ['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16'];
  days.forEach((day, i) => { d.t.push(sec(day, '09:15')); d.o.push(300); d.h.push(301); d.l.push(299); d.c.push(i === 10 ? 400 : 300); d.v.push(4e6); });
  const pass = screenerDays(d, { priceMin: 250, priceMax: 340, avgVolMin: 3e6 }, '2026-01-01', '2026-01-31');
  // needs 10 prior days: the 11th day is the first; the day after the 400 close fails
  assert.deepEqual(pass, ['2026-01-15']);
  assert.deepEqual(monthsNeeded(['2026-03-03']), ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(monthsNeeded(['2026-03-20']), ['2026-02', '2026-03']);
});

/* ---- the whole job against a fake Dhan and a fake S3 ---------------------------------------------------- */
import { runBacktest } from '../lib/setups/job';
import { INDEX_KEY, STATUS_KEY, getJson, summaryKey, signalsKey, type RunStatus } from '../lib/setups/store';
import { unpack as unpack2, type Packed, type Summary } from '../lib/setups/stats';

function fakeWorld() {
  const files = new Map<string, Uint8Array>();
  const store = { get: async (k: string) => files.get(k), put: async (k: string, b: Uint8Array) => { files.set(k, b); } };
  const calls = { intraday: 0, daily: 0 };
  const weekdays = (from: string, to: string, inclusive: boolean) => {
    const out: string[] = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); inclusive ? t <= Date.parse(`${to}T00:00:00Z`) : t < Date.parse(`${to}T00:00:00Z`); t += 86400_000) {
      const d = new Date(t); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  };
  const base = (id: string) => (id === '19' ? 20000 : 300);
  const dhan = {
    async intraday(p: { securityId: string; from: string; to: string }) {
      calls.intraday++;
      const bars: Bar[] = [];
      for (const d of weekdays(p.from, p.to, true)) {
        const seed = Number(d.slice(8)) + Number(d.slice(5, 7)) * 31;
        bars.push(...session(d, (k) => base(p.securityId) * (1 + Math.sin(k / 11 + seed) * 0.006 + (k / 375) * 0.004 * Math.sin(seed)), (k) => 2000 + ((k * 7 + seed) % 17) * 300));
      }
      return toCandles(bars);
    },
    async daily(p: { securityId: string; from: string; to: string }) {
      calls.daily++;
      const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
      for (const d of weekdays(p.from, p.to, false)) { const b = base(p.securityId); c.t.push(sec(d, '09:15')); c.o.push(b); c.h.push(b * 1.01); c.l.push(b * 0.99); c.c.push(b); c.v.push(4e6); }
      return c;
    },
  };
  const master = 'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_TRADING_SYMBOL,SEM_SERIES\nNSE,E,101,EQUITY,AAA,EQ\nNSE,E,102,EQUITY,BBB,EQ\n';
  const fetchText = async (url: string) => (url.includes('scrip') ? master : 'Company Name,Industry,Symbol,Series,ISIN Code\nA,X,AAA,EQ,1\nB,X,BBB,EQ,2\n');
  return { files, store, calls, dhan, fetchText };
}

test('the backtest job: screener, history cache, results, run index and status', async () => {
  const w = fakeWorld();
  const now = () => Date.parse('2026-10-20T06:00:00Z');
  const { summary, signals } = await runBacktest('2026-10-20-11-30-ab12', { store: w.store, dhan: w.dhan, fetchText: w.fetchText, now, minGapMs: 0, years: 0.25 });
  assert.equal(summary.universe.symbols, 2);
  assert.ok(signals.length > 0, 'some signals');
  assert.ok(signals.every((s) => (s.stopType === 'FAR') === !s.out), 'every taken signal has an outcome, skipped ones none');
  const st = (await getJson<RunStatus>(w.store, STATUS_KEY))!;
  assert.equal(st.state, 'done');
  const idx = (await getJson<{ runId: string }[]>(w.store, INDEX_KEY))!;
  assert.equal(idx[0].runId, '2026-10-20-11-30-ab12');
  const saved = (await getJson<Summary>(w.store, summaryKey('2026-10-20-11-30-ab12')))!;
  assert.equal(saved.cases.length, 35);
  assert.ok(signals.filter((s) => s.slot !== 370).every((s) => s.inPlay !== undefined), 'every intraday signal knows whether its stock was in play');
  assert.ok(signals.every((s) => s.slot % 10 === 0), 'every decision at a 10-minute close');
  const r1 = unpack2((await getJson<Packed>(w.store, signalsKey('2026-10-20-11-30-ab12', 'R1')))!);
  assert.equal(r1.length, signals.filter((s) => s.case === 'R1').length);
  // a second run fetches only the month that was not finished; daily candles are fetched again (1 per stock + Nifty)
  const before = w.calls.intraday;
  await runBacktest('2026-10-20-12-00-cd34', { store: w.store, dhan: w.dhan, fetchText: w.fetchText, now, minGapMs: 0, years: 0.25 });
  assert.equal(w.calls.intraday - before, 3, 'only October again, for Nifty and the two stocks');
  const idx2 = (await getJson<{ runId: string }[]>(w.store, INDEX_KEY))!;
  assert.deepEqual(idx2.map((x) => x.runId), ['2026-10-20-12-00-cd34', '2026-10-20-11-30-ab12']);
});


/* ---- stops, tests of the high, discretionary exits ------------------------------------------------------- */

const b10 = (o: number, h: number, l: number, c: number) => ({ o, h, l, c, v: 1000 });

test('swing stop: beyond a tested, unbroken swing; 2x ATR when there is none; no trade when it is too far', () => {
  // a low at 99, a rally to 100.5 (width), a test back to 99.1 that closes above, then up to 101
  const bars = [b10(100, 100.2, 99.6, 99.8), b10(99.8, 99.9, 99.4, 99.5), b10(99.5, 99.6, 99.0, 99.4), b10(99.4, 100.0, 99.3, 99.9),
    b10(99.9, 100.5, 99.8, 100.4), b10(100.4, 100.4, 99.1, 99.6), b10(99.6, 100.6, 99.5, 100.5), b10(100.5, 101.1, 100.4, 101)];
  const s = swingStop(1, 100.8, 1, bars);
  assert.equal(s.type, 'SWING');
  assert.ok(Math.abs(s.stop - 98.9) < 1e-9, `stop ${s.stop}`);
  // not tested: no swing, 2x ATR
  const untested = bars.filter((_, i) => i !== 5);
  assert.deepEqual(swingStop(1, 100.8, 1, untested), { stop: 98.8, type: 'ATR2' });
  // broken: a later close below the low
  const broken = [...bars.slice(0, 7), b10(100.5, 100.5, 98.8, 98.9), b10(98.9, 101.1, 98.9, 101)];
  assert.equal(swingStop(1, 100.8, 1, broken).type, 'ATR2');
  // the same swing with a small ATR: 1.9 rupees away is more than 2x ATR (1.0) -> FAR, no trade
  assert.equal(swingStop(1, 100.8, 0.5, bars).type, 'FAR');
});

test('tests of the day high are counted, with their times', () => {
  const z = new Zone(1);
  z.push(b10(303, 304, 302.9, 303.9), 0, 1);    // makes the high: test 1 at 09:15
  z.push(b10(303.9, 303.95, 303.2, 303.3), 10, 1); // pulls back 0.8 ATR
  z.push(b10(303.3, 303.9, 303.2, 303.8), 20, 1);  // back within 0.25 ATR: test 2 at 09:35
  assert.deepEqual(z.tests, [0, 20]);
  z.push(b10(303.8, 303.85, 303.7, 303.8), 30, 1); // no pullback yet: not a new test
  assert.deepEqual(z.tests, [0, 20]);
  z.push(b10(303.8, 303.8, 303.1, 303.2), 40, 1);
  z.push(b10(303.2, 304.1, 303.2, 303.6), 50, 1);  // pokes 0.1 above and closes back: test 3
  assert.deepEqual(z.tests, [0, 20, 50]);
  assert.equal(z.testOf(b10(303.2, 304.1, 303.2, 303.6), 1), 3);
  z.push(b10(303.6, 305, 303.6, 304.9), 60, 1);    // a new high 0.9 above: a new zone, test 1
  assert.deepEqual(z.tests, [60]);
});

test('discretionary exits: no progress after 30 minutes, the next obstacle, the first of them', () => {
  // long at 300 (stop 299), drifts to 300.1 for an hour, then reaches 300.8 (an obstacle at 300.6)
  const day = toSlots(session(DATE, (k) => (k < 100 ? 300 + Math.min(k - 30, 60) * 0.0015 : 300 + (k - 100) * 0.02)))!;
  const sig = { case: 'A', dir: 1, entry: 300, stop: 299, target: 302, slot: 30, atr: 1 } as Signal;
  const ex = { obstacle: 300.6, medV: 1000, adr: 6, dayHi: 300, dayLo: 299.5, entryBar: { o: 300, h: 300.05, l: 299.95, c: 300, v: 1000 } };
  const o = simulate(sig, day, DEFAULT_PARAMS, ex);
  assert.ok(o.X6.min <= 31 && o.X6.r < 0.3, `no progress exit at ${o.X6.min} min, ${o.X6.r}R`);
  assert.ok(o.X5.r > 0.55 && o.X5.r < 0.65, `obstacle exit ${o.X5.r}R`);
  assert.equal(o.XA.min, o.X6.min, 'XA = the first marker');
  assert.equal(o.X6.hit, o.X6.net > 0);
});

/* ---- research cases ----------------------------------------------------------------------------------- */
import { runSwing } from '../lib/setups/swing';
import { deliveryCharges } from '../lib/setups/costs';

test('last half hour: Nifty up in its first 30 minutes, a stock up with it -> long at 15:00, out at the 15:29 close', () => {
  const day = session(DATE, (k) => 300 + Math.min(k, 30) * 0.03 + (k >= 345 ? (k - 344) * 0.02 : 0));
  const nifty = session(DATE, (k) => 20000 * (1 + Math.min(k, 30) * 0.0001));
  const sigs = runDay({ symbol: 'TEST', date: DATE, history: history(), day, nifty, daily: dailyBefore(), simulate: true });
  const l1 = sigs.find((s) => s.case === 'L1');
  assert.ok(l1, `L1 expected, got ${sigs.map((s) => s.case).join(',')}`);
  assert.equal(l1!.dir, 1);
  assert.equal(l1!.slot, 345, 'decided at 15:00');
  assert.equal(l1!.out!.TC.min, 30, 'held to the 15:29 close');
  assert.ok(l1!.out!.TC.r > 0);
  assert.equal(l1!.out!.TC.hit, l1!.out!.TC.net > 0);
});

test('end-of-day reversal: 1.5% worse than Nifty at 15:00 -> long', () => {
  const day = session(DATE, (k) => 300 - Math.min(k, 300) * 0.02);
  const nifty = session(DATE, () => 20000);
  const sigs = runDay({ symbol: 'TEST', date: DATE, history: history(), day, nifty, daily: dailyBefore(), simulate: true });
  const l2 = sigs.find((s) => s.case === 'L2');
  assert.ok(l2);
  assert.equal(l2!.dir, 1);
  assert.equal(l2!.slot, 345);
});

test('breakout fade: every breakout comes with the opposite trade at the same close', () => {
  const day = session(DATE, (k) => (k < 10 ? 300 : 300 + (k - 9) * 0.05));
  const nifty = session(DATE, (k) => 20000 * (1 + Math.min(k, 30) * 0.0006));
  const sigs = runDay({ symbol: 'TEST', date: DATE, history: history(), day, nifty, daily: dailyBefore(), simulate: true });
  const m1 = sigs.find((s) => s.case === 'M1')!;
  const fb = sigs.find((s) => s.case === 'FB')!;
  assert.ok(fb, 'FB expected');
  assert.equal(fb.dir, -m1.dir);
  assert.ok(fb.slot <= m1.slot, 'the first breakout of the day is faded');
  assert.ok(fb.stop > fb.entry);
});

test('5-day reversal: a 7%+ drop vs Nifty is bought at the close and held 5 sessions with delivery charges', () => {
  const d: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  const nc = new Map<string, number>();
  const px = (i: number) => (i < 30 ? 300 : i < 35 ? 300 - (i - 29) * 5 : 275 + (i - 34) * 3);
  for (let i = 0; i < 50; i++) {
    const day = new Date(Date.UTC(2026, 0, 1) + i * 86400_000).toISOString().slice(0, 10);
    d.t.push(sec(day, '09:15')); d.o.push(px(i)); d.h.push(px(i) + 1); d.l.push(px(i) - 1); d.c.push(px(i)); d.v.push(1e6);
    nc.set(day, 20000);
  }
  const sigs = runSwing('TEST', d, nc, '2026-01-01', '2026-12-31', { priceMin: 250, priceMax: 340, avgVolMin: 500_000 }, { riskInr: 300 });
  assert.equal(sigs.length, 1);
  const s = sigs[0];
  assert.equal(s.case, 'S1');
  assert.equal(s.date, '2026-02-04'); // the 5th day down: 300 -> 275 (-8.3%)
  assert.ok(s.out!.TC.r > 0, 'the bounce');
  assert.ok(s.out!.TC.net < s.out!.TC.r, 'delivery charges taken off');
  assert.ok(deliveryCharges(100, 300, 310) > 60 && deliveryCharges(100, 300, 310) < 90);
});

/* ---- delivery strategies --------------------------------------------------------------------------------- */
import { prepare, holdOutcome, runSingle, runMonthly, monthEndsOf } from '../lib/setups/swing';

function dailySeries(px: (i: number) => number, n: number, start = Date.UTC(2024, 0, 1)) {
  const d: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  const dates: string[] = [];
  for (let i = 0, t = start; d.t.length < n; t += 86400_000) {
    const day = new Date(t); if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    const date = day.toISOString().slice(0, 10); dates.push(date);
    const c = px(i), o = i ? px(i - 1) : c;
    d.t.push(sec(date, '09:15')); d.o.push(o); d.h.push(Math.max(o, c) + 1); d.l.push(Math.min(o, c) - 1); d.c.push(c); d.v.push(1e6);
    i++;
  }
  return { d, dates };
}

test('delivery hold: a gap through the stop exits at the open; the hold exit happens at its close', () => {
  const { d } = dailySeries((i) => (i < 20 ? 300 : i === 21 ? 280 : 302), 30);
  d.o[21] = 281; d.h[21] = 282; // opens below the stop
  const st = prepare('X', d);
  const h = holdOutcome(st, 20, 295, 5, 300)!;
  assert.equal(h.exitIdx, 21);
  assert.ok(h.out.TC.r < -1, 'the gap to 281 costs more than 1R');
  const up = prepare('Y', dailySeries((i) => 300 + Math.max(0, i - 20), 30).d);
  const h2 = holdOutcome(up, 20, 290, 5, 300, (j) => j === 23)!;
  assert.equal(h2.exitIdx, 23);
  assert.equal(h2.out.TC.min, 3 * 375);
});

test('RSI(2) pullback in an uptrend and a 55-day breakout are found', () => {
  // a slow uptrend from 250 to 320, a 3-day dip at day 260, a breakout to a new 55-day high at day 280
  const px = (i: number) => (i >= 258 && i <= 260 ? 250 + 258 * 0.25 - (i - 257) * 4 : 250 + i * 0.25 + (i >= 280 ? 6 : 0));
  const st = prepare('UP', dailySeries((i) => Math.min(px(i), 330), 400).d);
  const sigs = runSingle(st, '2024-01-01', '2026-12-31', { priceMin: 250, priceMax: 340, avgVolMin: 500_000 }, { riskInr: 300 });
  assert.ok(sigs.some((s) => s.case === 'D3'), `D3 expected: ${sigs.map((s) => s.case).join(',')}`);
  assert.ok(sigs.some((s) => s.case === 'D4'), 'D4 breakout expected');
});

test('monthly momentum buys the strongest steady riser and holds it to the next month-end', () => {
  const n = 330;
  const strong = dailySeries((i) => 200 + i * 0.4, n);           // steady +0.4 a day
  const weak = dailySeries((i) => 300 - i * 0.05, n);           // slowly falling
  const wavy = dailySeries((i) => 300 + Math.sin(i / 3) * 15, n); // flat, volatile
  const stocks = [prepare('STRONG', strong.d), prepare('WEAK', weak.d), prepare('WAVY', wavy.d)];
  const ends = monthEndsOf(strong.dates);
  const sigs = runMonthly(stocks, ends, '2024-12-01', '2025-12-31', { priceMin: 250, priceMax: 340, avgVolMin: 500_000 }, { riskInr: 300 }, 1);
  const d1 = sigs.filter((s) => s.case === 'D1');
  assert.ok(d1.length > 0);
  assert.ok(d1.every((s) => s.symbol === 'STRONG'), d1.map((s) => s.symbol).join(','));
  assert.ok(d1.every((s) => s.out!.TC.r > 0));
});

/* ---- his journal -------------------------------------------------------------------------------------- */
import { scoreTrades, myReport } from '../lib/setups/journal';

test('his trades: counted once per trade group, R from the risk he logged', () => {
  const headers = ['TradeGroupId', 'Date (IST)', 'Symbol', 'Direction', 'Price', 'Qty', 'GrossPnL', 'NetPnL', 'TotalCharges', 'Time (IST)', 'EntryTime', 'RiskInr', 'ExitType', 'Setup'];
  const rows = [
    ['g1', '2026-10-01', 'ABC', 'LONG', '300', '100', '400', '340', '60', '09:31:00', '09:31:00', '300', 'TARGET', 'momentum'],
    ['g1', '2026-10-01', 'ABC', 'LONG', '304', '100', '400', '340', '60', '09:50:00', '09:31:00', '300', 'TARGET', 'momentum'],
    ['g2', '2026-10-02', 'XYZ', 'SHORT', '280', '50', '-250', '-300', '50', '10:05:00', '10:05:00', '', 'STOP', 'reversal'],
  ].map((cells) => ({ cells }));
  const t = scoreTrades(headers, rows);
  assert.equal(t.length, 2);
  assert.equal(t[0].netR, 1.13);
  assert.equal(t[0].grossR, 1.33);
  assert.equal(t[1].riskLogged, false);
  assert.equal(t[1].netR, -1);
  const rep = myReport(t);
  assert.equal(rep.all.n, 2);
  assert.equal(rep.all.hit, 0.5);
  assert.equal(rep.all.totalNet, 40);
  assert.deepEqual(rep.byTime.map((x) => x.key), ['09:15', '09:45']);
});
