import { CASE_BY_ID, CASES, PRIMARY_TARGET, STRETCH_CUMULATIVE, stretchBucket, type CaseId, type Signal, type TargetKey } from './cases';

/**
 * Numbers for a set of signals. The same code runs in the backtest job (summary + alert lookup) and on the My Setups
 * page (any filter he picks), so the page can never show a number the alerts do not use.
 */

export interface Stats {
  /** trades (for M9: limit orders that were filled) */
  n: number;
  /** share of trades that reached the target before the stop (0..1) */
  hit: number;
  /** average result in R after Dhan's charges */
  netR: number;
  /** share of trades that made money after charges */
  netWin: number;
  /** average minutes in the trade */
  min: number;
  /** the same hit rate in the first and second half of the period (is it stable?) */
  h1: { n: number; hit: number }; h2: { n: number; hit: number };
  /** M9 only: share of the limit orders that were filled */
  fill?: number;
}

const round = (x: number, p = 3) => Math.round(x * 10 ** p) / 10 ** p;

export function primaryTarget(c: CaseId): TargetKey { return PRIMARY_TARGET[CASE_BY_ID.get(c)!.family]; }

/** `mid` = the first day of the second half (YYYY-MM-DD). */
export function statsOf(signals: Signal[], target: TargetKey | 'PRIMARY', mid: string): Stats {
  const all = signals.filter((s) => s.out);
  const trades = all.filter((s) => s.case !== 'M9' || s.out!.filled);
  let hit = 0, net = 0, win = 0, min = 0;
  const h = [{ n: 0, hit: 0 }, { n: 0, hit: 0 }];
  for (const s of trades) {
    const r = s.out![target === 'PRIMARY' ? primaryTarget(s.case) : target];
    if (r.hit) hit++;
    net += r.net; if (r.net > 0) win++; min += r.min;
    const half = h[s.date < mid ? 0 : 1];
    half.n++; if (r.hit) half.hit++;
  }
  const n = trades.length;
  const m9 = all.filter((s) => s.case === 'M9');
  return {
    n, hit: n ? round(hit / n) : 0, netR: n ? round(net / n) : 0, netWin: n ? round(win / n) : 0, min: n ? Math.round(min / n) : 0,
    h1: { n: h[0].n, hit: h[0].n ? round(h[0].hit / h[0].n) : 0 }, h2: { n: h[1].n, hit: h[1].n ? round(h[1].hit / h[1].n) : 0 },
    ...(m9.length && m9.length === all.length ? { fill: round(trades.length / m9.length) } : {}),
  };
}

/* ---- slices ---------------------------------------------------------------------------------------------- */

export type DimKey = 'dir' | 'time' | 'nFirst5' | 'nDay' | 'nRecent' | 'rvol' | 'openBusy' | 'stretch' | 'emaInWay' | 'capped';
export const DIMS: { key: DimKey; label: string; values: string[] }[] = [
  { key: 'dir', label: 'Side', values: ['LONG', 'SHORT'] },
  { key: 'time', label: 'Time', values: ['09:20-09:45', '09:45-11:00', '11:00-13:00', '13:00-15:00'] },
  { key: 'nFirst5', label: 'Nifty first 5 min', values: ['WITH', 'FLAT', 'AGAINST'] },
  { key: 'nDay', label: 'Nifty open → trade', values: ['EARLY', 'WITH', 'FLAT', 'AGAINST'] },
  { key: 'nRecent', label: 'Nifty 30 min before trade', values: ['EARLY', 'WITH', 'FLAT', 'AGAINST'] },
  { key: 'rvol', label: 'Volume vs usual', values: ['LOW', 'NORMAL', 'HIGH'] },
  { key: 'openBusy', label: 'Rvol > 0.1 at 09:20', values: ['YES', 'NO'] },
  { key: 'stretch', label: '% of daily range moved', values: ['<0', '0-30', '30-50', '50-60', '60-70', '70-80', '80-90', '90-95', '95+'] },
  { key: 'emaInWay', label: '200 EMA in the way', values: ['NO', 'YES'] },
  { key: 'capped', label: 'Stop capped at 2x ATR', values: ['NO', 'YES'] },
];

export function dimValue(s: Signal, k: DimKey): string {
  switch (k) {
    case 'dir': return s.dir === 1 ? 'LONG' : 'SHORT';
    case 'stretch': return stretchBucket(s.stretch);
    case 'openBusy': return s.openBusy ? 'YES' : 'NO';
    case 'emaInWay': return s.emaInWay ? 'YES' : 'NO';
    case 'capped': return s.capped ? 'YES' : 'NO';
    default: return String(s[k]);
  }
}

export type Filter = Partial<Record<DimKey, string[]>> & { minStretch?: number; with?: CaseId };
export function applyFilter(signals: Signal[], f: Filter): Signal[] {
  return signals.filter((s) => {
    for (const d of DIMS) { const v = f[d.key]; if (v?.length && !v.includes(dimValue(s, d.key))) return false; }
    if (f.minStretch !== undefined && s.stretch < f.minStretch) return false;
    if (f.with && !s.with.includes(f.with)) return false;
    return true;
  });
}

/* ---- the summary written by each run --------------------------------------------------------------------- */

export interface CaseSummary {
  id: CaseId;
  all: Stats;
  byTarget: Record<TargetKey, Stats>;
  slices: Partial<Record<DimKey, Record<string, Stats>>>;
  /** reversal: stretch at least 50%, 60% ... (what he asked to see) */
  stretchAtLeast?: Record<string, Stats>;
  /** the other cases that fired with it most often, and how the combination did */
  combos: { with: CaseId; stats: Stats }[];
}

export interface RuleCheck { id: string; title: string; rows: { label: string; stats: Stats }[] }

export interface Summary {
  v: 1;
  runId: string;
  createdAt: number;
  period: { from: string; to: string; mid: string };
  universe: { source: string; symbols: number; stockDays: number; signals: number };
  params: Record<string, number | string>;
  cases: CaseSummary[];
  rules: RuleCheck[];
  /** the alert lookup: bucket key -> stats (see bucketKeys) */
  lookup: Record<string, Stats>;
}

export const MIN_CASES = 50;

/**
 * The buckets a live signal is matched against, most specific first: the case with its stretch, time and Nifty
 * (open -> trade); without Nifty; with stretch only; the case alone.
 */
export function bucketKeys(s: Pick<Signal, 'case' | 'stretch' | 'time' | 'nDay'>): string[] {
  const st = stretchBucket(s.stretch);
  return [`${s.case}|${st}|${s.time}|${s.nDay}`, `${s.case}|${st}|${s.time}`, `${s.case}|${st}`, `${s.case}`];
}

export function buildSummary(signals: Signal[], meta: Omit<Summary, 'v' | 'cases' | 'rules' | 'lookup' | 'universe'> & { universe: Omit<Summary['universe'], 'signals'> }): Summary {
  const mid = meta.period.mid;
  const cases: CaseSummary[] = [];
  const lookup: Record<string, Stats> = {};
  for (const c of CASES) {
    const mine = signals.filter((s) => s.case === c.id);
    const slices: CaseSummary['slices'] = {};
    for (const d of DIMS) {
      const groups: Record<string, Stats> = {};
      for (const v of d.values) {
        const g = mine.filter((s) => dimValue(s, d.key) === v);
        if (g.length) groups[v] = statsOf(g, 'PRIMARY', mid);
      }
      slices[d.key] = groups;
    }
    const counts = new Map<CaseId, number>();
    for (const s of mine) for (const w of s.with) counts.set(w, (counts.get(w) ?? 0) + 1);
    const combos = [...counts.entries()].filter(([, n]) => n >= MIN_CASES).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([w]) => ({ with: w, stats: statsOf(mine.filter((s) => s.with.includes(w)), 'PRIMARY', mid) }));
    const sum: CaseSummary = {
      id: c.id, all: statsOf(mine, 'PRIMARY', mid),
      byTarget: { T1: statsOf(mine, 'T1', mid), T15: statsOf(mine, 'T15', mid), TS: statsOf(mine, 'TS', mid) },
      slices, combos,
    };
    if (c.family === 'REVERSAL') {
      sum.stretchAtLeast = {};
      for (const t of STRETCH_CUMULATIVE) sum.stretchAtLeast[`${t}%+`] = statsOf(mine.filter((s) => s.stretch >= t), 'PRIMARY', mid);
    }
    cases.push(sum);
    const byKey = new Map<string, Signal[]>();
    for (const s of mine) for (const k of bucketKeys(s)) { const a = byKey.get(k) ?? []; a.push(s); byKey.set(k, a); }
    for (const [k, g] of byKey) { const st = statsOf(g, 'PRIMARY', mid); if (st.n >= MIN_CASES) lookup[k] = st; }
  }
  return { v: 1, ...meta, universe: { ...meta.universe, signals: signals.length }, cases, rules: ruleChecks(signals, mid), lookup };
}

/** His own rules, checked against every signal (primary target of each case). */
export function ruleChecks(signals: Signal[], mid: string): RuleCheck[] {
  const fam = (f: 'MOMENTUM' | 'REVERSAL') => signals.filter((s) => CASE_BY_ID.get(s.case)!.family === f && s.case !== 'M9');
  const mom = fam('MOMENTUM'), rev = fam('REVERSAL');
  const row = (label: string, g: Signal[]) => ({ label, stats: statsOf(g, 'PRIMARY', mid) });
  return [
    { id: 'openRvol', title: 'Rvol above 0.1 at 09:20 means a momentum day (otherwise reversal)', rows: [
      row('Momentum trades, rvol > 0.1', mom.filter((s) => s.openBusy)), row('Momentum trades, rvol ≤ 0.1', mom.filter((s) => !s.openBusy)),
      row('Reversal trades, rvol > 0.1', rev.filter((s) => s.openBusy)), row('Reversal trades, rvol ≤ 0.1', rev.filter((s) => !s.openBusy)),
    ] },
    { id: 'nifty5', title: 'Nifty 500\'s first 5 minutes decide the day', rows: [
      row('Momentum, Nifty first 5 min with the trade', mom.filter((s) => s.nFirst5 === 'WITH')),
      row('Momentum, Nifty first 5 min flat', mom.filter((s) => s.nFirst5 === 'FLAT')),
      row('Momentum, Nifty first 5 min against', mom.filter((s) => s.nFirst5 === 'AGAINST')),
      row('Reversal, Nifty first 5 min flat', rev.filter((s) => s.nFirst5 === 'FLAT')),
      row('Reversal, Nifty first 5 min directional', rev.filter((s) => s.nFirst5 !== 'FLAT')),
    ] },
    { id: 'ema', title: 'Skip when a 200 EMA is in the way', rows: [
      row('Momentum, EMA clear', mom.filter((s) => !s.emaInWay)), row('Momentum, EMA in the way', mom.filter((s) => s.emaInWay)),
      row('Reversal, EMA clear', rev.filter((s) => !s.emaInWay)), row('Reversal, EMA in the way', rev.filter((s) => s.emaInWay)),
    ] },
  ];
}

/* ---- alerts ---------------------------------------------------------------------------------------------- */

export interface AlertGate { minHit: number }
/** Good enough to alert: 50+ past cases, the hit rate, money after charges, and holding up in both halves. */
export function passes(st: Stats | undefined, g: AlertGate): boolean {
  if (!st || st.n < MIN_CASES) return false;
  if (st.hit < g.minHit || st.netR <= 0) return false;
  if (st.h1.n < 20 || st.h2.n < 20) return false;
  return Math.min(st.h1.hit, st.h2.hit) >= g.minHit - 0.1;
}

/** The most specific bucket with enough past cases. */
export function lookupFor(summary: Pick<Summary, 'lookup'>, s: Pick<Signal, 'case' | 'stretch' | 'time' | 'nDay'>): { key: string; stats: Stats } | undefined {
  for (const k of bucketKeys(s)) { const st = summary.lookup[k]; if (st) return { key: k, stats: st }; }
  return undefined;
}

/* ---- compact storage: signals as columns (about 5x smaller than objects) ---------------------------------- */

const COLS = ['case', 'symbol', 'date', 'slot', 'dir', 'entry', 'stop', 'target', 'stopAtr', 'atr', 'capped', 'time', 'nFirst5', 'nDay', 'nRecent', 'rvol', 'openBusy', 'stretch', 'emaInWay', 'gapPct', 'with'] as const;
const OUT = ['T1', 'T15', 'TS'] as const;
export interface Packed { v: 1; cols: string[]; rows: unknown[][] }

export function pack(signals: Signal[]): Packed {
  const cols = [...COLS, 'out'];
  const rows = signals.map((s) => [
    ...COLS.map((c) => (c === 'capped' || c === 'openBusy' || c === 'emaInWay' ? (s[c] ? 1 : 0) : c === 'with' ? s.with.join(',') : s[c])),
    s.out ? [...OUT.flatMap((k) => [s.out![k].hit ? 1 : 0, s.out![k].r, s.out![k].net, s.out![k].min]), s.out.mfe, s.out.mae, s.out.costR, s.out.filled === undefined ? -1 : s.out.filled ? 1 : 0] : null,
  ]);
  return { v: 1, cols, rows };
}

export function unpack(p: Packed): Signal[] {
  const idx = (c: string) => p.cols.indexOf(c);
  const I = Object.fromEntries([...COLS, 'out'].map((c) => [c, idx(c)])) as Record<string, number>;
  return p.rows.map((r) => {
    const o = r[I.out] as number[] | null;
    const s = {
      case: r[I.case], symbol: r[I.symbol], date: r[I.date], slot: r[I.slot], dir: r[I.dir], entry: r[I.entry], stop: r[I.stop], target: r[I.target],
      stopAtr: r[I.stopAtr], atr: r[I.atr], capped: r[I.capped] === 1, time: r[I.time], nFirst5: r[I.nFirst5], nDay: r[I.nDay], nRecent: r[I.nRecent],
      rvol: r[I.rvol], openBusy: r[I.openBusy] === 1, stretch: r[I.stretch], emaInWay: r[I.emaInWay] === 1, gapPct: r[I.gapPct],
      with: String(r[I.with] ?? '').split(',').filter(Boolean),
    } as Signal;
    if (o) {
      const t = (i: number) => ({ hit: o[i] === 1, r: o[i + 1], net: o[i + 2], min: o[i + 3] });
      s.out = { T1: t(0), T15: t(4), TS: t(8), mfe: o[12], mae: o[13], costR: o[14], ...(o[15] === -1 ? {} : { filled: o[15] === 1 }) };
    }
    return s;
  });
}
