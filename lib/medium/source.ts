import { getChunk, putChunk } from '../book/s3';
import { loadTradeCandles } from '../candles/store';
import { lookupSecurityId } from '../dhan';
import { LIVE_FROM } from '../algoLive/fills';
import { getJson, INDEX_KEY, ML_LEDGER_KEY, mlKey, type RunIndexItem } from '../setups/store';
import { ledgerEntry, type LedgerEntry, type MlResult } from '../ml/ledger';
import { EARLY_NOTES, type EarlyNote } from './early';
import { algoOrders, journalTradesBetween, season, weekdays } from '../shorts/source';
import { dayCandles } from '../shorts/spec';
import { istToday, splitMeAlgo, weekOf, type ShortTrade } from '../shorts/trades';
import { freezeThrough, loadLedger, mergedWeeks, saveLedger } from '../shorts/season';
import type { Format, Material } from './article';
import { buildingMaterial, dayLabel, monthLabel, recapOf, tradesMaterial, vsMaterial } from './material';

/** Loads one format's real data for a period and turns it into Material (lib/medium/material.ts decides what goes in). */

const store = { get: getChunk, put: putChunk };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const prevMonth = (m: string) => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

/** The saved 1-minute candles of the trades that get a chart (saved days only: no Dhan call from here). */
async function minutes(ts: ShortTrade[]) {
  const out = new Map<string, { t: number[]; o: number[]; h: number[]; l: number[]; c: number[] }>();
  await Promise.all(ts.map(async (t) => {
    try {
      const r = await loadTradeCandles({ store, lookupSecurityId: (s) => lookupSecurityId(s) }, { symbol: t.symbol, date: t.date, securityId: t.securityId, parts: ['minute'] });
      const day = dayCandles(r.minute, t.date);
      if (day.t.length) out.set(t.id, day);
    } catch { /* no chart for this one */ }
  }));
  return out;
}

/** Defaults for the picker: the last finished week, last month, the finished Me vs Algo weeks, the iterations. */
export async function periods(now = Date.now()) {
  const today = istToday(now);
  const thisWeek = weekOf(today);
  const lastWeek = today >= addDays(thisWeek, 5) ? thisWeek : addDays(thisWeek, -7);
  const [s, its] = await Promise.all([season(now).catch(() => ({ weeks: [] })), iterations().catch(() => new Map<number, LedgerEntry | EarlyNote>())]);
  return {
    week: lastWeek, month: prevMonth(today.slice(0, 7)), thisMonth: today.slice(0, 7),
    vsWeeks: s.weeks.map((w) => w.week), liveFrom: LIVE_FROM,
    iterations: [...its.keys()].sort((a, b) => a - b),
  };
}

export interface PeriodInput { week?: string; month?: string; fromIteration?: number; toIteration?: number }

export async function loadMaterial(format: Format, p: PeriodInput, now = Date.now()): Promise<Material> {
  if (format === 'weekly') {
    const week = weekOf(p.week ?? '');
    const end = addDays(week, 4);
    const all = await journalTradesBetween(week.slice(0, 7), end.slice(0, 7));
    const trades = all.filter((t) => t.date >= week && t.date <= end);
    if (!trades.length) throw new Error(`No closed trades in the journal for the week of ${dayLabel(week)}.`);
    return tradesMaterial('weekly', { from: week, to: end, label: `${dayLabel(week)} – ${dayLabel(end)}` }, trades, undefined, await minutes(pick(trades)), now);
  }
  if (format === 'monthly') {
    const month = p.month ?? '';
    const prev = prevMonth(month);
    const all = await journalTradesBetween(prev, month);
    const trades = all.filter((t) => t.date.startsWith(month)), before = all.filter((t) => t.date.startsWith(prev));
    if (!trades.length) throw new Error(`No closed trades in the journal for ${monthLabel(month)}.`);
    return tradesMaterial('monthly', { from: `${month}-01`, to: `${month}-31`, label: monthLabel(month) }, trades, before, await minutes(pick(trades)), now);
  }
  if (format === 'vs-algo') {
    const week = weekOf(p.week ?? '');
    const s = await season(now);
    if (!s.weeks.some((w) => w.week === week)) throw new Error('That week is not a finished Me vs Algo week (Mon–Fri, since Algo Live started).');
    // the score shown publicly comes only from frozen weeks, exactly like the shorts: this week (and earlier) freeze now
    const frozen = freezeThrough(await loadLedger(), s.weeks, week);
    if (frozen.changed) await saveLedger(frozen.ledger);
    const weeks = mergedWeeks(frozen.ledger, s.weeks).filter((w) => w.week <= week);
    const fw = weeks.find((w) => w.week === week)!;
    const seasonScore = { me: weeks.filter((w) => w.winner === 'me').length, algo: weeks.filter((w) => w.winner === 'algo').length };
    const end = addDays(week, 4);
    const [trades, orders] = await Promise.all([journalTradesBetween(week.slice(0, 7), end.slice(0, 7)), algoOrders(weekdays(week, end).filter((d) => d >= LIVE_FROM))]);
    const { me, algo } = splitMeAlgo(trades.filter((t) => t.date >= week && t.date <= end), orders);
    return vsMaterial({ from: week, to: end, label: `${dayLabel(week)} – ${dayLabel(end)}` }, fw, seasonScore, weeks, me, algo, await minutes([...pick(me), ...pick(algo)]), now);
  }
  const all = await iterations();
  const from = p.fromIteration ?? 1, to = p.toIteration ?? from;
  const lo = Math.min(from, to), hi = Math.max(from, to);
  const picked = [...all.values()].filter((e) => e.iteration >= lo && e.iteration <= hi);
  if (!picked.length) throw new Error('No Algo Lab iterations in that range.');
  const entries = picked.filter((e): e is LedgerEntry => !('facts' in e)), notes = picked.filter((e): e is EarlyNote => 'facts' in e);
  // one iteration = one part of the series: the parts before it are recapped in a line each
  const earlier = [...all.values()].filter((e) => e.iteration < lo).sort((a, b) => a.iteration - b.iteration).map(recapOf);
  return buildingMaterial({ from: String(lo), to: String(hi), label: lo === hi ? `Iteration ${lo}` : `Iterations ${lo}–${hi}` }, entries, notes, earlier);
}

type AnyMl = MlResult & { overall?: { n: number; netR: number; t: number; monthsGreen?: number; monthsTraded?: number } };

/**
 * Every Algo Lab iteration that can be written about: the kept ledger (5 on), then any older run whose results are
 * still in the run index, then the notes for 1-4 (lib/medium/early.ts) for whatever is still missing.
 */
export async function iterations(): Promise<Map<number, LedgerEntry | EarlyNote>> {
  const [ledger, runs] = await Promise.all([getJson<LedgerEntry[]>(store, ML_LEDGER_KEY).catch(() => undefined), getJson<RunIndexItem[]>(store, INDEX_KEY).catch(() => undefined)]);
  const out = new Map<number, LedgerEntry | EarlyNote>();
  for (const e of ledger ?? []) out.set(e.iteration, e);
  const kept = new Set((ledger ?? []).map((e) => e.runId));
  const older = (runs ?? []).filter((r) => !kept.has(r.runId)).slice(0, 40);
  const mls = await Promise.all(older.map((r) => getJson<AnyMl>(store, mlKey(r.runId)).catch(() => undefined)));
  for (const ml of mls) {
    if (!ml) continue;
    let e: LedgerEntry;
    if (ml.v === 1 && ml.overall) {
      const o = ml.overall;
      e = { iteration: 1, runId: ml.runId, createdAt: ml.createdAt, code: null, best: 'tight', changes: [], lines: [{ id: 'tight', name: 'tight', n: o.n, netR: o.netR, gross: null, t: o.t, monthsGreen: o.monthsGreen ?? 0, monthsTraded: o.monthsTraded ?? 0, dev: null, exam: null, ic: null }] };
    } else e = ledgerEntry({ ...ml, iteration: ml.iteration ?? 2 });
    const have = out.get(e.iteration);
    if (!have || (!('facts' in have) && !kept.has(have.runId) && have.createdAt < e.createdAt)) out.set(e.iteration, e); // newest run of that iteration
  }
  for (const n of EARLY_NOTES) {
    const have = out.get(n.iteration);
    if (!have) out.set(n.iteration, n);
    // a run's own results win, but its "what changed" lines are technical: the notes' plain-words lines are offered too
    else if (!('facts' in have)) out.set(n.iteration, { ...have, changes: [...have.changes, ...n.changes.filter((c) => !have.changes.includes(c))] });
  }
  return out;
}

/** Only the trades that may get a chart: the biggest by R / ₹ either way (keeps the candle reads few). */
function pick(ts: ShortTrade[]): ShortTrade[] {
  const v = (t: ShortTrade) => t.netR ?? t.net;
  const sorted = [...ts].sort((a, b) => v(b) - v(a));
  const byAbs = [...ts].sort((a, b) => Math.abs(v(b)) - Math.abs(v(a)));
  return [...new Map([sorted[0], sorted[sorted.length - 1], byAbs[0], byAbs[1]].filter(Boolean).map((t) => [t.id, t])).values()];
}
