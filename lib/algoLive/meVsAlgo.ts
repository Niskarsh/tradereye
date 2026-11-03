import type { Candles } from '../dhan';
import type { SheetsClient } from '../sheetsApi';
import { NeedsDhanError, type LoadDeps, loadDayMinutes } from '../candles/store';
import { roundTripCharges } from '../setups/costs';
import type { Store } from '../setups/store';
import { TICK } from '../study/mine';
import type { OrderRec } from './engine';
import { journalOf, liveOrders, type JournalTrade } from './fills';

/**
 * Me vs Algo (read only): for every Algo Live order, what the algo proposed, what he did, and what the untouched
 * bracket would have done. Built from data already kept: the order (entry, stop, target, qty), the journal (his exit,
 * net P&L) and the day's 1-minute candles. The untouched result uses the backtest's fill rules: same minute = stop,
 * stop fills 1 tick worse, target must trade through by a tick, out at 15:15. Everything is after charges.
 */

const IST = 19800;
const END_MIN = 15 * 60 + 15;
const minOf = (sec: number) => { const d = new Date((sec + IST) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
/** a target traded through by no more than this may not have filled a resting limit order (iteration 11's thin-stock figure) */
export const FILL_DOUBT_TICKS = 3;
const toMin = (t?: string) => { if (!t) return undefined; const [h, m] = t.split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : undefined; };

export type PlanOutcome = 'TARGET' | 'STOP' | '15:15' | 'OPEN';
export interface MeVsAlgoRow {
  date: string; symbol: string; time: string; qty: number; entry: number; stop: number; target: number;
  planOutcome: PlanOutcome | null; planExit: number | null; planTime: string | null; planInr: number | null; planR: number | null;
  myExit: number | null; myTime: string | null; myHow: string; myInr: number | null; myR: number | null; lastStop: number | null;
  /** how far toward the target it got before he was out (100 = at the target), and when */
  peakPct: number | null; peakTime: string | null;
  /** on an untouched TARGET: how far price went past the target before any stop (ticks), whether that is too little to trust,
   * and what the trade would have done had the limit order not filled */
  throughTicks: number | null; fillDoubt: boolean; ifNoFill: { outcome: PlanOutcome; time: string; inr: number | null } | null;
  steppedIn: boolean | null; diffInr: number | null; note?: string;
}
export interface MeVsAlgoTotals { closed: number; steppedIn: number; helped: number; hurt: number; myInr: number; planInr: number; diffInr: number; left: number; unclear: number }

/** the bracket left alone, from the order's own entry */
export function untouched(o: OrderRec, entry: number, c: Candles, sessionOver: boolean, noTarget = false): { outcome: PlanOutcome; exit: number; minute: number } | null {
  const from = minOf(Math.floor(o.sentAt / 1000));
  let last: { exit: number; minute: number } | null = null;
  for (let i = 0; i < c.t.length; i++) {
    const m = minOf(c.t[i]);
    if (m < from) continue;
    if (m >= END_MIN) break;
    if (c.h[i] >= o.stop) return { outcome: 'STOP', exit: o.stop + TICK, minute: m };
    if (!noTarget && c.l[i] <= o.target - TICK) return { outcome: 'TARGET', exit: o.target, minute: m };
    last = { exit: c.c[i], minute: m };
  }
  if (!last) return null;
  return sessionOver ? { outcome: '15:15', exit: last.exit + TICK, minute: last.minute + 1 } : { outcome: 'OPEN', exit: last.exit, minute: last.minute };
}

export function judge(date: string, o: OrderRec, j: JournalTrade | undefined, c: Candles | undefined, sessionOver: boolean): MeVsAlgoRow | undefined {
  const entry = o.avgPrice || j?.avgEntry;
  if (!entry) return undefined; // never filled
  const risk = o.qty * (o.stop - entry);
  const inr = (exit: number) => o.qty * (entry - exit) - roundTripCharges(o.qty, entry, exit, -1);
  const rOf = (x: number) => (risk > 0 ? round(x / risk) : null);
  const plan = c ? untouched(o, entry, c, sessionOver) : null;
  const planInr = plan && plan.outcome !== 'OPEN' ? round(inr(plan.exit), 0) : null;
  // a target only just traded through: how far past it, and what if the limit order never filled
  let throughTicks: number | null = null, ifNoFill: MeVsAlgoRow['ifNoFill'] = null;
  if (c && plan?.outcome === 'TARGET') {
    const miss = untouched(o, entry, c, sessionOver, true);
    const end = miss?.outcome === 'STOP' ? miss.minute : END_MIN;
    let low = Infinity;
    for (let i = 0; i < c.t.length; i++) { const m = minOf(c.t[i]); if (m >= plan.minute && m < end && c.l[i] < low) low = c.l[i]; }
    if (low < Infinity) throughTicks = round((o.target - low) / TICK, 0);
    if (miss) ifNoFill = { outcome: miss.outcome, time: hhmm(miss.minute), inr: miss.outcome === 'OPEN' ? null : round(inr(miss.exit), 0) };
  }
  const fillDoubt = throughTicks !== null && throughTicks <= FILL_DOUBT_TICKS;
  const myExit = j?.avgExit ?? null, myMin = toMin(j?.exitTime);
  const myInr = j && myExit !== null ? round(j.netPnl ?? inr(myExit), 0) : null;
  // how far it got while he was in
  let peak: number | null = null, peakMin: number | null = null;
  if (c && entry > o.target) {
    const from = minOf(Math.floor(o.sentAt / 1000)), to = myMin ?? plan?.minute ?? END_MIN;
    let low = Infinity;
    for (let i = 0; i < c.t.length; i++) { const m = minOf(c.t[i]); if (m >= from && m <= to && c.l[i] < low) { low = c.l[i]; peakMin = m; } }
    if (low < Infinity) peak = Math.max(0, round(((entry - low) / (entry - o.target)) * 100, 0));
  }
  const stepped = plan && plan.outcome !== 'OPEN' && myExit !== null
    ? (myMin !== undefined && myMin < plan.minute - 1) || Math.abs(myExit - plan.exit) > 2 * TICK : null;
  return {
    date, symbol: o.symbol, time: hhmm(minOf(Math.floor(o.sentAt / 1000))), qty: o.qty, entry, stop: o.stop, target: o.target,
    planOutcome: plan?.outcome ?? null, planExit: plan ? round(plan.exit) : null, planTime: plan ? hhmm(plan.minute) : null, planInr, planR: planInr === null ? null : rOf(planInr),
    myExit, myTime: myMin !== undefined ? hhmm(myMin) : null, myHow: j ? j.exitType : 'not in journal yet', myInr, myR: myInr === null ? null : rOf(myInr), lastStop: j?.lastStop ?? null,
    peakPct: peak, peakTime: peakMin === null ? null : hhmm(peakMin), throughTicks, fillDoubt, ifNoFill, steppedIn: stepped, diffInr: myInr !== null && planInr !== null ? myInr - planInr : null,
  };
}

export function totalsOf(rows: MeVsAlgoRow[]): MeVsAlgoTotals {
  const closed = rows.filter((r) => r.diffInr !== null), inn = closed.filter((r) => r.steppedIn), sure = inn.filter((r) => !r.fillDoubt);
  return {
    closed: closed.length, steppedIn: inn.length, helped: sure.filter((r) => r.diffInr! > 0).length, hurt: sure.filter((r) => r.diffInr! < 0).length, unclear: inn.length - sure.length, left: closed.length - inn.length,
    myInr: closed.reduce((s, r) => s + r.myInr!, 0), planInr: closed.reduce((s, r) => s + r.planInr!, 0), diffInr: closed.reduce((s, r) => s + r.diffInr!, 0),
  };
}

export async function meVsAlgo(store: Store, sheets: SheetsClient, today: string, candles: LoadDeps, sessionOver: (date: string) => boolean): Promise<{ rows: MeVsAlgoRow[]; totals: MeVsAlgoTotals }> {
  const { orders, journal } = await liveOrders(store, sheets, today);
  const rows: MeVsAlgoRow[] = [];
  for (const { d, o } of orders) { // one at a time: Dhan allows 5 data requests a second
    let c: Candles | undefined, note: string | undefined;
    try { c = await loadDayMinutes(candles, { symbol: o.symbol, date: d, securityId: o.securityId }); }
    catch (e) { note = e instanceof NeedsDhanError ? 'Candles not saved yet: log in on the Dhan login tab' : `Candles failed: ${(e as Error).message}`; }
    const r = judge(d, o, journalOf(d, o, journal), c, sessionOver(d));
    if (r) rows.push(note ? { ...r, note } : r);
  }
  return { rows: rows.reverse(), totals: totalsOf(rows) };
}
