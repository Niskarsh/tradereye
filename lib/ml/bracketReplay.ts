import type { Candles } from '../dhan';
import { toSessions } from '../live/enrich';
import { toSlots } from '../setups/engine';
import { sizeFor } from '../setups/costs';
import { onTick, TICK } from '../study/mine';
import { dailyKey, getJson, monthKey, type Store } from '../setups/store';
import { FAST_STOP_FRAC, LATE_END, NEAR_TARGET_ADR, WIDE_STOP_ADR, liqBand, ride } from './grid';

/**
 * Same picks, smaller bracket: replays F's own trades with its stop and target both scaled (50-100%), on the saved
 * 1-minute candles, with the backtest's fill and charge code (ride). No model is retrained, so this answers "what if
 * these trades had a tighter bracket", not "what would a model trained for that bracket pick".
 *
 * The size is chosen on the decide months only. The exam and untouched months are reported only for 100% and the
 * chosen size, so they stay a check rather than a seventh way to pick.
 */
export const SCALES = [0.5, 0.6, 0.7, 0.8, 0.9, 1];
export const POSITION_CAP = 75_000; // trading-scaler's guard (Trade Assistant BOT.md)
const RISK = 300;

type Day = NonNullable<ReturnType<typeof toSlots>>;
export interface Out { net: number; inr: number; capped: boolean }

/** one short at one scale. real = fills by liquidity and the ₹75,000 position cap; otherwise the original 1-tick fills */
export function replayShort(day: Day, k: number, adr: number, avgVol: number, scale: number, real: boolean): Out {
  const close = day.c[k - 1];
  const stop = onTick(close + scale * WIDE_STOP_ADR * adr, 1), target = onTick(close - scale * NEAR_TARGET_ADR * adr, -1);
  const band = liqBand(avgVol), base = k < 20 ? 2 : 1;
  const slip = real ? Math.max(base, band.ticks) : base;
  const entry = close - TICK * slip, dist = stop - entry;
  let qty = sizeFor(RISK, dist), capped = false;
  if (real && qty * entry > POSITION_CAP) { qty = Math.max(1, Math.floor(POSITION_CAP / entry)); capped = true; }
  const ex = real ? { slip, through: band.ticks, stopPct: band.stopPct, fast: FAST_STOP_FRAC, outSlip: band.ticks, ...(capped ? { notional: POSITION_CAP } : {}) } : { slip };
  const { net } = ride(day, k, -1, close, stop, target, LATE_END, RISK, ex);
  return { net, inr: net * qty * dist, capped };
}

export interface Row { month: string; net: number; inr: number; capped: boolean; base: number }
export interface Line { scale: number; n: number; netR: number; t: number; win: number; inr: number; inrPerTrade: number; monthsGreen: number; months: number; worstMonth: number; capped: number; diffR: number; diffT: number }

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const tOf = (a: number[]) => { const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); return sd > 0 ? (m / (sd / Math.sqrt(a.length))) : 0; };
const rd = (x: number, p = 3) => Math.round(x * 10 ** p) / 10 ** p;

export function lineOf(scale: number, rows: Row[]): Line {
  const nets = rows.map((r) => r.net), by = new Map<string, number>();
  for (const r of rows) by.set(r.month, (by.get(r.month) ?? 0) + r.inr);
  const inr = rows.reduce((s, r) => s + r.inr, 0), d = rows.map((r) => r.net - r.base);
  return { scale, n: rows.length, netR: rd(mean(nets)), t: rd(tOf(nets), 2), win: rd(rows.filter((r) => r.net > 0).length / Math.max(1, rows.length)), inr: Math.round(inr), inrPerTrade: Math.round(inr / Math.max(1, rows.length)),
    monthsGreen: [...by.values()].filter((x) => x > 0).length, months: by.size, worstMonth: Math.round(Math.min(0, ...by.values())), capped: rows.filter((r) => r.capped).length, diffR: rd(mean(d)), diffT: rd(tOf(d), 2) };
}

type Trade = (string | number | null)[];
export interface Strat { id: string; tradeCols?: string[]; trades?: Trade[] }

export async function bracketReplay(ml: { examFrom: string; strategies: Strat[]; untouched?: Strat[] }, id: string, store: Store, log: (m: string) => void) {
  const st = ml.strategies.find((s) => s.id === id);
  if (!st?.trades?.length) throw new Error(`no trades for ${id}`);
  const un = (ml.untouched ?? []).find((u) => u.id === id);
  const cols = st.tradeCols ?? [];
  const [iDay, iSym, iTime, iNet] = ['day', 'sym', 'time', 'net'].map((c) => cols.indexOf(c));
  const all = [...st.trades, ...(un?.trades ?? [])];
  const need = new Map<string, Set<string>>();
  for (const t of all) { const k = `${t[iSym]}|${String(t[iDay]).slice(0, 7)}`; if (!need.has(k)) need.set(k, new Set()); need.get(k)!.add(String(t[iDay])); }
  const days = new Map<string, Day>(), dailies = new Map<string, Candles>(), keys = [...need.keys()];
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < keys.length) {
      const key = keys[next++], [sym, month] = key.split('|');
      const m = await getJson<{ c: Candles }>(store, monthKey(sym, month)).catch(() => undefined);
      for (const s of m ? toSessions(m.c) : []) { if (need.get(key)!.has(s.date)) { const sl = toSlots(s.bars); if (sl) { sl.bars = []; days.set(`${sym}|${s.date}`, sl); } } }
      if (!dailies.has(sym)) { const d = await getJson<{ c: Candles }>(store, dailyKey(sym)).catch(() => undefined); if (d?.c) dailies.set(sym, d.c); }
    }
  }));
  log(`loaded ${days.size} trade days from ${keys.length} stock-months`);
  const dateOf = (sec: number) => new Date(sec * 1000 + 19800_000).toISOString().slice(0, 10);
  let checked = 0, mismatch = 0, skipped = 0;
  const run = (list: Trade[], real: boolean, scale: number, check = false): Row[] => list.flatMap((t) => {
    const date = String(t[iDay]), sym = String(t[iSym]), [hh, mm] = String(t[iTime]).split(':').map(Number);
    const k = hh * 60 + mm - 555, day = days.get(`${sym}|${date}`), daily = dailies.get(sym);
    const before = daily ? daily.t.map(dateOf).filter((x) => x < date).length : 0;
    if (!day || !daily || before < 10) { if (check) skipped++; return []; }
    let adr = 0, vol = 0;
    for (let i = before - 10; i < before; i++) { adr += daily.h[i] - daily.l[i]; vol += daily.v[i]; }
    adr /= 10; vol /= 10;
    const o = replayShort(day, k, adr, vol, scale, real), b = replayShort(day, k, adr, vol, 1, real);
    if (check) { checked++; if (Math.abs(replayShort(day, k, adr, vol, 1, false).net - Number(t[iNet])) > 0.006) mismatch++; }
    return [{ month: date.slice(0, 7), net: o.net, inr: o.inr, capped: o.capped, base: b.net }];
  }).filter((r) => Number.isFinite(r.net));
  const m = (t: Trade) => String(t[iDay]).slice(0, 7);
  const decide = st.trades.filter((t) => m(t) < ml.examFrom), exam = st.trades.filter((t) => m(t) >= ml.examFrom), unt = un?.trades ?? [];
  run(all, false, 1, true);
  const table = (real: boolean) => SCALES.map((s) => lineOf(s, run(decide, real, s)));
  const decideReal = table(true), decideOld = table(false);
  const best = decideReal.reduce((a, b) => (b.netR > a.netR ? b : a));
  const check = (list: Trade[]) => [...new Set([1, best.scale])].map((s) => lineOf(s, run(list, true, s)));
  return { strategy: id, trades: all.length, checked, mismatch, skipped, chosen: best.scale, decideReal, decideOld, exam: check(exam), untouched: unt.length ? check(unt) : [] };
}
