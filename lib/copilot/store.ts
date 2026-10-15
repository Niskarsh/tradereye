import { colLetter, objectToRow, rowToObject, type Cell, type SheetsClient } from '../sheetsApi';
import { COPILOT_CHAT_COLS, COPILOT_CHECK_COLS, chatTabTitle, checksTabTitle } from '../live/schema';
import { monthSheetTitle, normTime, parseIst } from '../live/time';

/**
 * Co-pilot checks live in one tab per month ("october-2026-checks"): every check, taken or skipped, with its facts,
 * Claude's read and what happened next. When live capture logs the trade, the entry check and a summary of the
 * re-checks are copied onto the trade's rows in the monthly sheet (the Ck... and Rc... columns).
 */

export type CheckRow = Partial<Record<typeof COPILOT_CHECK_COLS[number], Cell>>;
const HEADER_CACHE = { cacheMs: 600_000 };
const q = (t: string) => `'${t.replace(/'/g, "''")}'`;

export const checksTitleFor = (date: string) => checksTabTitle(monthSheetTitle(date));

/** In-memory copy of recent checks, so "Ask Claude" does not have to re-read the sheet (15 minutes). */
const cache = new Map<string, { at: number; row: CheckRow; payload: string }>();
export const FACTS_TTL_MS = 15 * 60_000;

export function remember(checkId: string, row: CheckRow, payload: string, now = Date.now()) {
  cache.set(checkId, { at: now, row, payload });
  for (const [k, v] of cache) if (now - v.at > FACTS_TTL_MS) cache.delete(k);
}
export function recall(checkId: string, now = Date.now()) {
  const hit = cache.get(checkId);
  return hit && now - hit.at <= FACTS_TTL_MS ? hit : undefined;
}

export async function appendCheck(sheets: SheetsClient, date: string, row: CheckRow): Promise<void> {
  const title = checksTitleFor(date);
  const { headers } = await sheets.ensureTab(title, COPILOT_CHECK_COLS, HEADER_CACHE);
  await sheets.append(title, [objectToRow(headers, row as Record<string, Cell>)], true);
}

export interface FoundCheck { title: string; rowNumber: number; headers: string[]; o: Record<string, string> }

export async function readChecks(sheets: SheetsClient, date: string, tail = 300): Promise<{ title: string; headers: string[]; rows: { rowNumber: number; o: Record<string, string> }[] }> {
  const title = checksTitleFor(date);
  const tab = await sheets.findTab(title);
  if (!tab) return { title, headers: [], rows: [] };
  const { headers, rows } = await sheets.readTail(title, tail);
  return { title, headers, rows: rows.map((r) => ({ rowNumber: r.rowNumber, o: rowToObject(headers, r.cells) })) };
}

export async function findCheck(sheets: SheetsClient, date: string, checkId: string): Promise<FoundCheck | undefined> {
  const { title, headers, rows } = await readChecks(sheets, date);
  const hit = rows.find((r) => r.o.CheckId === checkId);
  return hit ? { title, rowNumber: hit.rowNumber, headers, o: hit.o } : undefined;
}

export async function updateCheck(sheets: SheetsClient, found: FoundCheck, values: CheckRow): Promise<void> {
  const updates: { range: string; values: Cell[][] }[] = [];
  for (const [k, v] of Object.entries(values)) {
    const i = found.headers.indexOf(k);
    if (i >= 0) updates.push({ range: `${q(found.title)}!${colLetter(i)}${found.rowNumber}`, values: [[v ?? '']] });
  }
  await sheets.updateRanges(updates, true);
}

export function askedToday(rows: { o: Record<string, string> }[], date: string): number {
  return rows.filter((r) => r.o.Date === date && r.o.Status === 'ASKED').length;
}

/* ---- linking a logged trade to its checks ------------------------------------------------------------------ */

export interface TradeForLink { date: string; symbol: string; direction: 'LONG' | 'SHORT'; entryTs: number; lastTs: number }

const checkTs = (o: Record<string, string>) => parseIst(`${o.Date} ${normTime(o.Time)}`);
const LINK_WINDOW_MS = 10 * 60_000;

/**
 * Which check rows belong to this trade: the latest ENTRY check for the same symbol and direction made within
 * 10 minutes before the first fill, and every MANAGE check made while the trade was open. Rows already linked to
 * another trade are never taken.
 */
export function matchChecks(rows: { rowNumber: number; o: Record<string, string> }[], t: TradeForLink) {
  const mine = rows.filter((r) => r.o.Date === t.date && r.o.Symbol?.toUpperCase() === t.symbol.toUpperCase()
    && r.o.Direction === t.direction && !r.o.TradeGroupId);
  const entry = mine
    .filter((r) => r.o.Mode === 'ENTRY')
    .map((r) => ({ r, ts: checkTs(r.o) }))
    .filter((x) => Number.isFinite(x.ts) && x.ts <= t.entryTs + 60_000 && x.ts >= t.entryTs - LINK_WINDOW_MS)
    .sort((a, b) => b.ts - a.ts)[0]?.r;
  const manage = mine
    .filter((r) => r.o.Mode === 'MANAGE')
    .map((r) => ({ r, ts: checkTs(r.o) }))
    .filter((x) => Number.isFinite(x.ts) && x.ts >= t.entryTs - 60_000 && x.ts <= t.lastTs + 60_000)
    .sort((a, b) => a.ts - b.ts).map((x) => x.r);
  return { entry, manage };
}

const CK_FROM: Record<string, string> = {
  CkTime: 'Time', CkNiftyState: 'NiftyState', CkNiftyFirst5Pct: 'NiftyFirst5Pct', CkNiftyNowPct: 'NiftyNowPct', CkRvolDay: 'RvolDay',
  CkEma200_5mAtr: 'Ema200_5mAtr', CkEma200_10mAtr: 'Ema200_10mAtr', CkEma200_1dAtr: 'Ema200_1dAtr', CkEma200InPath: 'Ema200InPath',
  CkEntryVsOr: 'EntryVsOr', CkPdhDistAtr: 'PdhDistAtr', CkPdlDistAtr: 'PdlDistAtr', CkVwapSide: 'VwapSide',
  CkRsVsNiftyPct: 'RsVsNiftyPct', CkRs20mPct: 'Rs20mPct', CkExtAdrPct: 'ExtAdrPct', CkPocDistAtr: 'PocDistAtr',
  CkPullbackNo: 'PullbackNo', CkVolTrend: 'VolTrend', CkPushVsPullVol: 'PushVsPullVol', CkClimax: 'Climax', CkFailedBreak: 'FailedBreak',
  CkStopVsAtr2: 'StopVsAtr2', CkRoomVsStop: 'RoomVsStop', CkEstChargesInr: 'EstChargesInr', CkFirstTradeLost: 'FirstTradeLost',
  CkSameSymbolStopped: 'SameSymbolStopped', CkMinSinceLoss: 'MinSinceLoss', CkId: 'CheckId', CkVerdict: 'Verdict',
  CkWatch: 'Watch', CkDecision: 'Decision', CkPromptVersion: 'PromptVersion', CkModel: 'Model', CkCostInr: 'CostInr',
};

const joinLines = (o: Record<string, string>) => [o.Line1, o.Line2, o.Line3].filter(Boolean).join(' | ');

/** The Ck... and Rc... values to put on the trade's monthly rows. */
export function monthlyColumns(entry: { o: Record<string, string> } | undefined, manage: { o: Record<string, string> }[]): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  if (entry) {
    for (const [to, from] of Object.entries(CK_FROM)) out[to] = entry.o[from] ?? '';
    out.CkLines = joinLines(entry.o);
  }
  if (manage.length) {
    const last = manage[manage.length - 1].o;
    out.RcCount = manage.length;
    out.RcLastTime = last.Time ?? '';
    out.RcLastLabel = last.Verdict ?? '';
    out.RcLastLines = joinLines(last);
    out.RcLastWatch = last.Watch ?? '';
    const cost = manage.reduce((s, r) => s + (parseFloat(r.o.CostInr) || 0), 0);
    out.RcCostInr = cost ? Number(cost.toFixed(3)) : '';
  }
  return out;
}

/** Reads the month's checks and returns what to copy onto the trade, plus a function that tags the check rows. */
export async function checksForTrade(sheets: SheetsClient, t: TradeForLink) {
  const { title, headers, rows } = await readChecks(sheets, t.date, 400);
  if (!rows.length) return { columns: {} as Record<string, Cell>, tag: async () => {} };
  const { entry, manage } = matchChecks(rows, t);
  const columns = monthlyColumns(entry, manage);
  const linked = [entry, ...manage].filter((x): x is NonNullable<typeof x> => !!x);
  const tag = async (groupId: string) => {
    const i = headers.indexOf('TradeGroupId');
    if (i < 0 || !linked.length) return;
    await sheets.updateRanges(linked.map((r) => ({ range: `${q(title)}!${colLetter(i)}${r.rowNumber}`, values: [[groupId]] })), true);
  };
  return { columns, tag };
}

/* ---- chat log ------------------------------------------------------------------------------------------------ */

export type ChatRow = Partial<Record<typeof COPILOT_CHAT_COLS[number], Cell>>;
export const chatTitleFor = (date: string) => chatTabTitle(monthSheetTitle(date));

export async function appendChat(sheets: SheetsClient, date: string, row: ChatRow): Promise<void> {
  const title = chatTitleFor(date);
  const { headers } = await sheets.ensureTab(title, COPILOT_CHAT_COLS, HEADER_CACHE);
  await sheets.append(title, [objectToRow(headers, row as Record<string, Cell>)], true);
}

/** Questions already answered today (for the daily chat limit). */
export async function chatsToday(sheets: SheetsClient, date: string): Promise<number> {
  const title = chatTitleFor(date);
  const tab = await sheets.findTab(title);
  if (!tab) return 0;
  const { headers, rows } = await sheets.readTail(title, 400);
  return rows.map((r) => rowToObject(headers, r.cells)).filter((o) => o.Date === date && !o.Error).length;
}
