import { FEATURES, FEATURE_KEYS, type Moment } from './mine';

/**
 * The reversal study, step 2: from the labelled moments to rules, without deciding anything in advance.
 *
 * For each side (long / short) and target (VWAP / the open) separately:
 *  1. the moves: how many stock-days had a clean reversal at all, and how far stocks fell before one (the drop
 *     range is read from the data, not set);
 *  2. every fact, split into five equal groups on year 1: how often each group was a clean win, a messy win or a
 *     failure, and R after charges, with year 2 next to it (failures are always in the denominator);
 *  3. rules: a search on YEAR 1 ONLY for combinations of facts (up to 4) with the best R after charges, held to a
 *     minimum number of trades and scored cautiously (average minus its noise), one rule at a time, each next rule
 *     searched on the stock-days the earlier rules did not take;
 *  4. every rule is then traded on YEAR 2, which the search never saw: the first moment of a stock-day that matches
 *     the rule is the trade. Only year 2 says whether a rule is real.
 * Year 1, year 2 and both years together are each counted on their own: year 2 is the rule applied to ALL of year 2's
 * days (not what year 1 left). Clean + messy + fail = 100% of the trades in every row.
 * "t" = how sure a result is (average R after charges ÷ its standard error): about 2 or more means it is unlikely to
 * be luck; under 1 it could easily be. With many rules shown, a few will look good on year 2 by luck alone.
 */

export type TargetKey = 'v' | 'o';
export interface Outcomes {
  n: number; clean: number; messy: number; fail: number; hit: number; grossR: number; netR: number; netWide: number; min: number; days: number;
  /** spread of R after charges, and how sure the average is (netR ÷ standard error) */
  sd: number; t: number;
  /** median rupees in the position at his risk */
  posMed: number;
}
export interface Cond { f: string; op: '>=' | '<'; v: number }
export interface RuleResult { conds: Cond[]; text: string; y1: Outcomes; y2: Outcomes; all: Outcomes; examples: { symbol: string; date: string; time: string; entry: number; stop: number; target: number; label: string; net: number }[] }
export interface FeatureBin { lo: number; hi: number; y1: Outcomes; y2: Outcomes; all: Outcomes }
export interface FeatureTable { f: string; label: string; spread: number; bins: FeatureBin[] }
export interface ComboStudy {
  dir: 'LONG' | 'SHORT'; target: 'VWAP' | 'OPEN';
  base: { y1: Outcomes; y2: Outcomes; y1First: Outcomes; y2First: Outcomes; allFirst: Outcomes };
  moves: { stockDays: number; withClean: number; dropBeforeClean: { p10: number; p25: number; p50: number; p75: number; p90: number }; dropPctBeforeClean: { p25: number; p50: number; p75: number } };
  drop: { lo: number; hi: number; y1: Outcomes; y2: Outcomes; all: Outcomes }[];
  bestDrop?: { lo: number; hi: number; y1: Outcomes; y2: Outcomes; all: Outcomes };
  features: FeatureTable[];
  rules: RuleResult[];
  /** how many of the rules use each fact */
  common: { f: string; label: string; rules: number }[];
  /** all the rules together, year 2 (the first matching moment of a stock-day) */
  together: { y1: Outcomes; y2: Outcomes; all: Outcomes };
}
export interface Study { v: 2; runId: string; createdAt: number; period: { from: string; to: string; mid: string }; moments: number; combos: ComboStudy[]; minTrades: number }

const LABEL = Object.fromEntries(FEATURES.map(([k, l]) => [k, l])) as Record<string, string>;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function outcomes(all: Moment[], t: TargetKey): Outcomes {
  const ms = all.filter((x) => x[t]); // the open target is missing when the open was not ahead of the entry
  const n = ms.length;
  let c = 0, m = 0, f = 0, hit = 0, g = 0, net = 0, net2 = 0, w = 0, min = 0;
  const days = new Set<string>(), pos: number[] = [];
  for (const x of ms) {
    const o = x[t]!;
    if (o.label === 'C') c++; else if (o.label === 'M') m++; else f++;
    if (o.net > 0) hit++;
    g += o.r; net += o.net; net2 += o.net * o.net; w += o.netWide; min += o.min;
    days.add(`${x.symbol}|${x.date}`); pos.push(o.posInr ?? 0);
  }
  const q = (a: number) => (n ? r3(a / n) : 0);
  const mu = n ? net / n : 0, sd = n > 1 ? Math.sqrt(Math.max(0, (net2 - n * mu * mu) / (n - 1))) : 0;
  pos.sort((a, b) => a - b);
  return {
    n, clean: q(c), messy: q(m), fail: q(f), hit: q(hit), grossR: n ? r2(g / n) : 0, netR: n ? r2(mu) : 0, netWide: n ? r2(w / n) : 0, min: n ? Math.round(min / n) : 0, days: days.size,
    sd: r2(sd), t: n > 1 && sd > 0 ? r2(mu / (sd / Math.sqrt(n))) : 0, posMed: pos.length ? Math.round(pos[pos.length >> 1]) : 0,
  };
}

/** the first moment of each stock-day (and side) in a set: the trade you would actually have taken */
export function firstOfDay(ms: Moment[]): Moment[] {
  const best = new Map<string, Moment>();
  for (const m of ms) { const k = `${m.symbol}|${m.date}|${m.dir}`; const b = best.get(k); if (!b || m.slot < b.slot) best.set(k, m); }
  return [...best.values()];
}

const pctl = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN);

export function condText(c: Cond): string {
  const v = Math.abs(c.v) >= 10 ? c.v.toFixed(0) : c.v.toFixed(2);
  return `${LABEL[c.f] ?? c.f} ${c.op === '>=' ? '≥' : '<'} ${v}`;
}

function matcher(conds: Cond[]) {
  const idx = conds.map((c) => ({ i: FEATURE_KEYS.indexOf(c.f as never), ...c }));
  return (m: Moment) => idx.every((c) => { const x = m.x[c.i]; return Number.isFinite(x) && (c.op === '>=' ? x >= c.v : x < c.v); });
}

export interface StudyOptions { minTrades?: number; maxRules?: number; maxConds?: number; beam?: number }

export function analyze(moments: Moment[], meta: { runId: string; createdAt: number; period: Study['period'] }, opts: StudyOptions = {}): Study {
  const minTrades = opts.minTrades ?? 150;
  const combos: ComboStudy[] = [];
  for (const dir of [1, -1] as const) {
    const side = moments.filter((m) => m.dir === dir);
    for (const t of ['v', 'o'] as const) combos.push(study(side, dir, t, meta.period.mid, { minTrades, maxRules: opts.maxRules ?? 10, maxConds: opts.maxConds ?? 4, beam: opts.beam ?? 3 }));
  }
  return { v: 2, ...meta, moments: moments.length, combos, minTrades };
}

function study(side: Moment[], dir: 1 | -1, t: TargetKey, mid: string, o: Required<StudyOptions>): ComboStudy {
  const ms = side.filter((m) => m[t]); // only moments where this target was ahead of the entry
  const y1 = ms.filter((m) => m.date < mid), y2 = ms.filter((m) => m.date >= mid);

  // ---- 1. the moves
  const byDay = new Map<string, Moment[]>();
  for (const m of ms) { const k = `${m.symbol}|${m.date}`; const a = byDay.get(k) ?? []; a.push(m); byDay.set(k, a); }
  const iRun = FEATURE_KEYS.indexOf('runAdr'), iPct = FEATURE_KEYS.indexOf('runPct');
  const cleanDrops: number[] = [], cleanPct: number[] = [];
  let withClean = 0;
  for (const list of byDay.values()) {
    const first = list.filter((m) => m[t]!.label === 'C').sort((a, b) => a.slot - b.slot)[0];
    if (first) { withClean++; cleanDrops.push(first.x[iRun]); cleanPct.push(first.x[iPct]); }
  }
  cleanDrops.sort((a, b) => a - b); cleanPct.sort((a, b) => a - b);

  // ---- the drop before the turn, in bands (all moments in the band; failures included)
  const edges = [0.2, 0.4, 0.6, 0.8, 1.0, 1.25, 1.5, 2, 3, Infinity];
  const drop = edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1];
    const inBand = (m: Moment) => m.x[iRun] >= lo && m.x[iRun] < hi;
    return { lo, hi, y1: outcomes(firstOfDay(y1.filter(inBand)), t), y2: outcomes(firstOfDay(y2.filter(inBand)), t), all: outcomes(firstOfDay(ms.filter(inBand)), t) };
  });
  // the best band read from year 1 (contiguous bands, enough trades), shown with its year 2
  let bestDrop: ComboStudy['bestDrop'];
  for (let a = 0; a < edges.length - 1; a++) for (let b = a + 1; b < edges.length; b++) {
    const lo = edges[a], hi = edges[b];
    const inBand = (m: Moment) => m.x[iRun] >= lo && m.x[iRun] < hi;
    const s1 = outcomes(firstOfDay(y1.filter(inBand)), t);
    if (s1.n < o.minTrades) continue;
    if (!bestDrop || s1.netR > bestDrop.y1.netR) bestDrop = { lo, hi, y1: s1, y2: outcomes(firstOfDay(y2.filter(inBand)), t), all: outcomes(firstOfDay(ms.filter(inBand)), t) };
  }

  // ---- 2. every fact in five groups (edges from year 1)
  const features: FeatureTable[] = [];
  const thresholds: Record<string, number[]> = {};
  FEATURE_KEYS.forEach((f, fi) => {
    const vals = y1.map((m) => m.x[fi]).filter(Number.isFinite).sort((a, b) => a - b);
    if (vals.length < 50) return;
    const binary = vals.every((v) => v === 0 || v === 1);
    const cuts = binary ? [0.5] : [...new Set([0.2, 0.4, 0.6, 0.8].map((p) => r3(pctl(vals, p))))];
    thresholds[f] = cuts;
    const bounds = [-Infinity, ...cuts, Infinity];
    const bins: FeatureBin[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const lo = bounds[i], hi = bounds[i + 1];
      const inBin = (m: Moment) => Number.isFinite(m.x[fi]) && m.x[fi] >= lo && m.x[fi] < hi;
      bins.push({ lo, hi, y1: outcomes(y1.filter(inBin), t), y2: outcomes(y2.filter(inBin), t), all: outcomes(ms.filter(inBin), t) });
    }
    const ok = bins.filter((b) => b.y1.n >= 100);
    const spread = ok.length >= 2 ? r2(Math.max(...ok.map((b) => b.y1.netR)) - Math.min(...ok.map((b) => b.y1.netR))) : 0;
    features.push({ f, label: LABEL[f], spread, bins });
  });
  features.sort((a, b) => b.spread - a.spread);

  // ---- 3. rules, searched on year 1 only
  const conds: Cond[] = [];
  for (const [f, cuts] of Object.entries(thresholds)) for (const v of cuts) { conds.push({ f, op: '>=', v }); conds.push({ f, op: '<', v }); }
  const condIdx = conds.map((c) => FEATURE_KEYS.indexOf(c.f as never));
  const pass = (m: Moment, ci: number) => { const x = m.x[condIdx[ci]]; const c = conds[ci]; return Number.isFinite(x) && (c.op === '>=' ? x >= c.v : x < c.v); };
  /** the cautious score: average R after charges minus one standard error, on the first moment of each stock-day */
  const score = (rows: Moment[]): number => {
    const f = firstOfDay(rows);
    if (f.length < o.minTrades) return -Infinity;
    let s = 0, s2 = 0;
    for (const m of f) { s += m[t]!.net; s2 += m[t]!.net ** 2; }
    const mu = s / f.length, sd = Math.sqrt(Math.max(0, s2 / f.length - mu * mu));
    return mu - sd / Math.sqrt(f.length);
  };

  const rules: RuleResult[] = [];
  let pool = y1;
  for (let ri = 0; ri < o.maxRules && pool.length >= o.minTrades; ri++) {
    type Beam = { cs: number[]; rows: Moment[]; sc: number };
    let beam: Beam[] = [{ cs: [], rows: pool, sc: -Infinity }];
    let best: Beam | undefined;
    for (let depth = 0; depth < o.maxConds; depth++) {
      const next: Beam[] = [];
      for (const b of beam) {
        for (let ci = 0; ci < conds.length; ci++) {
          if (b.cs.some((x) => conds[x].f === conds[ci].f)) continue; // one condition per fact
          const rows = b.rows.filter((m) => pass(m, ci));
          if (rows.length < o.minTrades) continue;
          const sc = score(rows);
          if (sc > b.sc + 0.005) next.push({ cs: [...b.cs, ci], rows, sc });
        }
      }
      if (!next.length) break;
      next.sort((a, b) => b.sc - a.sc);
      beam = next.slice(0, o.beam);
      if (!best || beam[0].sc > best.sc) best = beam[0];
    }
    if (!best) break;
    const cs = best.cs.map((i) => conds[i]);
    const match = matcher(cs);
    const t1 = firstOfDay(y1.filter(match)), t2 = firstOfDay(y2.filter(match));
    const ex = t2.sort((a, b) => (a.date === b.date ? a.slot - b.slot : a.date < b.date ? -1 : 1)).slice(-8).map((m) => ({
      symbol: m.symbol, date: m.date, time: hhmm(m.slot), entry: m.entry, stop: m.stop, target: t === 'v' ? m.vwap : m.open, label: m[t]!.label, net: m[t]!.net,
    }));
    rules.push({ conds: cs, text: cs.map(condText).join(' AND '), y1: outcomes(t1, t), y2: outcomes(t2, t), all: outcomes(firstOfDay(ms.filter(match)), t), examples: ex });
    // the next rule is searched on the stock-days this one did not take
    const taken = new Set(t1.map((m) => `${m.symbol}|${m.date}`));
    pool = pool.filter((m) => !taken.has(`${m.symbol}|${m.date}`));
  }

  const counts = new Map<string, number>();
  for (const r of rules) for (const c of r.conds) counts.set(c.f, (counts.get(c.f) ?? 0) + 1);
  const anyRule = (m: Moment) => rules.some((r) => matcher(r.conds)(m));
  return {
    dir: dir === 1 ? 'LONG' : 'SHORT', target: t === 'v' ? 'VWAP' : 'OPEN',
    base: { y1: outcomes(y1, t), y2: outcomes(y2, t), y1First: outcomes(firstOfDay(y1), t), y2First: outcomes(firstOfDay(y2), t), allFirst: outcomes(firstOfDay(ms), t) },
    moves: {
      stockDays: byDay.size, withClean,
      dropBeforeClean: { p10: r2(pctl(cleanDrops, 0.1)), p25: r2(pctl(cleanDrops, 0.25)), p50: r2(pctl(cleanDrops, 0.5)), p75: r2(pctl(cleanDrops, 0.75)), p90: r2(pctl(cleanDrops, 0.9)) },
      dropPctBeforeClean: { p25: r2(pctl(cleanPct, 0.25)), p50: r2(pctl(cleanPct, 0.5)), p75: r2(pctl(cleanPct, 0.75)) },
    },
    drop, bestDrop, features, rules,
    common: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => ({ f, label: LABEL[f], rules: n })),
    together: { y1: outcomes(firstOfDay(y1.filter(anyRule)), t), y2: outcomes(firstOfDay(y2.filter(anyRule)), t), all: outcomes(firstOfDay(ms.filter(anyRule)), t) },
  };
}

function hhmm(slot: number) { const m = 555 + slot; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
