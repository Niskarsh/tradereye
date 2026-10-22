import { roundTripCharges, sizeFor } from '../setups/costs';
import { onTick, TICK } from '../study/mine';
import { LATE_END, ride, WIDE_STOP_ADR } from './grid';

/**
 * Algo Lab, trade management (iteration 8): the SAME trades the model picked, managed differently after entry.
 * Entries never change, so no model is trained here; every variant is replayed on the 1-minute bars of that day.
 *
 *  - base       stop ½ the usual daily range, the strategy's target, out by 15:15 (exactly the label the model used)
 *  - be         once price has gone `be` of the way to the target, the stop moves to the entry
 *  - add once / add twice: when price has gone `at` of the way to the target (momentum), or has got there, bounced
 *               0.2R and broken back through it (pullback), a second position of `size` × the first is added. The stop
 *               of the whole position then moves to where the WHOLE position would lose `budget` × the first trade's
 *               risk (1 = never more than at the start, 0 = break-even on everything): never at an entry price, so the
 *               new position has room to breathe. The target is kept or extended to 1× the usual daily range.
 *               A second add waits for halfway from the first add to the target, with the same rules.
 *  - an add only happens if the move leaves room: the target is at least ROOM × the new stop's distance away, the new
 *    stop is above the market (for a short), it is no later than 14:15; otherwise it is skipped and the trade goes on.
 *
 * Fills are cautious, as everywhere: entries / adds / stops 1 tick worse, targets only when traded through, and when
 * a stop and anything else can happen in the same minute, the stop counts.
 */

export type Slots = Parameters<typeof ride>[0];
export type Style = 'momentum' | 'pullback';
/** target after the first add: keep the strategy's, or move it to 1× / 1.5× the usual daily range from the entry */
export type AddTarget = 'keep' | 'x1' | 'x1.5';
export interface AddRule {
  at: number; size: number; budget: number; target: AddTarget; style: Style; twice: boolean;
  /** the add must be able to win at least `room` × its own breathing room (its distance to the new stop) */
  room: number;
  /** where a second add waits: halfway from the first add to the target, or 0.5R (of the first trade) beyond the first add */
  gap: 'half' | 'r0.5';
}
export interface Variant { id: string; family: 'base' | 'be' | 'add1' | 'add2' | 'combo'; label: string; be?: number; add?: AddRule }
export interface Outcome { net: number; adds: number; be: boolean; how: 'target' | 'stop' | 'close' }

export const ADD_LAST_SLOT = 300, PULLBACK_R = 0.2;

export interface ManagedTrade {
  day: Slots; k: number; close: number; adr: number; targetAdr: number; d?: 1 | -1; risk?: number; slip?: number;
}

export function manage(t: ManagedTrade, v: Variant): Outcome {
  const d = t.d ?? -1, risk = t.risk ?? 300, day = t.day;
  const E = t.close + d * TICK * (t.slip ?? 1);
  let stop = onTick(t.close - d * WIDE_STOP_ADR * t.adr, (-d) as 1 | -1);
  const target0 = onTick(t.close + d * t.targetAdr * t.adr, d);
  const moved = (r: AddRule) => (r.target === 'keep' ? target0 : onTick(t.close + d * Math.max(r.target === 'x1' ? 1 : 1.5, t.targetAdr) * t.adr, d));
  let target = target0;
  const dist = (E - stop) * d;
  const q1 = sizeFor(risk, dist);
  const rInr = q1 * dist;
  const units: { q: number; e: number }[] = [{ q: q1, e: E }];
  const fav = (frac: number, from = E, to = target0) => from + (to - from) * frac;
  const reach = (x: number, s: number) => (d === 1 ? day.h[s] >= x : day.l[s] <= x);
  const hitStop = (s: number) => (d === 1 ? day.l[s] <= stop : day.h[s] >= stop);
  const tighter = (a: number, b: number) => (d === 1 ? Math.max(a, b) : Math.min(a, b));

  const add = v.add;
  let beDone = false, adds = 0, skipped = false;
  let trig = add ? fav(add.at, E, target0) : NaN;
  // pullback state: 0 = waiting to reach the trigger, 1 = reached (tracking the extreme), 2 = bounced (waiting to re-break)
  let pb = 0, ext = NaN;

  const finish = (exit: number, how: Outcome['how']): Outcome => {
    let pnl = 0;
    for (const u of units) pnl += u.q * (exit - u.e) * d - roundTripCharges(u.q, u.e, exit, d);
    return { net: Math.round((pnl / rInr) * 1000) / 1000, adds, be: beDone, how };
  };

  for (let s = t.k; s < LATE_END; s++) {
    // 1. the stop, then the target (the stop first when both are in this minute)
    if (hitStop(s)) return finish(stop - d * TICK, 'stop');
    if (d === 1 ? day.h[s] >= target + TICK : day.l[s] <= target - TICK) return finish(target, 'target');
    // 2. break-even
    if (v.be !== undefined && !beDone && reach(fav(v.be), s)) {
      beDone = true;
      stop = tighter(stop, E);
      if (hitStop(s)) return finish(stop - d * TICK, 'stop'); // the same minute may have come back: cautious
    }
    // 3. adding
    if (add && !skipped && adds < (add.twice ? 2 : 1)) {
      let fire = false;
      if (add.style === 'momentum') fire = reach(trig, s);
      else {
        const best = d === 1 ? day.h[s] : day.l[s];
        if (pb === 0 && reach(trig, s)) { pb = 1; ext = best; }
        else if (pb === 1) {
          ext = d === 1 ? Math.max(ext, best) : Math.min(ext, best);
          const back = d === 1 ? day.l[s] <= ext - PULLBACK_R * dist : day.h[s] >= ext + PULLBACK_R * dist;
          if (back) pb = 2;
        } else if (pb === 2 && reach(trig, s)) fire = true;
      }
      if (fire) {
        const A = trig + d * TICK; // the add fills 1 tick worse
        const tgt = adds === 0 ? moved(add) : target;
        const q = Math.max(1, Math.round(add.size * q1));
        const all = [...units, { q, e: A }];
        const Q = all.reduce((a, u) => a + u.q, 0);
        // the stop where the whole position loses `budget` × the first trade's risk
        let st = onTick((all.reduce((a, u) => a + u.q * u.e, 0) - d * add.budget * rInr) / Q, (-d) as 1 | -1);
        st = tighter(st, stop); // never loosen
        const room = (A - st) * d; // the new position's breathing room
        const reward = (tgt - A) * d;
        if (s > ADD_LAST_SLOT || !(room > TICK) || reward < add.room * room) skipped = true; // no room: no add, the trade goes on
        else {
          units.push({ q, e: A });
          stop = st; target = tgt; adds++;
          trig = add.gap === 'half' ? A + (tgt - A) * 0.5 : A + d * 0.5 * dist; pb = 0; // where a second add waits
          if (hitStop(s)) return finish(stop - d * TICK, 'stop');
        }
      }
    }
  }
  return finish(day.c[LATE_END - 1] - d * TICK, 'close');
}

/** every variant tested in stage 1 (combinations are built in stage 2 from the winners) */
export function variants(): Variant[] {
  const out: Variant[] = [{ id: 'base', family: 'base', label: 'As now: stop and target only' }];
  for (const be of [0.4, 0.6, 0.8]) out.push({ id: `be${be}`, family: 'be', label: `Break-even once ${be * 100}% of the way to the target`, be });
  for (const twice of [false, true]) for (const gap of (twice ? ['half', 'r0.5'] as const : ['half'] as const))
    for (const style of ['momentum', 'pullback'] as const) for (const at of [0.4, 0.6]) for (const size of [1, 0.5])
      for (const budget of [1, 0.5, 0]) for (const target of ['keep', 'x1', 'x1.5'] as const) for (const room of [1, 1.5]) {
        const rule: AddRule = { at, size, budget, target, style, twice, room, gap };
        out.push({ id: addId(rule), family: twice ? 'add2' : 'add1', label: addLabel(rule), add: rule });
      }
  return out;
}
export const addId = (r: AddRule) => `${r.twice ? `a2${r.gap === 'half' ? 'h' : 'r'}` : 'a1'}-${r.style[0]}${r.at}-x${r.size}-b${r.budget}-t${r.target}-r${r.room}`;
export function addLabel(r: AddRule): string {
  return `${r.twice ? `Add up to twice (2nd ${r.gap === 'half' ? 'halfway to the target' : '0.5R past the 1st'})` : 'Add once'}: ` +
    `${r.style === 'momentum' ? 'at' : 'on a pullback after'} ${r.at * 100}% of the way, ${r.size === 1 ? 'same size' : 'half size'}, ` +
    `stop risks ${r.budget === 0 ? 'nothing (break-even on all)' : `${r.budget}R on all`}, ` +
    `${r.target === 'keep' ? 'same target' : `target ${r.target.slice(1)}× daily range`}, only if it can win ${r.room}× its room`;
}
export function combo(be: Variant, a: Variant): Variant {
  return { id: `${be.id}+${a.id}`, family: 'combo', label: `${be.label}; ${a.label}`, be: be.be, add: a.add };
}

/* ---- the staged comparison ---------------------------------------------------------------------------------- */

export interface Row { month: string; net: Record<string, number>; adds: Record<string, number> }
export interface Line { id: string; family: Variant['family']; label: string; n: number; netR: number; diff: number; t: number; hit: number; addRate: number }
export interface Staged {
  half1: [string, string]; half2: [string, string]; nHalf1: number; nHalf2: number;
  stage1: Line[]; picked: string[]; stage2: Line[]; winner: string; winnerBeatsBase: boolean;
}

function line(rows: Row[], v: Variant): Line {
  const n = rows.length;
  const x = rows.map((r) => r.net[v.id]), b = rows.map((r) => r.net.base);
  const diffs = x.map((y, i) => y - b[i]);
  const mean = (a: number[]) => a.reduce((s, y) => s + y, 0) / Math.max(1, a.length);
  const md = mean(diffs), sd = Math.sqrt(diffs.reduce((s, y) => s + (y - md) ** 2, 0) / Math.max(1, n - 1));
  const r3 = (y: number) => Math.round(y * 1000) / 1000;
  return {
    id: v.id, family: v.family, label: v.label, n, netR: r3(mean(x)), diff: r3(md), t: sd > 0 ? Math.round((md / (sd / Math.sqrt(n))) * 100) / 100 : 0,
    hit: r3(x.filter((y) => y > 0).length / Math.max(1, n)), addRate: r3(rows.filter((r) => (r.adds[v.id] ?? 0) > 0).length / Math.max(1, n)),
  };
}

/**
 * Stage 1 on the first half of the decide months: each family on its own (break-even, add once, add twice). The best
 * break-even and the best 3 of each add family go on. Stage 2 on the second half (which played no part in picking):
 * those, and the best break-even combined with each add, against "as now". The winner must beat "as now" with t ≥ 2.
 * `comboNets` builds the combined variants AND fills each row's net / adds for them (it has the trades).
 */
export function stage(rows: Row[], all: Variant[], comboNets: (be: Variant, adds: Variant[]) => Variant[]): Staged {
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const cut = months[Math.ceil(months.length / 2)] ?? '9999';
  const h1 = rows.filter((r) => r.month < cut), h2 = rows.filter((r) => r.month >= cut);
  const stage1 = all.map((v) => line(h1, v));
  const by = (fam: Variant['family']) => stage1.filter((l) => l.family === fam).sort((a, b) => b.netR - a.netR);
  const be = by('be')[0], a1 = by('add1').slice(0, 3), a2 = by('add2').slice(0, 3);
  const find = (id: string) => all.find((v) => v.id === id)!;
  const picks = [find('base'), ...(be ? [find(be.id)] : []), ...a1.map((l) => find(l.id)), ...a2.map((l) => find(l.id))];
  const combos = be ? comboNets(find(be.id), [...a1, ...a2].map((l) => find(l.id))) : [];
  const stage2 = [...picks, ...combos].map((v) => line(h2, v));
  const best = [...stage2].sort((a, b) => b.netR - a.netR)[0];
  const beats = !!best && best.id !== 'base' && best.t >= 2;
  return {
    half1: [months[0] ?? '', months[Math.ceil(months.length / 2) - 1] ?? ''], half2: [cut, months.at(-1) ?? ''], nHalf1: h1.length, nHalf2: h2.length,
    stage1, picked: picks.map((v) => v.id), stage2, winner: beats ? best.id : 'base', winnerBeatsBase: beats,
  };
}
