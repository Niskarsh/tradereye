import { SheetsClient, colLetter, objectToRow, rowToObject, type Cell } from '../sheetsApi';
import { MONTHLY_ALL } from './schema';
import { istTime, monthSheetTitle, normDate, normTime } from './time';
import type { Pnl, TradeGroup, TradeMeta } from './types';

/** Identifies one execution independently of how the sheet formatted ids, dates or times. */
export function fillKey(date: unknown, symbol: unknown, time: unknown, side: unknown, qty: unknown, price: unknown): string {
  const q = Math.round(parseFloat(String(qty ?? '').replace(/,/g, '')) || 0);
  const p = (parseFloat(String(price ?? '').replace(/,/g, '')) || 0).toFixed(2);
  return [normDate(date), String(symbol ?? '').trim().toUpperCase(), normTime(time), String(side ?? '').trim().toUpperCase(), q, p].join('|');
}

/** Keys of the executions already sitting in a monthly sheet (reads the most recent rows). */
export async function existingFillKeys(sheets: SheetsClient, title: string, tail = 600): Promise<Set<string>> {
  const tab = await sheets.findTab(title);
  if (!tab) return new Set();
  const { headers, rows } = await sheets.readTail(title, tail);
  const keys = new Set<string>();
  for (const r of rows) {
    const o = rowToObject(headers, r.cells);
    keys.add(fillKey(o['Date (IST)'], o.Symbol, o['Time (IST)'], o.OrderType, o.Qty, o.Price));
  }
  return keys;
}

export function groupFillKeys(g: TradeGroup): string[] {
  return g.parts.map((p) => fillKey(p.fill.time.split(' ')[0], g.symbol, p.fill.time.split(' ')[1], p.fill.side, p.qty, p.fill.price));
}

const inFlight = new Set<string>();

/**
 * Writes a CLOSED trade into its monthly sheet using exactly the same row shape the manual sync page
 * produces (one row per fill), plus the extra live columns. Returns 'DUPLICATE' (and writes nothing)
 * if any of its executions is already in the sheet, e.g. because you logged it by hand first.
 */
export async function finalizeGroup(
  sheets: SheetsClient, g: TradeGroup, pnl: Pnl, meta: TradeMeta,
): Promise<'LOGGED' | 'DUPLICATE' | 'BUSY'> {
  if (inFlight.has(g.id)) return 'BUSY';
  inFlight.add(g.id);
  try {
    const title = monthSheetTitle(g.date);
    const { headers } = await sheets.ensureTab(title, MONTHLY_ALL);
    const have = await existingFillKeys(sheets, title);
    if (groupFillKeys(g).some((k) => have.has(k))) return 'DUPLICATE';

    const common: Record<string, Cell | undefined> = {
      TradeGroupId: g.id,
      Direction: g.direction,
      GrossPnL: pnl.grossPnL.toFixed(2),
      NetPnL: pnl.netPnL.toFixed(2),
      TotalCharges: pnl.totalCharges.toFixed(2),
      Status: pnl.status,
      'Duration (Sec)': pnl.durationSec,
      IsConsistent: pnl.isConsistent ? 'YES' : 'NO',
      Comment: '', ScreenshotUrl: '',
      Source: 'AUTO', SecurityId: g.securityId,
      EntryTime: istTime(g.entryTs), ExitTime: istTime(g.lastTs),
      AvgEntry: Number(g.avgEntry.toFixed(2)), AvgExit: Number(g.avgExit.toFixed(2)),
      PeakQty: g.peakQty, AddCount: g.adds,
      InitialStop: meta.initialStop, InitialStopDist: meta.initialStopDist, RiskInr: meta.riskInr,
      LastStop: meta.lastStop, StopMoves: meta.initialStop === undefined ? undefined : meta.stopMoves,
      TpFirst: meta.tpFirst, TpLast: meta.tpLast, ExitType: meta.exitType,
      DirFromFills: g.direction,
    };
    const rows = g.parts.map((p) => objectToRow(headers, {
      ...common,
      'Date (IST)': p.fill.time.split(' ')[0],
      Symbol: g.symbol,
      OrderType: p.fill.side,
      Price: p.fill.price,
      Qty: p.qty,
      'Time (IST)': p.fill.time.split(' ')[1],
      ExchTradeId: p.partId,
    }));
    await sheets.append(title, rows); // USER_ENTERED, the same as the existing addRows path
    return 'LOGGED';
  } finally {
    inFlight.delete(g.id);
  }
}

/**
 * Self-heal: a trade that was logged before its stop orders were understood (e.g. an order feed that sent partial
 * frames) gets its stop / risk / target / exit columns filled in afterwards. Only blank cells are written, and only
 * on rows that carry this trade's group id, so nothing you typed is ever overwritten.
 */
/** The cell updates that fill one trade's blank stop / risk / target columns (and its exit type). */
export function stopPatchUpdates(
  title: string, headers: string[], rows: { rowNumber: number; cells: string[] }[], groupId: string, meta: TradeMeta,
): { updates: { range: string; values: Cell[][] }[]; rows: number } {
  const values: Record<string, Cell> = {
    InitialStop: meta.initialStop ?? '', InitialStopDist: meta.initialStopDist ?? '', RiskInr: meta.riskInr ?? '',
    LastStop: meta.lastStop ?? '', StopMoves: meta.initialStop === undefined ? '' : meta.stopMoves,
    TpFirst: meta.tpFirst ?? '', TpLast: meta.tpLast ?? '', ExitType: meta.exitType === 'UNKNOWN' ? '' : meta.exitType,
  };
  const updates: { range: string; values: Cell[][] }[] = [];
  const q = `'${title.replace(/'/g, "''")}'`;
  let n = 0;
  for (const r of rows) {
    const o = rowToObject(headers, r.cells);
    if (o.TradeGroupId !== groupId) continue;
    n++;
    for (const [col, v] of Object.entries(values)) {
      const i = headers.indexOf(col);
      if (i < 0 || v === '') continue;
      // ExitType may already say MANUAL/UNKNOWN from the first pass; the other columns must be blank to be filled
      if (col !== 'ExitType' && String(o[col] ?? '').trim() !== '') continue;
      updates.push({ range: `${q}!${colLetter(i)}${r.rowNumber}`, values: [[v]] });
    }
  }
  return { updates, rows: n };
}

export async function patchStopColumns(sheets: SheetsClient, g: TradeGroup, meta: TradeMeta): Promise<number> {
  if (meta.initialStop === undefined) return 0;
  const title = monthSheetTitle(g.date);
  const tab = await sheets.findTab(title);
  if (!tab) return 0;
  const { headers, rows } = await sheets.readTail(title, 600);
  const { updates, rows: n } = stopPatchUpdates(title, headers, rows, g.id, meta);
  await sheets.updateRanges(updates);
  return n;
}
