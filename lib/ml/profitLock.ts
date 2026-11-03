import { sizeFor, roundTripCharges } from '../setups/costs';
import type { toSlots } from '../setups/engine';
import { onTick, TICK } from '../study/mine';
import { lineOf, POSITION_CAP, type Line, type Row, type Strat } from './bracketReplay';
import { FAST_STOP_FRAC, LATE_END, NEAR_TARGET_ADR, WIDE_STOP_ADR, liqBand, ride, stopSlip } from './grid';
import { loadDays } from './manageRun';
import type { Store } from '../setups/store';

/**
 * Same picks, protect the profit: F's own trades with one fixed rule, once price has come `at` of the way to the target.
 *   cash   take the profit there (a limit order at that price, same stop until then)
 *   lock   keep the target, move the stop to lock `lock` of the way to the target, from the next minute
 * Fills as Algo Lab's realistic fills, with the target needing `through` ticks past it (1 or 3). Within a minute the stop is
 * checked first. The rule is chosen on the decide months; exam and untouched months only for the base and the chosen rule.
 */
export interface Rule { id: string; label: string; kind: 'base' | 'cash' | 'lock' | 'cover' | 'coverSlip'; at: number; lock: number }
export const RULES: Rule[] = [
  { id: 'base', label: 'As now', kind: 'base', at: 0, lock: 0 },
  ...[0.8, 0.9].flatMap((at): Rule[] => [
    { id: `cover${at * 100}`, label: `At ${at * 100}%, stop pays charges`, kind: 'cover', at, lock: 0 },
    { id: `coverSlip${at * 100}`, label: `At ${at * 100}%, stop pays charges and slippage`, kind: 'coverSlip', at, lock: 0 },
    ...[0.1, 0.15, 0.2, 0.25].map((lock): Rule => ({ id: `lock${at * 100}-${Math.round(lock * 100)}`, label: `At ${at * 100}%, lock ${Math.round(lock * 100)}%`, kind: 'lock', at, lock })),
  ]),
];
type Day = NonNullable<ReturnType<typeof toSlots>>;
const RISK = 300;

/** the share of the way to the target needed to pay charges alone, and charges plus the usual stop slippage */
export function coverShare(close: number, adr: number, avgVol: number, slipTicks: number): { charges: number; withSlip: number } {
  const band = liqBand(avgVol), entry = close - TICK * slipTicks, stop = onTick(close + WIDE_STOP_ADR * adr, 1), target = onTick(close - NEAR_TARGET_ADR * adr, -1);
  let qty = sizeFor(RISK, stop - entry);
  if (qty * entry > POSITION_CAP) qty = Math.max(1, Math.floor(POSITION_CAP / entry));
  const c = roundTripCharges(qty, entry, entry, -1) / qty, way = entry - target;
  return { charges: c / way, withSlip: (c + Math.max(TICK, (band.stopPct / 100) * entry)) / way };
}

export function simulate(day: Day, k: number, adr: number, avgVol: number, rule: Rule, through: number): { net: number; inr: number } {
  const close = day.c[k - 1], band = liqBand(avgVol), slip = Math.max(k < 20 ? 2 : 1, band.ticks);
  const entry = close - TICK * slip, stop0 = onTick(close + WIDE_STOP_ADR * adr, 1), fullTarget = onTick(close - NEAR_TARGET_ADR * adr, -1);
  const dist = stop0 - entry;
  if (!(dist > 0)) return { net: NaN, inr: NaN };
  let qty = sizeFor(RISK, dist);
  if (qty * entry > POSITION_CAP) qty = Math.max(1, Math.floor(POSITION_CAP / entry));
  const way = NEAR_TARGET_ADR * adr;
  const target = rule.kind === 'cash' ? onTick(close - rule.at * way, -1) : fullTarget;
  const trigger = close - rule.at * way;
  const charges = roundTripCharges(qty, entry, entry, -1) / qty;
  const slipPs = Math.max(TICK, (band.stopPct / 100) * entry);
  const lockAt = rule.kind === 'cover' ? onTick(entry - charges, -1) : rule.kind === 'coverSlip' ? onTick(entry - charges - slipPs, -1) : onTick(entry - rule.lock * (entry - fullTarget), 1);
  let stop = stop0, exit = NaN;
  for (let s = k; s < LATE_END; s++) {
    if (day.h[s] >= stop) { exit = stop + stopSlip(day, s, stop, band.stopPct, FAST_STOP_FRAC); break; }
    if (day.l[s] <= target - TICK * through) { exit = target; break; }
    if ((rule.kind === 'lock' || rule.kind === 'cover' || rule.kind === 'coverSlip') && day.l[s] <= trigger && lockAt < stop) stop = lockAt;
  }
  if (!Number.isFinite(exit)) exit = day.c[LATE_END - 1] + TICK * band.ticks;
  const net = (entry - exit) / dist - roundTripCharges(qty, entry, exit, -1) / (qty * dist);
  return { net, inr: net * qty * dist };
}

type Trade = (string | number | null)[];
export async function profitLock(ml: { examFrom: string; strategies: Strat[]; untouched?: Strat[] }, id: string, store: Store, log: (m: string) => void) {
  const st = ml.strategies.find((s) => s.id === id);
  if (!st?.trades?.length) throw new Error(`no trades for ${id}`);
  const un = (ml.untouched ?? []).find((u) => u.id === id);
  const cols = st.tradeCols ?? [];
  const [iDay, iSym, iTime] = ['day', 'sym', 'time'].map((c) => cols.indexOf(c));
  const all = [...st.trades, ...(un?.trades ?? [])];
  const { days, dailies } = await loadDays(store, all.map((t) => ({ sym: String(t[iSym]), date: String(t[iDay]) })));
  log(`loaded ${days.size} trade days`);
  const dateOf = (sec: number) => new Date(sec * 1000 + 19800_000).toISOString().slice(0, 10);
  const prep = (list: Trade[]) => list.flatMap((t) => {
    const date = String(t[iDay]), sym = String(t[iSym]), [hh, mm] = String(t[iTime]).split(':').map(Number);
    const k = hh * 60 + mm - 555, day = days.get(`${sym}|${date}`), daily = dailies.get(sym);
    const before = daily ? daily.t.map(dateOf).filter((x) => x < date).length : 0;
    if (!day || !daily || before < 10) return [];
    let adr = 0, vol = 0;
    for (let i = before - 10; i < before; i++) { adr += daily.h[i] - daily.l[i]; vol += daily.v[i]; }
    return [{ month: date.slice(0, 7), day, k, adr: adr / 10, vol: vol / 10 }];
  });
  const m = (t: Trade) => String(t[iDay]).slice(0, 7);
  const decide = prep(st.trades.filter((t) => m(t) < ml.examFrom)), exam = prep(st.trades.filter((t) => m(t) >= ml.examFrom)), unt = prep(un?.trades ?? []);
  // the simulator must agree with the backtest's own ride() on the base rule
  let checked = 0, mismatch = 0;
  for (const x of [...decide, ...exam, ...unt]) {
    const band = liqBand(x.vol), close = x.day.c[x.k - 1];
    const stop = onTick(close + WIDE_STOP_ADR * x.adr, 1), tgt = onTick(close - NEAR_TARGET_ADR * x.adr, -1), slip = Math.max(x.k < 20 ? 2 : 1, band.ticks);
    const entry = close - TICK * slip, q = sizeFor(RISK, stop - entry), cap = q * entry > POSITION_CAP;
    const a = ride(x.day, x.k, -1, close, stop, tgt, LATE_END, RISK, { slip, through: band.ticks, stopPct: band.stopPct, fast: FAST_STOP_FRAC, outSlip: band.ticks, ...(cap ? { notional: POSITION_CAP } : {}) });
    const b = simulate(x.day, x.k, x.adr, x.vol, RULES[0], band.ticks);
    checked++; if (Math.abs(a.net - b.net) > 0.002) mismatch++;
  }
  const rowsOf = (set: typeof decide, rule: Rule, through: number): Row[] => set.map((x) => {
    const o = simulate(x.day, x.k, x.adr, x.vol, rule, through), b = simulate(x.day, x.k, x.adr, x.vol, RULES[0], through);
    return { month: x.month, net: o.net, inr: o.inr, capped: false, base: b.net };
  }).filter((r) => Number.isFinite(r.net));
  const table = (through: number): (Line & { rule: string })[] => RULES.map((r) => ({ ...lineOf(0, rowsOf(decide, r, through)), rule: r.id }));
  const q = (a: number[], p: number) => { const b = [...a].sort((x, y) => x - y); return Math.round(b[Math.floor(p * (b.length - 1))] * 1000) / 10; };
  const shares = decide.map((x) => coverShare(x.day.c[x.k - 1], x.adr, x.vol, Math.max(x.k < 20 ? 2 : 1, liqBand(x.vol).ticks)));
  const cover = { charges: { p50: q(shares.map((x) => x.charges), 0.5), p90: q(shares.map((x) => x.charges), 0.9) }, withSlip: { p50: q(shares.map((x) => x.withSlip), 0.5), p90: q(shares.map((x) => x.withSlip), 0.9) } };
  const t1 = table(1), t3 = table(3);
  // the choice: best on the harder fill (3 ticks), so it cannot rest on wicks counting as fills
  const best = t3.reduce((a, b) => (b.netR > a.netR ? b : a)).rule;
  const check = (set: typeof decide, through: number) => [...new Set(['base', best])].map((id2) => ({ ...lineOf(0, rowsOf(set, RULES.find((r) => r.id === id2)!, through)), rule: id2 }));
  return { strategy: id, cover, checked, mismatch, chosen: best, through1: t1, through3: t3, exam1: check(exam, 1), exam3: check(exam, 3), untouched1: check(unt, 1), untouched3: check(unt, 3) };
}
