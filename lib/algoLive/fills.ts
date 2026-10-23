import type { SheetsClient } from '../sheetsApi';
import type { Store } from '../setups/store';
import { TICK } from '../study/mine';
import { MONTHS, monthSheetTitle, normDate, normTime } from '../live/time';
import { loadState, type OrderRec } from './engine';

/**
 * Live fills vs the backtest (read only: nothing here places, changes or cancels anything).
 *
 * Every Algo Live order already keeps the 10-min close it was signalled on, its stop and target, and Dhan's average
 * entry price; the journal already keeps every trade's average exit and how it ended (STOP / TARGET / MANUAL). This
 * puts the two side by side and measures what the backtest assumed:
 *   - entry: the backtest fills a short 1 tick below the close (iteration 11's estimate for thin stocks: 3 ticks);
 *   - stop exit: the backtest fills 1 tick above the stop (estimate for thin stocks: 0.20% of price);
 *   - target exit: a resting limit, filled at the target (never worse).
 * Trades closed by hand only count for the entry: they say nothing about how a stop fills.
 */

/** the first day Algo Live placed orders */
export const LIVE_FROM = '2026-10-23';
const MAX_DAYS = 200;

export interface FillRow {
  date: string; symbol: string; time: string; avgVol?: number;
  signal: number; entry: number; stop: number; target: number; exit: number | null; exitType: string;
  /** ticks worse than the 10-min close (+ = worse for the short) */
  entryTicks: number;
  /** ticks worse than the stop price, on trades that hit their stop (+ = worse) */
  stopTicks: number | null; stopPct: number | null;
  /** ticks worse than the target, on trades that hit it (0 = at the target) */
  targetTicks: number | null;
  /** R lost against the backtest's own fills (1 tick in, 1 tick out on a stop) */
  extraR: number;
  matched: boolean;
}
export interface FillSummary {
  trades: number; matched: number; entryTicks: number | null; stopsHit: number; stopTicks: number | null; stopPct: number | null;
  targetsHit: number; targetTicks: number | null; manual: number; extraR: number | null;
}

/** header row + cells -> object (the same as sheetsApi's rowToObject, without loading the Google client) */
const rowToObject = (headers: string[], cells: string[]) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])) as Record<string, string>;
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const num = (v: unknown) => { const x = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) && x > 0 ? x : undefined; };

export interface JournalTrade { date: string; symbol: string; entryTime: string; avgEntry?: number; avgExit?: number; exitType: string; lastStop?: number; short: boolean }

/** one line per trade group of a monthly tab (group values repeat on every fill row: the first row is enough) */
export function journalTrades(headers: string[], rows: { cells: string[] }[]): JournalTrade[] {
  const seen = new Set<string>(), out: JournalTrade[] = [];
  for (const r of rows) {
    const o = rowToObject(headers, r.cells);
    const id = (o.TradeGroupId ?? '').trim();
    if (!id || seen.has(id) || !o.Symbol) continue;
    seen.add(id);
    const dir = `${o.DirFromFills ?? ''} ${o.Direction ?? ''}`.toUpperCase();
    out.push({
      date: normDate(o['Date (IST)']), symbol: o.Symbol.trim().toUpperCase(), entryTime: normTime(o.EntryTime) || normTime(o['Time (IST)']),
      avgEntry: num(o.AvgEntry), avgExit: num(o.AvgExit), exitType: (o.ExitType ?? '').trim().toUpperCase() || 'UNKNOWN',
      lastStop: num(o.LastStop), short: /SHORT|SELL/.test(dir),
    });
  }
  return out;
}

const minutes = (hhmmss: string) => { const [h, m] = hhmmss.split(':').map(Number); return h * 60 + m; };
const istMinutes = (ms: number) => { const d = new Date(ms + 19800_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const istHhmm = (ms: number) => { const d = new Date(ms + 19800_000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

/** an Algo Live order next to its journal trade */
export function compare(date: string, o: OrderRec, journal: JournalTrade[]): FillRow | undefined {
  const sym = o.symbol.trim().toUpperCase();
  const cands = journal.filter((j) => j.date === date && j.short && j.symbol === sym);
  const j = cands.sort((a, b) => Math.abs(minutes(a.entryTime || '00:00') - istMinutes(o.sentAt)) - Math.abs(minutes(b.entryTime || '00:00') - istMinutes(o.sentAt)))[0];
  const entry = o.avgPrice || j?.avgEntry;
  if (!entry) return undefined; // never filled
  const entryTicks = round((o.price - entry) / TICK, 1);
  const exit = j?.avgExit ?? null, exitType = j ? j.exitType : 'OPEN';
  // the stop the trade actually had at the end: the bracket's own, unless it was moved
  const stop = exitType === 'STOP' && j?.lastStop ? j.lastStop : o.stop;
  const stopTicks = exitType === 'STOP' && exit ? round((exit - stop) / TICK, 1) : null;
  const targetTicks = exitType === 'TARGET' && exit ? round((exit - o.target) / TICK, 1) : null;
  const dist = o.stop - (o.price - TICK); // the backtest's risk per share
  let extra = (entryTicks - 1) * TICK;
  if (stopTicks !== null) extra += (stopTicks - 1) * TICK;
  if (targetTicks !== null) extra += targetTicks * TICK;
  return {
    date, symbol: o.symbol, time: istHhmm(o.sentAt), signal: o.price, entry, stop, target: o.target, exit, exitType,
    entryTicks, stopTicks, stopPct: stopTicks !== null && exit ? round(((exit - stop) / stop) * 100, 3) : null, targetTicks,
    extraR: dist > 0 ? round(extra / dist, 3) : 0, matched: !!j,
  };
}

export function summarize(rows: FillRow[]): FillSummary {
  const stops = rows.filter((r) => r.stopTicks !== null), tgts = rows.filter((r) => r.targetTicks !== null);
  const r2 = (x: number | null, d = 2) => (x === null ? null : round(x, d));
  return {
    trades: rows.length, matched: rows.filter((r) => r.matched).length,
    entryTicks: r2(mean(rows.map((r) => r.entryTicks)), 1),
    stopsHit: stops.length, stopTicks: r2(mean(stops.map((r) => r.stopTicks!)), 1), stopPct: r2(mean(stops.map((r) => r.stopPct!)), 3),
    targetsHit: tgts.length, targetTicks: r2(mean(tgts.map((r) => r.targetTicks!)), 1),
    manual: rows.filter((r) => r.exitType === 'MANUAL').length,
    extraR: r2(mean(rows.filter((r) => r.exitType !== 'OPEN').map((r) => r.extraR)), 3),
  };
}

function tradingDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && out.length < MAX_DAYS; t += 86400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** every Algo Live order since LIVE_FROM that filled, next to its journal trade (oldest first) */
export async function liveFills(store: Store, sheets: SheetsClient, today: string): Promise<{ rows: FillRow[]; summary: FillSummary }> {
  const days = tradingDays(LIVE_FROM, today);
  const states = await Promise.all(days.map((d) => loadState(store, d).catch(() => undefined)));
  const orders = days.flatMap((d, i) => (states[i]?.orders ?? []).filter((o) => !/REJECT|CANCEL/i.test(o.status)).map((o) => ({ d, o, avgVol: states[i]!.list.find((x) => x.symbol === o.symbol)?.avgVol })));
  const tabs = [...new Set(orders.map((x) => monthSheetTitle(x.d)))].filter((t) => MONTHS.some((m) => t.startsWith(m)));
  const journal: JournalTrade[] = [];
  const known = new Set((await sheets.listTabs()).map((t) => t.title));
  for (const tab of tabs) {
    if (!known.has(tab)) continue;
    const { headers, rows } = await sheets.readAll(tab);
    journal.push(...journalTrades(headers, rows));
  }
  const rows = orders.map(({ d, o, avgVol }) => { const r = compare(d, o, journal); if (r && avgVol) r.avgVol = avgVol; return r; }).filter((r): r is FillRow => !!r);
  return { rows, summary: summarize(rows) };
}
