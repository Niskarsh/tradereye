import type { Bar } from '../live/enrich';
import { tenMinuteBars } from '../live/enrich';
import { Atr, barOf, median, toSlots, type B10 } from '../setups/engine';
import { onTick, TICK } from '../study/mine';
import { roundTripCharges, sizeFor } from '../setups/costs';
import { FAST_STOP_FRAC, gridDay, LATE_END, liqBand, NEAR_TARGET_ADR, OPEN_SLIP_TICKS, stopSlip, WIDE_STOP_ADR, type GridInput } from './grid';

/**
 * Algo Lab iteration 17 (research only): iteration 10's strategy F as Algo Live trades it, with three ideas tested in every
 * combination against it in one run:
 *   B  learning from losses: a veto model on the trades F takes, and an early exit after the first 1-3 candles of a trade
 *      (both trained only on earlier months' trades; done in scripts/ml_iter17_layers.py from the columns written here)
 *   C  chart-structure facts on the 10-min chart (the YouTuber's list): sweep and reclaim, fair value gap, break of
 *      structure / change of character, flip zone, supply zone; plus the same facts drawn from randomly shifted lines
 *      (the placebo: if they help as much, the structure facts are noise)
 *   D  results days (no trade on a company's results day or the day after) and the stock's sector index
 * and, on every one of them, the stop moved to break-even after costs at 80% / 90% of the way to the target.
 *
 * Nothing here changes lib/ml/grid.ts: the rows are gridDay()'s rows exactly (so the control is iteration 10), with the
 * new facts appended (I17_COLS) and, for the moments F can trade, one path record (I17_PATH_COLS) in a separate file.
 */

/** C: the chart-structure facts, short-side (F only shorts), all from closed 10-min candles of today */
export const I17_STRUCTURE = [
  ['sweep', 'Swept a high and closed back below it in the last 3 candles (1 / 0)'],
  ['sweepAtr', 'How far above the swept high the wick went (ATR)'],
  ['sweepAgo', 'Candles since the sweep (0 = the last candle)'],
  ['sweepPdh', 'The swept high was yesterday\'s high (1 / 0)'],
  ['fvgDistAtr', 'Nearest unfilled bearish fair value gap above price: distance to its bottom (ATR; 0 = inside)'],
  ['fvgSizeAtr', 'That gap\'s size (ATR)'],
  ['fvgIn', 'Price is inside an unfilled bearish gap (1 / 0)'],
  ['fvgCount', 'Unfilled bearish gaps above price'],
  ['fvgTouch', 'The last candle made the first return into an unfilled bearish gap and closed below its top (1 / 0)'],
  ['lowerHigh', 'The last swing high is lower than the one before (1 / 0)'],
  ['bosDown', 'The last swing low has been closed below (break of structure) (1 / 0)'],
  ['bosAgo', 'Candles since that break'],
  ['swingHiAtr', 'Last swing high vs price (ATR; + = above)'],
  ['flipOpen', 'Lost the open, then retested it from below and was rejected in the last 2 candles (1 / 0)'],
  ['flipOr', 'Lost the first 30 minutes\' low, then retested it from below and was rejected in the last 2 candles (1 / 0)'],
  ['flipDistAtr', 'That flip level vs price (ATR; + = above)'],
  ['supplyDistAtr', 'Base of the day\'s first sharp down candle (1.5+ ATR) vs price (ATR; + = above)'],
  ['supplyBack', 'The last candle made the first return to that base (1 / 0)'],
] as const;
export const I17_STRUCT_KEYS = I17_STRUCTURE.map((f) => f[0]);
/** the placebo of C: the same facts, every level shifted by a random amount fixed per stock-day */
export const I17_PLACEBO_KEYS = I17_STRUCT_KEYS.map((k) => `p_${k}`);
/** D: the stock's sector (its NSE industry's index) */
export const I17_SECTOR = [
  ['secDay', 'Sector index open → now (%)'],
  ['sec30', 'Sector index last 30 min (%)'],
  ['stockVsSec', 'Stock vs its sector since the open (%)'],
  ['rs30Sec', 'Stock vs its sector over the last 30 min (%)'],
] as const;
export const I17_SECTOR_KEYS = I17_SECTOR.map((f) => f[0]);
/** appended to every row: C, C's placebo, D's facts, and the results-day flag (1 = results today or yesterday; NaN = not known) */
export const I17_COLS = [...I17_STRUCT_KEYS, ...I17_PLACEBO_KEYS, ...I17_SECTOR_KEYS, 'resDay'];

/** the moments F can trade (09:35-10:55): the only rows that get a path record */
export const F_FIRST = 20, F_LAST = 100;
/** the stop moved to break-even after costs once price has come this share of the way to the target */
export const BE_FRACS = [0.8, 0.9] as const;
/** a 10-min candle this many ATR or more against the trade, inside the trade, makes a loss a "shock" */
export const SHOCK_ATR = 3;
/** early-exit decision points: the closes of the 1st, 2nd and 3rd 10-min candles after entry */
export const EXIT_STEPS = [1, 2, 3] as const;

/**
 * One record per F moment, by its row in grid.bin. F's short with Algo Live's realistic fills (as nbSx in grid.ts):
 *   net0 / net80 / net90       R after charges: no stop move, break-even after costs at 80% / 90% of the way to the target
 *   o{j}_0 / o{j}_80 / o{j}_90  1 if still open at the close of candle j after entry (j = 1, 2, 3), per version
 *   x{j}                        R after charges if closed at market at that close (meaningful only while open)
 *   mae{j} / mfe{j} / cl{j}     worst / best excursion and the close vs entry so far (R; + = good for the short)
 *   vol{j} / nif{j} / rng{j}    that candle's volume ÷ normal, Nifty 500 over that candle (%), its range (ATR)
 *   kind / mins / mfeFrac / shock   how it ended (1 target, -1 stop, 0 out at 15:15), minutes held, the best it got as a
 *                               share of the way to the target, and 1 if a 3+ ATR candle against it came during the trade
 */
export const I17_PATH_COLS = [
  'row', 'net0', 'net80', 'net90',
  ...EXIT_STEPS.flatMap((j) => [`o${j}_0`, `o${j}_80`, `o${j}_90`, `x${j}`, `mae${j}`, `mfe${j}`, `cl${j}`, `vol${j}`, `nif${j}`, `rng${j}`]),
  'kind', 'mins', 'mfeFrac', 'shock',
];

type Slots = NonNullable<ReturnType<typeof toSlots>>;

/** confirmed swing highs / lows of closed 10-min candles: a candle above (below) the one before and not exceeded by the one after */
function swings(t: B10[]) {
  const hi: { i: number; v: number }[] = [], lo: { i: number; v: number }[] = [];
  for (let j = 1; j + 1 < t.length; j++) {
    if (t[j].h > t[j - 1].h && t[j].h >= t[j + 1].h) hi.push({ i: j, v: t[j].h });
    if (t[j].l < t[j - 1].l && t[j].l <= t[j + 1].l) lo.push({ i: j, v: t[j].l });
  }
  return { hi, lo };
}

/**
 * C's facts at a 10-min close. `t` = today's closed 10-min candles up to now, `atr` the 10-min ATR now, `pdh` yesterday's high,
 * `shift` a price added to every level (0 = the real facts; the placebo shifts every line by a random amount).
 */
export function structureFacts(t: B10[], price: number, atr: number, pdh: number, shift = 0): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(I17_STRUCT_KEYS.map((k) => [k, NaN]));
  const L = t.length;
  if (!L || !(atr > 0)) return out;
  const { hi: sh, lo: sl } = swings(t);
  // 1. sweep and reclaim: a wick above a high (the day's high so far, yesterday's high, the last swing high) closed back below
  out.sweep = 0; out.sweepPdh = 0;
  for (let j = L - 1; j >= Math.max(1, L - 3); j--) {
    let dayHi = -Infinity;
    for (let i = 0; i < j; i++) dayHi = Math.max(dayHi, t[i].h);
    const swing = [...sh].reverse().find((x) => x.i <= j - 2);
    const levels: [number, boolean][] = [[dayHi + shift, false], [pdh + shift, true]];
    if (swing) levels.push([swing.v + shift, false]);
    let hit = false;
    for (const [lv, isPdh] of levels) {
      if (!Number.isFinite(lv) || !(t[j].h > lv && t[j].c < lv)) continue;
      hit = true;
      out.sweepAtr = Math.max(Number.isFinite(out.sweepAtr) ? out.sweepAtr : 0, (t[j].h - lv) / atr);
      if (isPdh) out.sweepPdh = 1;
    }
    if (hit) { out.sweep = 1; out.sweepAgo = L - 1 - j; break; } // the latest sweep
  }
  // 2. bearish fair value gaps (candle i-2's low above candle i's high), unfilled = no later high reached the gap's top
  const gaps: { i: number; bot: number; top: number }[] = [];
  for (let i = 2; i < L; i++) {
    if (!(t[i - 2].l > t[i].h)) continue;
    const top = t[i - 2].l + shift, bot = t[i].h + shift;
    let filled = false;
    for (let j = i + 1; j < L; j++) if (t[j].h >= top) { filled = true; break; }
    if (!filled) gaps.push({ i, bot, top });
  }
  const above = gaps.filter((g) => g.top > price);
  out.fvgCount = above.length; out.fvgIn = 0; out.fvgTouch = 0;
  if (above.length) {
    const near = above.reduce((a, g) => (Math.max(0, g.bot - price) < Math.max(0, a.bot - price) ? g : a));
    out.fvgDistAtr = Math.max(0, near.bot - price) / atr;
    out.fvgSizeAtr = (near.top - near.bot) / atr;
    out.fvgIn = price >= near.bot && price <= near.top ? 1 : 0;
  }
  for (const g of gaps) {
    if (g.i >= L - 1) continue;
    let before = false;
    for (let j = g.i + 1; j < L - 1; j++) if (t[j].h >= g.bot) { before = true; break; }
    if (!before && t[L - 1].h >= g.bot && t[L - 1].c < g.top) out.fvgTouch = 1;
  }
  // 3. structure: a lower high, and the last swing low closed below (break of structure / change of character)
  out.lowerHigh = sh.length >= 2 && sh[sh.length - 1].v < sh[sh.length - 2].v ? 1 : 0;
  out.bosDown = 0;
  const lastLo = sl.at(-1);
  if (lastLo) {
    for (let j = lastLo.i + 2; j < L; j++) if (t[j].c < lastLo.v + shift) { out.bosDown = 1; out.bosAgo = L - 1 - j; break; }
  }
  if (sh.length) out.swingHiAtr = (sh[sh.length - 1].v + shift - price) / atr;
  // 4. flip zone: a level lost (closed below), then retested from below and rejected in the last 2 candles
  const flip = (lv: number, from: number): boolean => {
    let lost = -1;
    for (let j = from; j < L; j++) if (t[j].c < lv) { lost = j; break; }
    if (lost < 0) return false;
    for (let j = Math.max(lost + 1, L - 2); j < L; j++) if (t[j].h >= lv - 0.1 * atr && t[j].c < lv) return true;
    return false;
  };
  const openLv = t[0].o + shift;
  out.flipOpen = flip(openLv, 0) ? 1 : 0;
  out.flipOr = 0;
  if (L >= 4) {
    const orLow = Math.min(t[0].l, t[1].l, t[2].l) + shift;
    out.flipOr = flip(orLow, 3) ? 1 : 0;
    if (out.flipOr && !out.flipOpen) out.flipDistAtr = (orLow - price) / atr;
  }
  if (out.flipOpen) out.flipDistAtr = (openLv - price) / atr;
  // 5. supply zone: the candle before the day's first sharp down candle; the first return to its low
  out.supplyBack = 0;
  for (let j = 1; j < L; j++) {
    if (t[j].o - t[j].c < 1.5 * atr) continue;
    const base = t[j - 1].l + shift;
    out.supplyDistAtr = (base - price) / atr;
    if (j < L - 1) {
      let before = false;
      for (let i = j + 1; i < L - 1; i++) if (t[i].h >= base) { before = true; break; }
      if (!before && t[L - 1].h >= base) out.supplyBack = 1;
    }
    break;
  }
  return out;
}

/** a number in [0, 1) fixed by a text (the placebo's shift is the same every run for a stock-day) */
export function hashUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1_000_003) / 1_000_003;
}
/** the placebo's shift for a stock-day: up or down by 0.5-1.5 × a sixth of the usual daily range (about one 10-min ATR) */
export function placeboShift(key: string, adr: number): number {
  const u = hashUnit(key), v = hashUnit(`${key}|size`);
  return (u < 0.5 ? -1 : 1) * (0.5 + v) * (adr / 6);
}

export interface FillOpts { slip: number; through: number; stopPct: number; fast: number; outSlip: number }

/**
 * F's short from the close of minute k-1 (as lib/ml/grid.ts ride() with Algo Live's realistic fills), optionally moving the
 * stop to break-even after costs once price has come `be` of the way to the target (the move takes effect from the next
 * minute). Same rules as ride(): stop and target in the same minute = stop; the target fills only when traded through.
 */
export function simShort(day: Slots, k: number, price: number, stopPx: number, tgt: number, risk: number, f: FillOpts, be = 0) {
  const entry = price - TICK * f.slip, through = TICK * f.through, outSlip = TICK * f.outSlip;
  const dist = stopPx - entry;
  if (!(dist > 0)) return undefined;
  const qty = sizeFor(risk, dist);
  const beStop = be ? onTick(entry - roundTripCharges(qty, entry, entry, -1) / qty, -1) : NaN;
  const trigger = entry - be * (entry - tgt);
  let stop = stopPx, moved = false, exitS = -1, kind = 0, exitPx = NaN;
  for (let s = k; s < LATE_END; s++) {
    const stopHit = day.h[s] >= stop, tgtHit = day.l[s] <= tgt - through;
    if (stopHit) { exitS = s; kind = -1; exitPx = stop + stopSlip(day, s, stop, f.stopPct, f.fast); break; }
    if (tgtHit) { exitS = s; kind = 1; exitPx = tgt; break; }
    if (be && !moved && day.l[s] <= trigger) { moved = true; if (beStop < stop) stop = beStop; }
  }
  if (exitS < 0) { exitS = LATE_END; exitPx = day.c[LATE_END - 1] + outSlip; }
  const r = (entry - exitPx) / dist;
  const net = r - roundTripCharges(qty, entry, exitPx, -1) / (qty * dist);
  return { entry, dist, qty, exitS, kind, net: Math.round(net * 1000) / 1000, r: Math.round(r * 1000) / 1000, moved };
}

export interface I17Input extends GridInput {
  /** the sector index's 1-minute bars that day (undefined = no sector for this stock) */
  sector?: Bar[];
  /** 1 = the company's results day or the day after, 0 = not, NaN = not known */
  resDay: number;
  /** the stock-day, for the placebo's fixed random shift */
  key: string;
}

/**
 * One stock-day for iteration 17: gridDay()'s rows unchanged with I17_COLS appended, and for F's moments (09:35-10:55) a path
 * record (I17_PATH_COLS without 'row': the job adds the row number). `path[i]` belongs to the row `pathRow[i]` of `rows`.
 */
export function iter17Day(inp: I17Input): { rows: number[][]; paths: number[][]; pathRow: number[] } {
  const base = gridDay(inp);
  if (!base.length) return { rows: [], paths: [], pathRow: [] };
  const risk = inp.riskInr ?? 300;
  const day = toSlots(inp.day)!, nifty = toSlots(inp.nifty)!, sector = inp.sector ? toSlots(inp.sector) : undefined;
  const daily = inp.daily, nd = daily.c.length;
  const hist = inp.history.filter((s) => s.date < inp.date && s.bars.length).slice(-20);
  const atrC = new Atr();
  for (const b of tenMinuteBars(hist)) atrC.push(b);
  const adr = daily.h.slice(-10).reduce((a, h, i) => a + h - daily.l[nd - 10 + i], 0) / 10;
  const pdh = daily.h[nd - 1];
  const avgVol = daily.v.slice(-10).reduce((a, v) => a + v, 0) / 10, band = liqBand(avgVol);
  const medBase = tenMinuteBars(hist.slice(-2)).map((b) => b.v);
  const shift = placeboShift(inp.key, adr);
  const byK = new Map<number, number>(base.map((r, i) => [r[0], i]));
  const tens: B10[] = [];
  const rows = base.map((r) => [...r, ...I17_COLS.map(() => NaN)]);
  const at = (r: number[], key: string) => r.length - I17_COLS.length + I17_COLS.indexOf(key);
  const paths: number[][] = [], pathRow: number[] = [];
  for (let k = 1; k <= LATE_END; k++) {
    const s = k - 1;
    if ((s + 1) % 10 === 0) { const b = barOf(day, s - 9, s + 1); tens.push(b); atrC.push(b); }
    const i = byK.get(k);
    if (i === undefined) continue;
    const atr = atrC.peek()!;
    const price = day.c[k - 1], row = rows[i];
    const real = structureFacts(tens, price, atr, pdh), fake = structureFacts(tens, price, atr, pdh, shift);
    for (const key of I17_STRUCT_KEYS) { row[at(row, key)] = real[key]; row[at(row, `p_${key}`)] = fake[key]; }
    if (sector && sector.n >= k) {
      const so = sector.o[0], sc = sector.c[k - 1], s30 = sector.c[k - 31 >= 0 ? k - 31 : 0];
      const pct = (a: number, b: number) => (a / b - 1) * 100;
      const secDay = pct(sc, so), sec30 = pct(sc, s30);
      row[at(row, 'secDay')] = secDay; row[at(row, 'sec30')] = sec30;
      row[at(row, 'stockVsSec')] = pct(price, day.o[0]) - secDay;
      row[at(row, 'rs30Sec')] = pct(price, day.c[k - 31 >= 0 ? k - 31 : 0]) - sec30;
    }
    row[at(row, 'resDay')] = inp.resDay;
    if (k < F_FIRST || k > F_LAST) continue;
    // F's path (Algo Live's realistic fills, as grid.ts realShort)
    const slip = Math.max(k < 20 ? OPEN_SLIP_TICKS : 1, band.ticks);
    const f: FillOpts = { slip, through: band.ticks, stopPct: band.stopPct, fast: FAST_STOP_FRAC, outSlip: band.ticks };
    const stopPx = onTick(price + WIDE_STOP_ADR * adr, 1), tgt = onTick(price - NEAR_TARGET_ADR * adr, -1);
    const v0 = simShort(day, k, price, stopPx, tgt, risk, f), v80 = simShort(day, k, price, stopPx, tgt, risk, f, BE_FRACS[0]), v90 = simShort(day, k, price, stopPx, tgt, risk, f, BE_FRACS[1]);
    if (!v0 || !v80 || !v90) continue;
    const medV = median([...medBase, ...tens.map((x) => x.v)]);
    const rec: number[] = [v0.net, v80.net, v90.net];
    for (const j of EXIT_STEPS) {
      const cj = k - 1 + 10 * j; // the minute index whose close ends candle j after entry
      if (cj >= LATE_END - 1) { rec.push(0, 0, 0, NaN, NaN, NaN, NaN, NaN, NaN, NaN); continue; }
      let hi = -Infinity, lo = Infinity;
      for (let m = k; m <= cj; m++) { hi = Math.max(hi, day.h[m]); lo = Math.min(lo, day.l[m]); }
      const cb = barOf(day, cj - 9, cj + 1);
      const exitPx = day.c[cj] + TICK * f.outSlip;
      const x = (v0.entry - exitPx) / v0.dist - roundTripCharges(v0.qty, v0.entry, exitPx, -1) / (v0.qty * v0.dist);
      rec.push(v0.exitS > cj ? 1 : 0, v80.exitS > cj ? 1 : 0, v90.exitS > cj ? 1 : 0, Math.round(x * 1000) / 1000,
        (hi - v0.entry) / v0.dist, (v0.entry - lo) / v0.dist, (v0.entry - day.c[cj]) / v0.dist,
        medV > 0 ? cb.v / medV : NaN, (nifty.c[cj] / nifty.c[cj - 10] - 1) * 100, (cb.h - cb.l) / atr);
    }
    // how it ended (no stop move)
    let best = Infinity, shock = 0;
    const end = Math.min(v0.exitS, LATE_END - 1);
    for (let m = k; m <= end; m++) best = Math.min(best, day.l[m]);
    for (let b0 = k; b0 <= end; b0 += 10) {
      const b = barOf(day, b0, Math.min(b0 + 10, LATE_END));
      if (b.h - b.l >= SHOCK_ATR * atr && b.c > b.o) { shock = 1; break; }
    }
    const toTarget = v0.entry - tgt;
    rec.push(v0.kind, Math.min(v0.exitS, LATE_END) - k + 1, toTarget > 0 ? (v0.entry - best) / toTarget : NaN, shock);
    paths.push(rec); pathRow.push(i);
  }
  return { rows, paths, pathRow };
}
