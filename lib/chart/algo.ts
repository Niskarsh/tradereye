import { slotTime, loadState, type DayState } from '../algoLive/engine';
import { addRanks, type LiveModel } from '../algoLive/model';
import { activeOf } from '../algoLive/active';
import { factPushes, modelFor, splitPushes, type FactPush, type WhyDeps } from '../algoLive/why';
import { getJson, putJson, type Store } from '../setups/store';

/**
 * Algo Live's view of one stock on one day, for the Charts page: where it stood at every 10-minute close, the levels
 * the model read there, and (where the close's facts were saved) which facts pushed its score up or down.
 *
 * The facts come from the tick itself: app/api/algo-live/tick saves every stock's facts after it has answered
 * (saveCloseFacts, run by Next's after()), so explaining a stock here costs no Dhan request and never touches the tick.
 * Days before that save existed only have the scores.
 */

export const factsKey = (date: string, slot: number) => `setups/live/${date}/facts/${slot}.json.gz`;
export interface CloseFacts { v: 1; date: string; slot: number; at: number; facts: Record<string, Record<string, number | null>> }

/** called after a tick has answered: never throws, never delays the tick */
export async function saveCloseFacts(store: Store, date: string, slot: number, facts: Map<string, Record<string, number>>): Promise<void> {
  try {
    const body: CloseFacts = { v: 1, date, slot, at: Date.now(), facts: Object.fromEntries(facts) };
    await putJson(store, factsKey(date, slot), body);
  } catch { /* the chart then shows scores only for this close */ }
}

export interface AlgoLevel { key: string; label: string; price: number }
export interface AlgoClose {
  slot: number; time: string; scoreR: number | null; above: boolean; rank: number | null; of: number; picked: boolean; note?: string;
  price?: number;
  /** the levels the model read at this close (from the saved facts) */
  levels?: AlgoLevel[];
  hasFacts: boolean;
}
export interface AlgoOrder { slot: number; time: string; side: 'short' | 'long'; qty: number; price: number; avgPrice?: number; stop: number; target: number; status: string; sentAt: number; scoreR: number }
export interface AlgoView {
  date: string; symbol: string; onList: boolean; listSize: number; vetoed: boolean;
  bar: number | null; standAside: boolean;
  model?: { iteration: number | null; month: string; version: string; leansOnMost: string[] };
  closes: AlgoClose[];
  orders: AlgoOrder[];
  /** the close the reasons are for */
  reasonsAt?: number;
  reasons?: { toward: FactPush[]; against: FactPush[]; stocksCompared: number };
  notes: string[];
}

const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * The prices behind the model's facts (each fact is a distance from the price in 10-min ATRs: level = price + x * ATR,
 * with ATR = atrPct% of the price), lib/ml/grid.ts.
 */
export function levelsFrom(f: Record<string, number | null>): AlgoLevel[] {
  const price = n(f.priceRs), atrPct = n(f.atrPct);
  if (!price || !atrPct) return [];
  const atr = (atrPct / 100) * price;
  const out: AlgoLevel[] = [];
  const add = (key: string, label: string, v: number | undefined) => { if (v !== undefined && v > 0) out.push({ key, label, price: Math.round(v * 100) / 100 }); };
  const at = (k: string) => { const x = n(f[k]); return x === undefined ? undefined : price + x * atr; };
  add('vwap', 'VWAP', n(f.distVwapAtr) === undefined ? undefined : price - (f.distVwapAtr as number) * atr);
  add('dayHi', 'Day high', n(f.distHiAtr) === undefined ? undefined : price + (f.distHiAtr as number) * atr);
  add('dayLo', 'Day low', n(f.distLoAtr) === undefined ? undefined : price - (f.distLoAtr as number) * atr);
  add('pdh', 'PDH', at('pdhAtr'));
  add('pdl', 'PDL', at('pdlAtr'));
  add('vah', 'Yday VA high', at('vaHiAtr'));
  add('val', 'Yday VA low', at('vaLoAtr'));
  add('poc', 'POC', at('pocAtr'));
  add('ema10', '200 EMA 10m', at('ema10Atr'));
  add('ema5', '200 EMA 5m', at('ema5Atr'));
  add('ema1d', '200 EMA 1D', at('ema1dAtr'));
  return out;
}

function closesOf(state: DayState, symbol: string): AlgoClose[] {
  return Object.values(state.ticks).sort((a, b) => a.slot - b.slot).flatMap((t) => {
    const known = t.scored.filter((x) => x.pred !== null);
    const i = known.findIndex((x) => x.symbol === symbol);
    const me = t.scored.find((x) => x.symbol === symbol);
    if (!me) return [];
    return [{
      slot: t.slot, time: slotTime(t.slot), scoreR: me.pred, above: me.above, rank: i >= 0 ? i + 1 : null, of: known.length,
      picked: t.picked.includes(symbol), note: me.note, price: me.price, hasFacts: false,
    }];
  });
}

export async function algoView(d: WhyDeps & { store: Store }, date: string, symbol: string, wantSlot?: number): Promise<AlgoView> {
  const state = await loadState(d.store, date);
  const notes: string[] = [];
  const onList = state.list.some((x) => x.symbol === symbol);
  const view: AlgoView = {
    date, symbol, onList, listSize: state.list.length, vetoed: state.vetoes.includes(symbol),
    bar: state.model?.threshold ?? null, standAside: !!state.model?.standAside, closes: closesOf(state, symbol),
    orders: state.orders.filter((o) => o.symbol === symbol).map((o) => ({
      slot: o.slot, time: slotTime(o.slot), side: o.target < o.price ? 'short' : 'long', qty: o.qty, price: o.price, avgPrice: o.avgPrice,
      stop: o.stop, target: o.target, status: o.status, sentAt: o.sentAt, scoreR: o.pred,
    })),
    notes,
  };
  if (!onList && !view.closes.length) return view;

  const version = state.version ?? state.model?.version ?? 'narrow';
  const model: LiveModel | undefined = await modelFor(d, date, state.model?.createdAt, version).catch(() => undefined);
  if (model) {
    const a = activeOf(model);
    view.model = { iteration: a.iteration, month: model.month, version, leansOnMost: (model.facts ?? []).slice(0, 6).map((f) => f.label) };
  }

  // the saved facts of each close (only closes after the save existed)
  const saved = new Map<number, CloseFacts>();
  await Promise.all(view.closes.map(async (c) => {
    const f = await getJson<CloseFacts>(d.store, factsKey(date, c.slot)).catch(() => undefined);
    if (f?.facts?.[symbol]) { saved.set(c.slot, f); c.hasFacts = true; c.levels = levelsFrom(f.facts[symbol]); }
  }));
  if (!saved.size && view.closes.length) notes.push('The facts behind the scores were not saved on this day (saving started with the Charts page), so only the scores are shown.');

  // reasons: the asked close, else the order's close, else the best close with facts
  const withFacts = view.closes.filter((c) => c.hasFacts);
  const pickSlot = wantSlot !== undefined && saved.has(wantSlot) ? wantSlot
    : view.orders.find((o) => saved.has(o.slot))?.slot
    ?? [...withFacts].sort((a, b) => (b.scoreR ?? -9) - (a.scoreR ?? -9))[0]?.slot;
  if (model && pickSlot !== undefined) {
    const f = saved.get(pickSlot)!;
    const syms = Object.keys(f.facts);
    const rows = syms.map((s) => ({ ...f.facts[s] }) as Record<string, number>);
    addRanks(rows, model.ranked);
    const me = syms.indexOf(symbol);
    const others = rows.filter((_, i) => i !== me);
    const pushes = splitPushes(factPushes(model, rows[me], others));
    view.reasonsAt = pickSlot;
    view.reasons = { ...pushes, stocksCompared: others.length };
  } else if (!model && withFacts.length) notes.push(`The model for ${date.slice(0, 7)} could not be read, so the reasons are not available.`);
  return view;
}

