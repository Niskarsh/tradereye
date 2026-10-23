import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candles } from '../lib/dhan';
import { toSessions, type Bar } from '../lib/live/enrich';
import { BIG_NOTIONAL, MID_NOTIONAL, NEAR_TARGET_ADR, FAR_TARGET_ADR, OPEN_SLIP_TICKS, CLOSE_STOP_ADR, gridDay, LATE_END, ML_COLS, ML_KEYS, ML_WIDTH, STOP_ATR, TARGET_ATR, WIDE_STOP_ADR, WIDE_TARGET_ADR, LIQ_BANDS, FAST_STOP_FRAC, liqBand } from '../lib/ml/grid';
import { roundTripCharges, sizeFor } from '../lib/setups/costs';
import { TICK, onTick } from '../lib/study/mine';

const IST = 19800;
const sec = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 - IST;
function session(date: string, px: (k: number) => number, rnd = () => 0.5): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k < 375; k++) { const c = px(k), o = k ? px(k - 1) : c; out.push({ t: sec(date, '09:15') + k * 60, o, h: Math.max(o, c) + Math.round(rnd() * 3) * 0.05, l: Math.min(o, c) - Math.round(rnd() * 3) * 0.05, c, v: 500 + Math.floor(rnd() * 1500) }); }
  return out;
}
const hist = () => { const b: Bar[] = []; for (let i = 0; i < 20; i++) b.push(...session(`2024-12-${String(i + 1).padStart(2, '0')}`, (k) => 300 + Math.sin(k / 6) * 0.6)); return toSessions({ t: b.map((x) => x.t), o: b.map((x) => x.o), h: b.map((x) => x.h), l: b.map((x) => x.l), c: b.map((x) => x.c), v: b.map((x) => x.v) }); };
const daily = (): Candles => { const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] }; for (let i = 0; i < 700; i++) { c.t.push(i); c.o.push(300); c.h.push(303); c.l.push(297); c.c.push(300); c.v.push(4e6); } return c; };

function walk(seed: number) {
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  let p = 300; const px: number[] = []; for (let k = 0; k < 375; k++) { p = Math.round((p + (rnd() - 0.5) * 0.7) * 20) / 20; px.push(p); }
  return { px, rnd };
}

test('grid: a row at every 10-min close 09:25-14:45, each the right width', () => {
  const { px, rnd } = walk(3);
  const rows = gridDay({ date: '2025-02-03', history: hist(), day: session('2025-02-03', (k) => px[k], rnd), nifty: session('2025-02-03', () => 20000), daily: daily() });
  assert.equal(rows.length, 33);
  assert.deepEqual(rows.map((r) => r[0]), Array.from({ length: 33 }, (_, i) => 10 + i * 10));
  assert.ok(rows.every((r) => r.length === ML_WIDTH - 2));
});

test('grid: the long / short results match an independent replay of the bracket trade', () => {
  const H = hist();
  let checked = 0;
  for (let seed = 1; seed <= 15; seed++) {
    const { px, rnd } = walk(seed * 7);
    const date = `2025-03-${String(seed + 3).padStart(2, '0')}`;
    const day = session(date, (k) => px[k], rnd);
    const rows = gridDay({ date, history: H, day, nifty: session(date, () => 20000), daily: daily() });
    const iAtr = 1 + ML_KEYS.indexOf('atrPct'), iPx = 1 + ML_KEYS.indexOf('priceRs');
    for (const r of rows) {
      const k = r[0], close = day[k - 1].c;
      assert.ok(Math.abs(r[iPx] - close) < 1e-9, 'price = the 10-min close');
      const atr = (r[iAtr] / 100) * close;
      for (const [d, at] of [[1, ML_KEYS.length + 1], [-1, ML_KEYS.length + 2]] as const) {
        const entry = close + d * TICK, stop = onTick(close - d * STOP_ATR * atr, (-d) as 1 | -1), tgt = onTick(close + d * TARGET_ATR * atr, d);
        let sAt = -1, tAt = -1;
        for (let s = k; s < 345; s++) {
          if (sAt < 0 && (d === 1 ? day[s].l <= stop : day[s].h >= stop)) sAt = s;
          if (tAt < 0 && (d === 1 ? day[s].h >= tgt + TICK : day[s].l <= tgt - TICK)) tAt = s;
        }
        const win = tAt >= 0 && (sAt < 0 || tAt < sAt);
        const exit = win ? tgt : sAt >= 0 ? stop - d * TICK : day[344].c - d * TICK;
        const dist = (entry - stop) * d, qty = sizeFor(300, dist);
        const net = ((exit - entry) * d) / dist - roundTripCharges(qty, entry, exit, d) / (qty * dist);
        assert.ok(Math.abs(r[at] - net) < 0.011, `${date} ${k} ${d}: ${r[at]} vs ${net}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 500);
});

test('grid: the wide bracket and the ride to the close match an independent replay (after and before costs)', () => {
  const H = hist();
  const col = (c: string) => ML_COLS.indexOf(c) - 2; // rows carry [slot, ...] without sym / date
  const iAdr = 1 + ML_KEYS.indexOf('adrPct');
  let checked = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const { px, rnd } = walk(seed * 13 + 5);
    const date = `2025-06-${String(seed + 2).padStart(2, '0')}`;
    const day = session(date, (k) => px[k], rnd);
    const rows = gridDay({ date, history: H, day, nifty: session(date, () => 20000), daily: daily() });
    for (const r of rows) {
      const k = r[0], close = day[k - 1].c, adr = (r[iAdr] / 100) * close;
      assert.ok(Math.abs(adr - 6) < 1e-6, 'usual daily range = the 10-day average high - low');
      const replay = (d: 1 | -1, stopAdr: number, targetAdr?: number) => {
        const entry = close + d * TICK * (k < 20 ? OPEN_SLIP_TICKS : 1), stop = onTick(close - d * stopAdr * adr, (-d) as 1 | -1);
        const tgt = targetAdr === undefined ? undefined : onTick(close + d * targetAdr * adr, d);
        let sAt = -1, tAt = -1;
        for (let s = k; s < LATE_END; s++) {
          if (sAt < 0 && (d === 1 ? day[s].l <= stop : day[s].h >= stop)) sAt = s;
          if (tgt !== undefined && tAt < 0 && (d === 1 ? day[s].h >= tgt + TICK : day[s].l <= tgt - TICK)) tAt = s;
        }
        const win = tgt !== undefined && tAt >= 0 && (sAt < 0 || tAt < sAt);
        const exit = win ? tgt! : sAt >= 0 ? stop - d * TICK : day[LATE_END - 1].c - d * TICK;
        const dist = (entry - stop) * d, qty = sizeFor(300, dist);
        const g = ((exit - entry) * d) / dist;
        return { g, net: g - roundTripCharges(qty, entry, exit, d) / (qty * dist) };
      };
      for (const d of [1, -1] as const) {
        const s = d === 1 ? 'L' : 'S';
        const w = replay(d, WIDE_STOP_ADR, WIDE_TARGET_ADR), c = replay(d, CLOSE_STOP_ADR);
        assert.ok(Math.abs(r[col(`wb${s}`)] - w.net) < 0.002 && Math.abs(r[col(`wb${s}g`)] - w.g) < 0.002, `wide ${date} ${k} ${d}`);
        assert.ok(Math.abs(r[col(`cc${s}`)] - c.net) < 0.002 && Math.abs(r[col(`cc${s}g`)] - c.g) < 0.002, `close ${date} ${k} ${d}`);
        assert.ok(r[col(`wb${s}`)] < r[col(`wb${s}g`)] && r[col(`cc${s}`)] < r[col(`cc${s}g`)], 'costs always cost');
        checked++;
      }
      assert.ok(Math.abs(r[col('ccRet')] - (day[LATE_END - 1].c / close - 1) * 100) < 1e-9, 'the plain move to 15:15');
    }
  }
  assert.ok(checked > 300);
});

test('grid: bigger positions (₹1 lakh / ₹3 lakh, market orders) match an independent replay and cost less in R', () => {
  const H = hist();
  const col = (c: string) => ML_COLS.indexOf(c) - 2;
  const iAdr = 1 + ML_KEYS.indexOf('adrPct');
  let n = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const { px, rnd } = walk(seed * 17 + 1);
    const date = `2025-07-${String(seed + 2).padStart(2, '0')}`;
    const day = session(date, (k) => px[k], rnd);
    for (const r of gridDay({ date, history: H, day, nifty: session(date, () => 20000), daily: daily() })) {
      const k = r[0], close = day[k - 1].c, adr = (r[iAdr] / 100) * close;
      for (const d of [1, -1] as const) {
        const S = d === 1 ? 'L' : 'S';
        const entry = close + d * TICK * (k < 20 ? OPEN_SLIP_TICKS : 1), stop = onTick(close - d * WIDE_STOP_ADR * adr, (-d) as 1 | -1), tgt = onTick(close + d * WIDE_TARGET_ADR * adr, d);
        let sAt = -1, tAt = -1;
        for (let s = k; s < LATE_END; s++) {
          if (sAt < 0 && (d === 1 ? day[s].l <= stop : day[s].h >= stop)) sAt = s;
          if (tAt < 0 && (d === 1 ? day[s].h >= tgt + TICK : day[s].l <= tgt - TICK)) tAt = s;
        }
        const win = tAt >= 0 && (sAt < 0 || tAt < sAt);
        const exit = win ? tgt : sAt >= 0 ? stop - d * TICK : day[LATE_END - 1].c - d * TICK;
        const dist = (entry - stop) * d, g = ((exit - entry) * d) / dist;
        for (const [suf, notional] of [['1', MID_NOTIONAL], ['3', BIG_NOTIONAL]] as const) {
          const qty = Math.floor(notional / entry);
          const net = g - roundTripCharges(qty, entry, exit, d) / (qty * dist);
          assert.ok(Math.abs(r[col(`wb${S}${suf}`)] - net) < 0.002, `${date} ${k} ${d} ${suf}`);
        }
        assert.ok(r[col(`wb${S}3`)] >= r[col(`wb${S}1`)] - 1e-9 && r[col(`wb${S}1`)] > r[col(`wb${S}`)], 'bigger position, smaller charges in R');
        n++;
      }
    }
  }
  assert.ok(n > 300);
});

test('grid: the short with a nearer / farther target matches an independent replay', () => {
  const H = hist();
  const col = (c: string) => ML_COLS.indexOf(c) - 2;
  const iAdr = 1 + ML_KEYS.indexOf('adrPct');
  let n = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const { px, rnd } = walk(seed * 29 + 3);
    const date = `2025-08-${String(seed + 3).padStart(2, '0')}`;
    const day = session(date, (k) => px[k], rnd);
    for (const r of gridDay({ date, history: H, day, nifty: session(date, () => 20000), daily: daily() })) {
      const k = r[0], close = day[k - 1].c, adr = (r[iAdr] / 100) * close;
      for (const [pre, tAdr] of [['nb', NEAR_TARGET_ADR], ['fb', FAR_TARGET_ADR]] as const) {
        const entry = close - TICK * (k < 20 ? OPEN_SLIP_TICKS : 1), stop = onTick(close + WIDE_STOP_ADR * adr, 1), tgt = onTick(close - tAdr * adr, -1);
        let sAt = -1, tAt = -1;
        for (let s = k; s < LATE_END; s++) {
          if (sAt < 0 && day[s].h >= stop) sAt = s;
          if (tAt < 0 && day[s].l <= tgt - TICK) tAt = s;
        }
        const win = tAt >= 0 && (sAt < 0 || tAt < sAt);
        const exit = win ? tgt : sAt >= 0 ? stop + TICK : day[LATE_END - 1].c + TICK;
        const dist = stop - entry, g = (entry - exit) / dist;
        const net = (qty: number) => g - roundTripCharges(qty, entry, exit, -1) / (qty * dist);
        assert.ok(Math.abs(r[col(`${pre}Sg`)] - g) < 0.002 && Math.abs(r[col(`${pre}S`)] - net(sizeFor(300, dist))) < 0.002, `${pre} ${date} ${k}`);
        assert.ok(Math.abs(r[col(`${pre}S1`)] - net(Math.floor(MID_NOTIONAL / entry))) < 0.002 && Math.abs(r[col(`${pre}S3`)] - net(Math.floor(BIG_NOTIONAL / entry))) < 0.002);
        n++;
      }
    }
  }
  assert.ok(n > 300);
});

test('grid (iteration 11): F\'s short with fills by liquidity matches an independent replay, and thin stocks pay more', () => {
  const H = hist();
  const col = (c: string) => ML_COLS.indexOf(c) - 2;
  const iAdr = 1 + ML_KEYS.indexOf('adrPct');
  assert.equal(liqBand(499_999).ticks, 3); assert.equal(liqBand(3e6).ticks, 2); assert.equal(liqBand(1.2e7).stopPct, 0.04);
  let n = 0, thinCost = 0, thickCost = 0;
  for (const vol of [1e6, 4e6, 6e6, 8e6, 1.2e7]) {
    const dly = daily(); dly.v = dly.v.map(() => vol);
    const band = LIQ_BANDS.filter((b) => vol >= b.min).at(-1)!;
    for (let seed = 1; seed <= 6; seed++) {
      const { px, rnd } = walk(seed * 31 + 5);
      const date = `2025-09-${String(seed + 3).padStart(2, '0')}`;
      const day = session(date, (k) => px[k], rnd);
      for (const r of gridDay({ date, history: H, day, nifty: session(date, () => 20000), daily: dly })) {
        const k = r[0], close = day[k - 1].c, adr = (r[iAdr] / 100) * close;
        assert.equal(r[col('avgVol')], vol);
        const ticks = Math.max(band.ticks, k < 20 ? OPEN_SLIP_TICKS : 1);
        const entry = close - TICK * ticks, stop = onTick(close + WIDE_STOP_ADR * adr, 1), tgt = onTick(close - NEAR_TARGET_ADR * adr, -1);
        let sAt = -1, tAt = -1;
        for (let s = k; s < LATE_END; s++) {
          if (sAt < 0 && day[s].h >= stop) sAt = s;
          if (tAt < 0 && day[s].l <= tgt - TICK * band.ticks) tAt = s;
        }
        const win = tAt >= 0 && (sAt < 0 || tAt < sAt);
        let exit: number;
        if (win) exit = tgt;
        else if (sAt >= 0) {
          const b0 = sAt - (sAt % 10); let hi = -Infinity, lo = Infinity;
          for (let j = b0; j < b0 + 10; j++) { hi = Math.max(hi, day[j].h); lo = Math.min(lo, day[j].l); }
          exit = stop + Math.ceil(Math.max(TICK, (band.stopPct / 100) * stop, FAST_STOP_FRAC * (hi - lo)) / TICK - 1e-9) * TICK;
        } else exit = day[LATE_END - 1].c + TICK * band.ticks;
        const dist = stop - entry, qty = sizeFor(300, dist);
        const net = (entry - exit) / dist - roundTripCharges(qty, entry, exit, -1) / (qty * dist);
        assert.ok(Math.abs(r[col('nbSx')] - net) < 0.002, `${vol} ${date} ${k}: ${r[col('nbSx')]} vs ${net}`);
        assert.ok(r[col('nbSx')] <= r[col('nbS')] + 1e-9, 'real fills are never better than the old ones');
        if (vol === 1e6) thinCost += r[col('nbS')] - r[col('nbSx')];
        if (vol === 1.2e7) thickCost += r[col('nbS')] - r[col('nbSx')];
        n++;
      }
    }
  }
  assert.ok(n > 500 && thinCost > thickCost, `thin stocks pay more: ${thinCost} vs ${thickCost}`);
});

test('grid: memory facts come only from earlier sessions and daily candles, and add up', () => {
  // 20 earlier sessions that each rise 1 rupee from 10:15 to 15:15 (and are flat before)
  const b: Bar[] = [];
  for (let i = 0; i < 20; i++) b.push(...session(`2024-11-${String(i + 1).padStart(2, '0')}`, (k) => (k < 60 ? 300 : 300 + Math.min(1, (k - 59) / 300))));
  const H = toSessions({ t: b.map((x) => x.t), o: b.map((x) => x.o), h: b.map((x) => x.h), l: b.map((x) => x.l), c: b.map((x) => x.c), v: b.map((x) => x.v) });
  const { px, rnd } = walk(5);
  const d = daily();
  d.c[d.c.length - 6] = 280; // 5 days ago
  const rows = gridDay({ date: '2025-01-06', history: H, day: session('2025-01-06', (k) => px[k], rnd), nifty: session('2025-01-06', () => 20000), daily: d });
  const f = (r: number[], key: string) => r[1 + ML_KEYS.indexOf(key)];
  const at = rows.find((r) => r[0] === 60)!;
  const exp = H.map((s) => { const c = s.bars.map((x) => x.c); return (c[359] / c[59] - 1) * 100; });
  assert.ok(Math.abs(f(at, 'habitClose') - exp.reduce((a, x) => a + x, 0) / exp.length) < 1e-9, 'usual move from this time to 15:15');
  assert.equal(f(at, 'habitCloseUp'), 1);
  assert.ok(Math.abs(f(at, 'ret5d') - (300 / 280 - 1) * 100) < 1e-9, '5-day move from the daily closes before today');
  assert.ok(Math.abs(f(at, 'prevCloseLoc') - 0.5) < 1e-9 && Math.abs(f(at, 'hi20Adr') - (303 - px[59]) / 6) < 1e-9);
});

test('grid: no look-ahead: changing everything after a 10-min close never changes its facts', () => {
  const { px, rnd } = walk(11);
  const date = '2025-04-07', H = hist(), nifty = session(date, (k) => 20000 + k);
  const day = session(date, (k) => px[k], rnd);
  const base = gridDay({ date, history: H, day, nifty, daily: daily() });
  for (const r of base.filter((_, i) => i % 6 === 0)) {
    const k = r[0];
    const changed = day.map((b, i) => (i >= k ? { ...b, h: b.h + 4, l: b.l - 4, c: b.c + 2, o: b.o + 2, v: b.v * 9 } : b));
    const nChanged = nifty.map((b, i) => (i >= k ? { ...b, c: b.c + 50, h: b.h + 60, l: b.l - 60 } : b));
    const again = gridDay({ date, history: H, day: changed, nifty: nChanged, daily: daily() }).find((x) => x[0] === k)!;
    assert.deepEqual(again.slice(0, 1 + ML_KEYS.length), r.slice(0, 1 + ML_KEYS.length), `facts at ${k}`);
  }
});

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GridWriter } from '../lib/ml/writer';

test('grid writer: what Python reads back is exactly what was written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-'));
  const w = new GridWriter(dir);
  const all: number[][] = [];
  for (let s = 0; s < 3; s++) for (let d = 0; d < 9; d++) {
    const { px, rnd } = walk(s * 31 + d);
    const date = `2025-05-${String(d + 5).padStart(2, '0')}`;
    const rows = gridDay({ date, history: hist(), day: session(date, (k) => px[k], rnd), nifty: session(date, () => 20000), daily: daily() });
    w.add(`SYM${s}`, date, rows);
    all.push(...rows.map((r) => [s, d, ...r]));
  }
  w.close({ runId: 't', from: '2025-05-05', to: '2025-05-13', mid: '2025-05-09', riskInr: 300 });
  const head = JSON.parse(readFileSync(join(dir, 'grid.json'), 'utf8'));
  const bin = readFileSync(join(dir, 'grid.bin'));
  const f = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  assert.equal(head.rows, all.length);
  assert.equal(f.length, all.length * head.width);
  assert.equal(head.cols.length, head.width);
  for (let i = 0; i < all.length; i += 37) for (let j = 0; j < head.width; j++) {
    const a = all[i][j], b = f[i * head.width + j];
    assert.ok((Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a)), `row ${i} col ${head.cols[j]}`);
  }
  assert.deepEqual(head.symbols, ['SYM0', 'SYM1', 'SYM2']);
});
