import type { DhanClient } from '../dhan';
import { ML_FEATURES } from '../ml/grid';
import { getJson, putJson, type Store } from '../setups/store';
import { activeOf } from './active';
import { istNow, scoreAt, slotTime, type DayState, type OrderRec } from './engine';
import { addRanks, modelKey, MODELS_PREFIX, predictVector, vectorOf, type LiveModel, type Version } from './model';

/**
 * Why Algo Live took a trade, for the journal's review (read only: nothing here places, changes or cancels anything).
 *
 * The score side is already saved at every close: the stock's score, the bar, where it stood on the list. The facts are
 * not saved, so they are worked out again by the engine's own scoreAt (one Dhan request per stock on the list), which
 * also proves it: the score must come out as it did live.
 *
 * A boosted-tree model has no reasons of its own, so the reasons are measured: swap one fact for the value other stocks
 * on the list had at that close, score again, and the change is how much that fact pushed this stock above the others.
 */

/** the rebuild needs a Dhan request per stock, so it never runs while Algo Live may need those requests itself */
export const LIVE_UNTIL_MIN = 11 * 60 + 5;
const SCAN_LIMIT_MS = 45_000;
const BACKGROUND = 40, TINY_PUSH = 0.002, SAME_SCORE = 0.005;
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const LABELS = new Map<string, string>(ML_FEATURES.map(([k, l]) => [k, l]));
const baseOf = (f: string) => f.replace(/_rk$/, '');

export interface FactPush {
  fact: string; label: string; value: number | null; listMedian: number | null;
  /** share of the list this stock's value was above (0-100) */
  aboveListPct: number | null;
  /** how much this fact moved the score against the other stocks on the list, in R */
  pushR: number;
}
export interface WhyFacts { score: number; matchesLive: boolean; stocksCompared: number; toward: FactPush[]; against: FactPush[] }
export interface WhyPicked {
  close: string; scoreR: number; barR: number | null; scoreAboveBarR: number | null;
  rankAtClose: string | null; othersAboveBar: { symbol: string; scoreR: number }[];
  scoreEarlier: { time: string; scoreR: number; aboveBar: boolean }[];
  tradeOfDay: number; vetoedToday: string[];
  model?: { iteration: number | null; month: string; learnedFrom: [string, string]; barTestedOn: [string, string]; barTestTrades: number; barTestAvgR: number | null; leansOnMost: string[]; readsNifty: boolean };
  facts?: WhyFacts;
}

/** what one fact (and its rank against the list) adds to this stock's score, against up to BACKGROUND other stocks */
export function factPushes(model: LiveModel, row: Record<string, number>, others: Record<string, number>[]): FactPush[] {
  if (!others.length) return [];
  const step = Math.max(1, others.length / BACKGROUND);
  const sample: Float32Array[] = [];
  for (let i = 0; i < others.length && sample.length < BACKGROUND; i += step) sample.push(vectorOf(model, others[Math.floor(i)]));
  const x = vectorOf(model, row), score = predictVector(model, x);
  const groups = new Map<string, number[]>();
  model.features.forEach((f, i) => { const b = baseOf(f); groups.set(b, [...(groups.get(b) ?? []), i]); });
  const out: FactPush[] = [];
  for (const [fact, idx] of groups) {
    const keep = idx.map((i) => x[i]);
    let sum = 0;
    for (const b of sample) { for (const i of idx) x[i] = b[i]; sum += predictVector(model, x); }
    idx.forEach((i, j) => { x[i] = keep[j]; });
    const vals = others.map((o) => o[fact]).filter(Number.isFinite).sort((a, b) => a - b), v = row[fact];
    out.push({
      fact, label: model.factLabels?.[fact] ?? LABELS.get(fact) ?? fact,
      value: Number.isFinite(v) ? round(v, 3) : null,
      listMedian: vals.length ? round(vals[Math.floor(vals.length / 2)], 3) : null,
      aboveListPct: Number.isFinite(v) && vals.length ? Math.round((vals.filter((y) => y < v).length / vals.length) * 100) : null,
      pushR: round(score - sum / sample.length, 3),
    });
  }
  return out;
}

export function splitPushes(all: FactPush[]): { toward: FactPush[]; against: FactPush[] } {
  const sorted = [...all].sort((a, b) => b.pushR - a.pushR);
  return { toward: sorted.filter((p) => p.pushR > TINY_PUSH).slice(0, 6), against: sorted.filter((p) => p.pushR < -TINY_PUSH).reverse().slice(0, 3) };
}

/** what the saved closes say: the score, the bar, the list, and how the score got there */
export function scoreSide(state: DayState, o: OrderRec): WhyPicked {
  const bar = state.model?.threshold ?? null, tick = state.ticks[String(o.slot)];
  const known = tick?.scored.filter((x) => x.pred !== null) ?? [];
  const place = known.findIndex((x) => x.symbol === o.symbol);
  const earlier = Object.values(state.ticks).filter((t) => t.slot <= o.slot).sort((a, b) => a.slot - b.slot)
    .flatMap((t) => { const x = t.scored.find((y) => y.symbol === o.symbol); return x && x.pred !== null ? [{ time: slotTime(t.slot), scoreR: x.pred, aboveBar: x.above }] : []; });
  return {
    close: slotTime(o.slot), scoreR: o.pred, barR: bar, scoreAboveBarR: bar === null ? null : round(o.pred - bar, 4),
    rankAtClose: place >= 0 ? `${place + 1} of ${known.length}` : null,
    othersAboveBar: known.filter((x) => x.above && x.symbol !== o.symbol).slice(0, 4).map((x) => ({ symbol: x.symbol, scoreR: x.pred! })),
    scoreEarlier: earlier,
    tradeOfDay: state.orders.filter((x) => x.sentAt <= o.sentAt).length,
    vetoedToday: state.vetoes,
  };
}

export interface WhyDeps {
  store: Store;
  dhan?: Pick<DhanClient, 'intraday'>;
  /** every key under a prefix (S3 listing); without it only the current model can be used */
  listKeys?: (prefix: string) => Promise<string[]>;
  now?: () => number;
}

/** the model that traded that day (narrow or wide, as the day's list was made for): the saved model when it is that one,
 * otherwise the kept copy for that month */
export async function modelFor(d: WhyDeps, date: string, createdAt?: number, version: Version = 'narrow'): Promise<LiveModel | undefined> {
  const month = date.slice(0, 7);
  const current = await getJson<LiveModel>(d.store, modelKey(version));
  if (current?.month === month && (createdAt === undefined || current.createdAt === createdAt)) return current;
  const keys = (await d.listKeys?.(MODELS_PREFIX[version]).catch(() => [])) ?? [];
  const mine = keys.filter((k) => k.includes(`/${month}-`)).sort((a, b) => Number(b.match(/-(\d+)\.json\.gz$/)?.[1] ?? 0) - Number(a.match(/-(\d+)\.json\.gz$/)?.[1] ?? 0));
  let newest: LiveModel | undefined;
  for (const k of mine) {
    const m = await getJson<LiveModel>(d.store, k).catch(() => undefined);
    if (!m) continue;
    newest ??= m;
    if (createdAt === undefined || m.createdAt === createdAt) return m;
  }
  return newest ?? (current?.month === month ? current : undefined);
}

const whyKey = (date: string, o: OrderRec) => `setups/live/${date}/why/${o.symbol.replace(/[^A-Za-z0-9&_-]/g, '_')}-${o.slot}.json.gz`;

async function rebuildFacts(d: WhyDeps, model: LiveModel, state: DayState, o: OrderRec): Promise<WhyFacts | string> {
  const scan = scoreAt(d.dhan as DhanClient, d.store, model, state.date, state.list, o.slot);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<'late'>((res) => { timer = setTimeout(() => res('late'), SCAN_LIMIT_MS); });
  const res = await Promise.race([scan, limit]).finally(() => clearTimeout(timer));
  if (res === 'late') return 'the list took too long to fetch';
  if (!res.facts.has(o.symbol)) return 'its facts could not be worked out again';
  const syms = [...res.facts.keys()], rows = syms.map((s) => ({ ...res.facts.get(s)! }));
  addRanks(rows, model.ranked);
  const me = syms.indexOf(o.symbol), others = rows.filter((_, i) => i !== me);
  const score = predictVector(model, vectorOf(model, rows[me]));
  return { score: round(score, 4), matchesLive: Math.abs(score - o.pred) <= SAME_SCORE, stocksCompared: others.length, ...splitPushes(factPushes(model, rows[me], others)) };
}

/** everything known about why this order was picked; a missing part comes back as a plain-words note */
export async function whyPicked(d: WhyDeps, state: DayState, o: OrderRec): Promise<{ why: WhyPicked; notes: string[] }> {
  const why = scoreSide(state, o), notes: string[] = [];
  const model = await modelFor(d, state.date, state.model?.createdAt, state.version ?? state.model?.version ?? 'narrow').catch(() => undefined);
  if (!model) { notes.push(`The model for ${state.date.slice(0, 7)} could not be read, so only the score is explained.`); return { why, notes }; }
  const a = activeOf(model);
  why.model = {
    iteration: a.iteration, month: model.month, learnedFrom: model.train, barTestedOn: model.val, barTestTrades: model.valTrades, barTestAvgR: model.valR,
    leansOnMost: (model.facts ?? []).slice(0, 6).map((f) => f.label),
    readsNifty: model.features.some((f) => /^n(First5|Day|Recent30|Recent10|PosInRange)$/.test(f)),
  };
  const cached = await getJson<WhyFacts>(d.store, whyKey(state.date, o)).catch(() => undefined);
  if (cached) { why.facts = cached; return { why, notes }; }
  const now = istNow(d.now?.() ?? Date.now());
  if (now.date === state.date && now.min < LIVE_UNTIL_MIN) { notes.push('Facts behind the score skipped while Algo Live may be trading: press Review again after 11:05.'); return { why, notes }; }
  if (!d.dhan) { notes.push('Facts behind the score need the Dhan login.'); return { why, notes }; }
  try {
    const facts = await rebuildFacts(d, model, state, o);
    if (typeof facts === 'string') { notes.push(`Facts behind the score not available: ${facts}.`); return { why, notes }; }
    why.facts = facts;
    await putJson(d.store, whyKey(state.date, o), facts).catch(() => undefined);
  } catch (e) { notes.push(`Facts behind the score not available: ${(e as Error).message}.`); }
  return { why, notes };
}
