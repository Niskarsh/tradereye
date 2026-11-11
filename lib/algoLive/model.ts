/**
 * Algo Live: the model trained by scripts/ml_live.py (gradient-boosted trees, 5 averaged), scored here exactly as
 * scikit-learn scores it: at each node a missing fact (NaN) follows `missingLeft`, else fact <= threshold goes left.
 */

export interface Tree { value: number[]; feature: number[]; threshold: number[]; missingLeft: number[]; left: number[]; right: number[]; leaf: number[] }
export interface LiveModel {
  v: 1; strategy: string; month: string;
  /** the Algo Lab iteration that picked `strategy` (from Nov 2026; see activeOf) */
  iteration?: number; strategyName?: string; createdAt: number; code?: string | null; runId?: string; dataTo?: string;
  train: [string, string]; val: [string, string];
  /** the facts each model reads, in order (stock facts and their cross-sectional ranks, `<fact>_rk`) */
  features: string[];
  /** the facts ranked across the stocks at the same minute (pandas rank(pct=True)) */
  ranked: string[];
  threshold: number | null; standAside: boolean; valTrades: number; valR: number | null; valDays: number;
  /** (from Nov 2026) the facts this month's models lean on most: share of the trees' split gain */
  facts?: { f: string; label: string; share: number }[];
  /** every fact's share of the split gain ({fact: share}, tiny ones left out) and every fact's plain name */
  shares?: Record<string, number> | null; factLabels?: Record<string, string>;
  rules: {
    firstSlot: number; lastSlot: number; cap: number; stopAdr: number; targetAdr: number; exitSlot: number; riskInr: number;
    /** (wide model) stocks trading less than this many rupees a day are scored and ranked but never traded */
    minTurnoverRs?: number; refPrice?: number;
    /** (wide model) the position size the bar was chosen at (₹10 lakh); live it trades the page's own position size */
    positionInr?: number;
  };
  /** (from Dec 2026) which day list the model learned on: 'narrow' (₹250-340, iteration 10) or 'wide' (₹250-1000, iteration 15) */
  universe?: 'narrow' | 'wide';
  /** (wide model) the market gate: its rule, the market's 20-day move per day to the data's end, and which of those were hot */
  gate?: { days: number; min: number; q: number; history: [string, number | null][]; hot: string[] };
  models: { baseline: number; trees: Tree[] }[];
  parity?: { rows: (number | null)[][]; pred: number[]; days: string[]; syms: string[]; slots: number[]; worst: number };
}

export const MODEL_KEY = 'setups/live/model.json.gz';
/** the wide model (scripts/ml_live_wide.py, workflow "Algo Live model (wide)"), traded only when the page is switched to it */
export const WIDE_MODEL_KEY = 'setups/live/model-wide.json.gz';
/** where every month's models are kept, per version */
export const MODELS_PREFIX = { narrow: 'setups/live/models/', wide: 'setups/live/models-wide/' } as const;
export type Version = keyof typeof MODELS_PREFIX;
export const modelKey = (v: Version) => (v === 'wide' ? WIDE_MODEL_KEY : MODEL_KEY);
export const versionOf = (m: Pick<LiveModel, 'universe'>): Version => (m.universe === 'wide' ? 'wide' : 'narrow');

function walk(t: Tree, x: ArrayLike<number>): number {
  let i = 0;
  while (!t.leaf[i]) {
    const v = x[t.feature[i]];
    i = Number.isNaN(v) ? (t.missingLeft[i] ? t.left[i] : t.right[i]) : v <= t.threshold[i] ? t.left[i] : t.right[i];
  }
  return t.value[i];
}

/** the ensemble's prediction (R after costs) for one vector of facts in `model.features` order */
export function predictVector(model: LiveModel, x: ArrayLike<number>): number {
  let sum = 0;
  for (const m of model.models) {
    let s = m.baseline;
    for (const t of m.trees) s += walk(t, x);
    sum += s;
  }
  return sum / model.models.length;
}

/** facts by name (missing or non-finite = NaN), as float32 like the training data */
export function vectorOf(model: LiveModel, facts: Record<string, number>): Float32Array {
  const x = new Float32Array(model.features.length);
  model.features.forEach((f, i) => { const v = facts[f]; x[i] = typeof v === 'number' && Number.isFinite(v) ? v : NaN; });
  return x;
}

/**
 * pandas `rank(pct=True)` within one minute: average rank of ties, divided by the number of non-missing values;
 * missing stays missing.
 */
export function rankPct(values: number[]): number[] {
  const idx = values.map((v, i) => [v, i] as const).filter(([v]) => Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
  const out = values.map(() => NaN);
  const n = idx.length;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j + 2) / 2 / n; // ranks i+1..j+1 averaged
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

/** adds `<fact>_rk` to every stock's facts (each a stock at the same minute) */
export function addRanks(rows: Record<string, number>[], ranked: string[]): void {
  for (const f of ranked) {
    const r = rankPct(rows.map((x) => (typeof x[f] === 'number' ? Math.fround(x[f]) : NaN)));
    rows.forEach((x, i) => { x[`${f}_rk`] = r[i]; });
  }
}
