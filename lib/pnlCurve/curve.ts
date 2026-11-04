import type { Candles } from '../dhan';
import { computeCharges } from '../live/pnl';

/**
 * The day's P&L curve, worked out from fills and 1-minute candles (no network, browser and server alike). Same idea as
 * Dhan's Live P&L: one point a minute, realised plus unrealised. At every minute the overall value is exactly the sum
 * of the positions at that minute.
 *  - gross: before charges, the same basis as Dhan's chart
 *  - net:   each position's charges come off in proportion to the fill value done so far, so the line ends exactly on
 *           gross minus charges
 * A closed position stays flat at what it made. An open one is valued at the minute's close.
 */

const IST = 19800_000;
const MIN = 60_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

export type Side = 'BUY' | 'SELL';
export interface PnlFill { t: number; side: Side; qty: number; price: number }
/** One stock for the day (several trades in the same stock are one position, as on Dhan's positions page). */
export interface PnlPosition {
  symbol: string; securityId?: string; charges: number; fills: PnlFill[];
  /** from the journal: what the exit was and which order it was aimed at (slippage needs these) */
  direction?: string; exitType?: string; lastStop?: number; target?: number; initialStop?: number; stopDist?: number;
}
export type CurveMode = 'gross' | 'net';
export interface CurveLine { gross: number[]; net: number[] }
export interface PositionLine extends CurveLine { symbol: string; openQty: number }
export interface Curve {
  date: string;
  /** start of each minute (epoch ms); a value covers everything up to the end of that minute */
  times: number[];
  overall: CurveLine;
  positions: PositionLine[];
  charges: number;
}

/** Epoch ms of an IST clock time on an IST date. */
export const istMs = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm.trim().padStart(8, '0')}Z`) - IST;
export const SESSION_FROM = '09:15:00';
export const SESSION_TO = '15:29:00';

export function buildCurve(date: string, positions: PnlPosition[], candles: Record<string, Candles | undefined>, nowMs?: number): Curve {
  const from = istMs(date, SESSION_FROM);
  const allFills = positions.flatMap((p) => p.fills);
  const lastFill = allFills.length ? Math.max(...allFills.map((f) => f.t)) : from;
  let to = istMs(date, SESSION_TO);
  if (nowMs !== undefined && nowMs < to) to = Math.floor(nowMs / MIN) * MIN;
  to = Math.max(from, to, Math.floor(lastFill / MIN) * MIN);
  const times: number[] = [];
  for (let t = from; t <= to; t += MIN) times.push(t);

  const lines: PositionLine[] = positions.map((p) => {
    const fills = [...p.fills].sort((a, b) => a.t - b.t);
    const turnover = fills.reduce((s, f) => s + f.qty * f.price, 0);
    const c = candles[p.symbol];
    const closeAt = new Map<number, number>();
    if (c) c.t.forEach((sec, i) => closeAt.set(Math.floor((sec * 1000) / MIN) * MIN, c.c[i]));
    let i = 0, cash = 0, qty = 0, done = 0, mark = fills[0]?.price ?? 0;
    const gross: number[] = [], net: number[] = [];
    for (const t of times) {
      // a fill before the session counts in the first minute, one after it in the last (the axis reaches every fill)
      while (i < fills.length && fills[i].t < t + MIN) {
        const f = fills[i++];
        const val = f.qty * f.price;
        cash += f.side === 'SELL' ? val : -val; qty += f.side === 'BUY' ? f.qty : -f.qty; done += val; mark = f.price;
      }
      const close = closeAt.get(t);
      if (close !== undefined) mark = close;
      const g = cash + qty * mark;
      gross.push(r2(g));
      net.push(r2(g - (turnover ? p.charges * (done / turnover) : 0)));
    }
    return { symbol: p.symbol, gross, net, openQty: qty };
  });

  const sum = (k: CurveMode) => times.map((_, m) => r2(lines.reduce((s, l) => s + l[k][m], 0)));
  return {
    date, times, overall: { gross: sum('gross'), net: sum('net') }, positions: lines,
    charges: r2(positions.reduce((s, p) => s + p.charges, 0)),
  };
}

export interface Extreme { value: number; t: number }
/** Highest and lowest point of a line (earliest time when it repeats). */
export function extremes(values: number[], times: number[]): { high: Extreme; low: Extreme } | undefined {
  if (!values.length) return undefined;
  let hi = 0, lo = 0;
  values.forEach((v, i) => { if (v > values[hi]) hi = i; if (v < values[lo]) lo = i; });
  return { high: { value: values[hi], t: times[hi] }, low: { value: values[lo], t: times[lo] } };
}

const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; };
const pos = (v: unknown) => { const n = num(v); return n > 0 ? n : undefined; };

/** The journal's fill rows used here (one row per fill; group-level values repeat on each row). */
export interface JournalRow {
  TradeGroupId?: string; date?: string; Symbol?: string; Direction?: string; OrderType?: string; Price?: unknown; Qty?: unknown;
  TotalCharges?: unknown; 'Time (IST)'?: string; SecurityId?: string; ExitType?: string; LastStop?: unknown; TpLast?: unknown; InitialStop?: unknown; InitialStopDist?: unknown;
}

/**
 * One day's journal rows -> one position per stock. `undrawable` lists the stocks whose fills have no usable time or
 * price (old hand-logged days): nothing can be drawn for those, so the day falls back to an uploaded picture.
 */
export function positionsFromRows(date: string, rows: JournalRow[]): { positions: PnlPosition[]; undrawable: string[] } {
  const bySymbol = new Map<string, JournalRow[]>();
  for (const r of rows) {
    if (r.date !== date || !r.Symbol?.trim()) continue;
    const s = r.Symbol.trim().toUpperCase();
    bySymbol.set(s, [...(bySymbol.get(s) ?? []), r]);
  }
  const positions: PnlPosition[] = [], undrawable: string[] = [];
  for (const [symbol, list] of bySymbol) {
    const fills: PnlFill[] = [];
    let bad = false;
    for (const r of list) {
      const t = istMs(date, r['Time (IST)'] ?? ''), qty = num(r.Qty), price = num(r.Price);
      const side = String(r.OrderType ?? '').toUpperCase();
      if (!Number.isFinite(t) || !(qty > 0) || !(price > 0) || (side !== 'BUY' && side !== 'SELL')) { bad = true; continue; }
      fills.push({ t, side, qty, price });
    }
    if (bad || !fills.length) { undrawable.push(symbol); continue; }
    // charges are per trade and repeat on each of its rows: count each trade once
    const seen = new Set<string>();
    let charges = 0;
    list.forEach((r, i) => {
      const id = r.TradeGroupId || `row-${i}`;
      if (seen.has(id)) return;
      seen.add(id);
      charges += Math.max(0, num(r.TotalCharges) || 0);
    });
    const last = list[list.length - 1], first = list[0];
    positions.push({
      symbol, securityId: list.find((r) => /^\d+$/.test(r.SecurityId ?? ''))?.SecurityId, charges: r2(charges) || estimateCharges(fills), fills,
      direction: first.Direction, exitType: last.ExitType, lastStop: pos(last.LastStop), target: pos(last.TpLast), initialStop: pos(first.InitialStop), stopDist: pos(first.InitialStopDist),
    });
  }
  return { positions, undrawable };
}

/** Same charge model as the journal, for fills it has not logged yet (a position still running today). */
export function estimateCharges(fills: PnlFill[]): number {
  const val = (s: Side) => fills.filter((f) => f.side === s).reduce((a, f) => a + f.qty * f.price, 0);
  return computeCharges(val('BUY'), val('SELL')).totalCharges;
}

/** A stable text of what the curve was built from: a saved curve is reused only while this has not changed. */
export const positionsKey = (positions: PnlPosition[]) =>
  JSON.stringify([...positions].sort((a, b) => a.symbol.localeCompare(b.symbol)).map((p) => [p.symbol, p.charges, [...p.fills].sort((a, b) => a.t - b.t || a.price - b.price).map((f) => [f.t, f.side, f.qty, f.price])]));
