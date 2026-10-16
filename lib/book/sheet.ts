import { colLetter, rowToObject, type Cell, type SheetsClient } from '../sheetsApi';
import { TAB_COPILOT_SETTINGS } from '../copilot/userSettings';
import { MONTHS } from './record';

/**
 * Sheet side of the order book: the recording list (one row in copilot-settings) and a monthly index tab
 * ("october-2026-book", one row per stock per day) that points to the S3 folder, so the journal can find it.
 */

export interface WatchItem { symbol: string; securityId: string }
const SETTINGS_COLS = ['Key', 'Value', 'UpdatedAt'] as const;
const KEY = 'OrderBookWatchlist';
const q = (t: string) => `'${t.replace(/'/g, "''")}'`;
const stamp = (now: number) => new Date(now + 330 * 60_000).toISOString().replace('T', ' ').slice(0, 19);

export async function getWatchlist(sheets: SheetsClient): Promise<WatchItem[]> {
  const tab = await sheets.findTab(TAB_COPILOT_SETTINGS);
  if (!tab) return [];
  const { headers, rows } = await sheets.readTail(TAB_COPILOT_SETTINGS, 50);
  const row = rows.map((r) => rowToObject(headers, r.cells)).find((o) => o.Key === KEY);
  try { const v = JSON.parse(row?.Value ?? '[]'); return Array.isArray(v) ? v.filter((x) => x?.symbol && x?.securityId) : []; } catch { return []; }
}

export async function setWatchlist(sheets: SheetsClient, list: WatchItem[], now = Date.now()): Promise<void> {
  const { headers } = await sheets.ensureTab(TAB_COPILOT_SETTINGS, SETTINGS_COLS);
  const { rows } = await sheets.readTail(TAB_COPILOT_SETTINGS, 50, headers);
  const hit = rows.find((r) => rowToObject(headers, r.cells).Key === KEY);
  const value = JSON.stringify(list.slice(0, 50));
  if (hit) {
    await sheets.updateRanges([
      { range: `${q(TAB_COPILOT_SETTINGS)}!${colLetter(headers.indexOf('Value'))}${hit.rowNumber}`, values: [[value]] },
      { range: `${q(TAB_COPILOT_SETTINGS)}!${colLetter(headers.indexOf('UpdatedAt'))}${hit.rowNumber}`, values: [[stamp(now)]] },
    ], true);
  } else {
    await sheets.append(TAB_COPILOT_SETTINGS, [headers.map((h) => (h === 'Key' ? KEY : h === 'Value' ? value : h === 'UpdatedAt' ? stamp(now) : ''))], true);
  }
}

export const INDEX_COLS = ['Date', 'Symbol', 'SecurityId', 'Folder', 'From', 'To', 'Slots', 'Walls', 'UpdatedAt'] as const;
export const indexTabTitle = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]}-${date.slice(0, 4)}-book`;
export interface IndexRow { date: string; symbol: string; securityId: string; folder: string; from: string; to: string; slots: string[]; walls?: string }

/** Insert or update one row per stock per day (all in one write). */
export async function upsertIndex(sheets: SheetsClient, rowsIn: IndexRow[], now = Date.now()): Promise<number> {
  if (!rowsIn.length) return 0;
  const title = indexTabTitle(rowsIn[0].date);
  const { headers } = await sheets.ensureTab(title, INDEX_COLS);
  const { rows } = await sheets.readAll(title);
  const existing = new Map(rows.map((r) => { const o = rowToObject(headers, r.cells); return [`${o.Date}|${o.Symbol}`, { rowNumber: r.rowNumber, o }]; }));
  const updates: { range: string; values: Cell[][] }[] = [];
  const appends: Cell[][] = [];
  for (const r of rowsIn) {
    const prev = existing.get(`${r.date}|${r.symbol}`);
    const slots = [...new Set([...(prev?.o.Slots ? prev.o.Slots.split(' ') : []), ...r.slots])].sort();
    const from = prev?.o.From && prev.o.From < r.from ? prev.o.From : r.from;
    const to = prev?.o.To && prev.o.To > r.to ? prev.o.To : r.to;
    const vals: Record<string, Cell> = { Date: r.date, Symbol: r.symbol, SecurityId: r.securityId, Folder: r.folder, From: from, To: to, Slots: slots.join(' '), Walls: (r.walls ?? prev?.o.Walls ?? '').slice(0, 2000), UpdatedAt: stamp(now) };
    const line = headers.map((h) => vals[h] ?? '');
    if (prev) updates.push({ range: `${q(title)}!A${prev.rowNumber}:${colLetter(headers.length - 1)}${prev.rowNumber}`, values: [line] });
    else appends.push(line);
  }
  if (updates.length) await sheets.updateRanges(updates, true);
  if (appends.length) await sheets.append(title, appends, true);
  return rowsIn.length;
}

/** The index row for a stock and day (for the journal replay). */
export async function findIndex(sheets: SheetsClient, date: string, symbol: string): Promise<IndexRow | undefined> {
  const title = indexTabTitle(date);
  if (!(await sheets.findTab(title))) return undefined;
  const { headers, rows } = await sheets.readAll(title);
  const o = rows.map((r) => rowToObject(headers, r.cells)).find((x) => x.Date === date && x.Symbol === symbol.toUpperCase());
  return o ? { date, symbol: o.Symbol, securityId: o.SecurityId, folder: o.Folder, from: o.From, to: o.To, slots: (o.Slots ?? '').split(' ').filter(Boolean), walls: o.Walls } : undefined;
}

/** Days that have a recording for a stock (this month's and last month's index tabs), newest first. */
export async function recordedDays(sheets: SheetsClient, symbol: string, today: string): Promise<{ date: string; from: string; to: string }[]> {
  const [y, m] = today.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
  const out: { date: string; from: string; to: string }[] = [];
  for (const d of [today, prev]) {
    const title = indexTabTitle(d);
    if (!(await sheets.findTab(title))) continue;
    const { headers, rows } = await sheets.readAll(title);
    for (const r of rows) {
      const o = rowToObject(headers, r.cells);
      if (o.Symbol === symbol.toUpperCase() && o.Date) out.push({ date: o.Date, from: o.From, to: o.To });
    }
  }
  return [...new Map(out.map((x) => [x.date, x])).values()].sort((a, b) => b.date.localeCompare(a.date));
}
