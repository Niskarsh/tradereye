import { SheetsClient, rowToObject, type Cell } from '../sheetsApi';
import { LiveStore } from './store';
import { analyzeTrade } from './orders';
import { groupFills } from './grouping';
import { stopPatchUpdates } from './finalize';
import { TAB_LIVE_TRADES, TAB_ORDER_EVENTS, TAB_ORDER_STATE } from './schema';
import { MONTHS, normDate, normTime, parseIst } from './time';
import type { Fill } from './types';

const TAB_RE = new RegExp(`^(${MONTHS.join('|')})-\\d{4}$`);
const num = (v: unknown) => parseFloat(String(v ?? '').replace(/,/g, '')) || 0;

export interface RepairResult {
  tabs: number; trades: number; fixed: number; noOrders: number; alreadyFine: number;
  details: { tab: string; symbol: string; date: string; result: string }[];
}

/**
 * Fills the blank stop / risk / target / exit-type columns of trades already in the monthly sheets,
 * using the order history saved in the `order-state` log tab. Same logic the live session uses.
 * Only blank cells are written (ExitType may replace MANUAL/blank), so nothing you typed is touched.
 */
export async function repairFromLogs(sheets: SheetsClient): Promise<RepairResult> {
  const store = new LiveStore(sheets);
  const { known } = await store.loadOrders(100_000);
  const orders = [...known.values()];
  const out: RepairResult = { tabs: 0, trades: 0, fixed: 0, noOrders: 0, alreadyFine: 0, details: [] };

  const tabs = (await sheets.listTabs(true)).map((t) => t.title).filter((t) => TAB_RE.test(t));
  for (const title of tabs) {
    const { headers, rows } = await sheets.readAll(title);
    if (!headers.includes('InitialStop')) continue;
    out.tabs++;
    const byGroup = new Map<string, typeof rows>();
    for (const r of rows) {
      const id = (rowToObject(headers, r.cells).TradeGroupId ?? '').trim();
      if (!id) continue;
      byGroup.set(id, [...(byGroup.get(id) ?? []), r]);
    }
    const updates: { range: string; values: Cell[][] }[] = [];
    for (const [id, grows] of byGroup) {
      const objs = grows.map((r) => rowToObject(headers, r.cells));
      out.trades++;
      const first = objs[0];
      const needs = objs.some((o) => !(o.InitialStop ?? '').trim()) || objs.some((o) => ['', 'MANUAL', 'UNKNOWN'].includes((o.ExitType ?? '').trim().toUpperCase()));
      if (!needs) { out.alreadyFine++; continue; }
      const fills: Fill[] = objs.map((o) => {
        const date = normDate(o['Date (IST)']), time = normTime(o['Time (IST)']);
        return {
          tradeId: o.ExchTradeId || `${id}-${time}`, orderId: '', symbol: String(o.Symbol).trim().toUpperCase(),
          securityId: o.SecurityId || '', segment: 'NSE_EQ',
          side: String(o.OrderType).trim().toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
          qty: num(o.Qty), price: num(o.Price), ts: parseIst(`${date} ${time}`), time: `${date} ${time}`,
        } as Fill;
      }).filter((f) => Number.isFinite(f.ts) && f.qty > 0);
      const groups = groupFills(fills);
      const g = groups[0];
      const label = { tab: title, symbol: String(first.Symbol), date: normDate(first['Date (IST)']) };
      if (!g || groups.length !== 1 || g.status !== 'CLOSED') { out.details.push({ ...label, result: 'skipped: fills do not form one closed trade' }); continue; }
      const meta = analyzeTrade(g, orders);
      if (meta.initialStop === undefined) { out.noOrders++; out.details.push({ ...label, result: 'no stop order found in the log' }); continue; }
      const p = stopPatchUpdates(title, headers, grows, id, meta);
      if (p.updates.length === 0) { out.alreadyFine++; continue; }
      updates.push(...p.updates);
      out.fixed++;
      out.details.push({ ...label, result: `filled stop ${meta.initialStop}, exit ${meta.exitType}` });
    }
    await sheets.updateRanges(updates);
  }
  return out;
}

/** Empties the three live-capture log tabs (headers stay). Monthly sheets are never touched. */
export async function clearLogs(sheets: SheetsClient): Promise<string[]> {
  const cleared: string[] = [];
  for (const t of [TAB_ORDER_STATE, TAB_ORDER_EVENTS, TAB_LIVE_TRADES]) {
    if (await sheets.findTab(t, true)) { await sheets.clearRows(t); cleared.push(t); }
  }
  return cleared;
}
