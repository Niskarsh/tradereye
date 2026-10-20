import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candles } from '../lib/dhan';
import { toSessions, type Bar } from '../lib/live/enrich';
import { runDay, toSlots, valueArea, simulate, DEFAULT_PARAMS } from '../lib/setups/engine';
import { roundTripCharges, sizeFor } from '../lib/setups/costs';
import { buildSummary, lookupFor, pack, passes, statsOf, unpack, applyFilter } from '../lib/setups/stats';
import { stretchBucket, timeBucket, type Signal } from '../lib/setups/cases';
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
  assert.ok(m1!.slot >= 10);
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
  // most volume around 300 (the POC), then a run to 304 (67% of a 6 rupee ADR) by 11:00, then a turn
  const day = session(DATE, (k) => (k < 60 ? 300 + Math.sin(k) * 0.1 : k < 105 ? 300 + (k - 60) * (4 / 45) : 304 - (k - 105) * 0.08),
    (k) => (k < 60 ? 5000 : 800));
  const nifty = session(DATE, () => 20000);
  const sigs = runDay({ symbol: 'TEST', date: DATE, history: history(), day, nifty, daily: dailyBefore(), simulate: true });
  const r1 = sigs.find((s) => s.case === 'R1');
  assert.ok(r1, `R1 expected, got ${sigs.map((s) => s.case + s.dir).join(',')}`);
  assert.equal(r1!.dir, -1);
  assert.ok(r1!.stretch >= 50 && r1!.stretch < 80, `stretch ${r1!.stretch}`);
  assert.ok(Math.abs(r1!.target - 300) < 0.5, `target near the POC, got ${r1!.target}`);
  assert.ok(r1!.stop > r1!.entry);
  assert.equal(r1!.out!.TS.hit, true);
});

test('no hindsight: the live run on the day so far gives exactly the backtest signals up to that minute', () => {
  const day = session(DATE, (k) => 300 + Math.sin(k / 9) * 2 + k * 0.004, (k) => 1000 + (k % 13) * 120);
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
  const mk = (i: number, hit: boolean): Signal => ({
    case: 'R1', symbol: 'X', date: i < 60 ? '2025-01-02' : '2026-01-02', slot: 100, dir: -1, entry: 300, stop: 301, target: 298, stopAtr: 1, atr: 1, capped: false,
    time: '09:45-11:00', nFirst5: 'FLAT', nDay: 'FLAT', nRecent: 'FLAT', rvol: 'LOW', openBusy: false, stretch: 85, emaInWay: false, gapPct: 0, with: [],
    out: { T1: { hit, r: hit ? 1 : -1, net: hit ? 0.9 : -1.1, min: 10 }, T15: { hit, r: hit ? 1.5 : -1, net: hit ? 1.4 : -1.1, min: 12 }, TS: { hit, r: hit ? 2 : -1, net: hit ? 1.9 : -1.1, min: 15 }, mfe: 1, mae: 0.5, costR: 0.1 },
  });
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
  assert.ok(signals.every((s) => s.out), 'every signal has an outcome');
  const st = (await getJson<RunStatus>(w.store, STATUS_KEY))!;
  assert.equal(st.state, 'done');
  const idx = (await getJson<{ runId: string }[]>(w.store, INDEX_KEY))!;
  assert.equal(idx[0].runId, '2026-10-20-11-30-ab12');
  const saved = (await getJson<Summary>(w.store, summaryKey('2026-10-20-11-30-ab12')))!;
  assert.equal(saved.cases.length, 17);
  const r1 = unpack2((await getJson<Packed>(w.store, signalsKey('2026-10-20-11-30-ab12', 'R1')))!);
  assert.equal(r1.length, signals.filter((s) => s.case === 'R1').length);
  // a second run fetches only the month that was not finished; daily candles are fetched again (1 per stock + Nifty)
  const before = w.calls.intraday;
  await runBacktest('2026-10-20-12-00-cd34', { store: w.store, dhan: w.dhan, fetchText: w.fetchText, now, minGapMs: 0, years: 0.25 });
  assert.equal(w.calls.intraday - before, 3, 'only October again, for Nifty and the two stocks');
  const idx2 = (await getJson<{ runId: string }[]>(w.store, INDEX_KEY))!;
  assert.deepEqual(idx2.map((x) => x.runId), ['2026-10-20-12-00-cd34', '2026-10-20-11-30-ab12']);
});
