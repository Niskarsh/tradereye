import { SheetsClient, objectToRow, rowToObject, colLetter, type Cell } from '../sheetsApi';
import {
  LIVE_TRADE_COLS, ORDER_EVENT_COLS, ORDER_STATE_COLS, TAB_LIVE_TRADES, TAB_ORDER_EVENTS, TAB_ORDER_STATE,
} from './schema';
import type { OrderEvent, OrderHistoryPoint, TrackedOrder } from './types';
import { istDateKey, istDateTime, parseIst } from './time';

/**
 * Persistence for live capture. Everything lives in three extra tabs of the same spreadsheet:
 *   order-state   one row per order, with its change history (so stop moves can be reconstructed)
 *   order-events  append-only log of every change (what the Live page shows as "activity")
 *   live-trades   one row per trade: OPEN while the position is on, then LOGGED once it has been
 *                 written to the monthly sheet. Open trades NEVER appear in the monthly sheets, so
 *                 Journal and Stats can't see them until they are complete.
 */

const TAIL_ROWS = 400;

type Obj = Record<string, string>;

export interface LiveTradeRow {
  rowNumber?: number;
  GroupId: string; Date: string; Symbol: string; SecurityId: string; Direction: string; Status: string;
  NetQty: number; AvgCost: number; RealizedGross: number; Adds: number;
  EntryTime: string; LastTime: string; InitialStop: number | ''; LastStop: number | ''; StopMoves: number;
  TpLast: number | ''; RiskInr: number | ''; FillCount: number; FillKeys: string;
  FinalizedAt: string; UpdatedAt: string; Note: string;
}

const n = (v: unknown) => { const x = parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : 0; };

function packHistory(h: OrderHistoryPoint[]): string {
  return JSON.stringify(h.map((p) => [p.ts, p.status, p.trigger, p.price, p.qty, p.filled]));
}
function unpackHistory(s: string): OrderHistoryPoint[] {
  try {
    const a = JSON.parse(s) as [number, string, number, number, number, number][];
    return a.map(([ts, status, trigger, price, qty, filled]) => ({ ts, status, trigger, price, qty, filled }));
  } catch { return []; }
}

export class LiveStore {
  private ready = false;
  private stateHeaders: string[] = [];
  private eventHeaders: string[] = [];
  private tradeHeaders: string[] = [];
  private stash: { state: { rowNumber: number; cells: string[] }[]; trades: { rowNumber: number; cells: string[] }[] } | null = null;

  constructor(private sheets: SheetsClient) {}

  async ensure(): Promise<void> {
    if (this.ready) return;
    // our own tabs: remember their header rows for 10 minutes instead of re-reading them on every poll
    const opts = { cacheMs: 600_000 };
    this.stateHeaders = (await this.sheets.ensureTab(TAB_ORDER_STATE, ORDER_STATE_COLS, opts)).headers;
    this.eventHeaders = (await this.sheets.ensureTab(TAB_ORDER_EVENTS, ORDER_EVENT_COLS, opts)).headers;
    this.tradeHeaders = (await this.sheets.ensureTab(TAB_LIVE_TRADES, LIVE_TRADE_COLS, opts)).headers;
    this.ready = true;
  }

  /** Reads the order state and the trades of this poll together: two requests in total, however many tabs. */
  async preload(): Promise<void> {
    await this.ensure();
    const [state, trades] = await this.sheets.readTails([
      { title: TAB_ORDER_STATE, tail: TAIL_ROWS, headers: this.stateHeaders },
      { title: TAB_LIVE_TRADES, tail: 200, headers: this.tradeHeaders },
    ]);
    this.stash = { state: state.rows, trades: trades.rows };
  }

  /* ------------------------------------------------------------------ orders */

  async loadOrders(): Promise<{ known: Map<string, TrackedOrder>; rowOf: Map<string, number> }> {
    await this.ensure();
    const rows = this.stash ? this.stash.state : (await this.sheets.readTail(TAB_ORDER_STATE, TAIL_ROWS, this.stateHeaders)).rows;
    const known = new Map<string, TrackedOrder>();
    const rowOf = new Map<string, number>();
    for (const r of rows) {
      const o = rowToObject(this.stateHeaders, r.cells);
      if (!o.OrderId) continue;
      known.set(o.OrderId, {
        orderId: o.OrderId, symbol: o.Symbol, securityId: o.SecurityId, segment: o.Segment,
        side: o.Side === 'BUY' ? 'BUY' : 'SELL', kind: (o.Kind as TrackedOrder['kind']) || 'OTHER',
        legNo: o.LegNo === '' ? null : n(o.LegNo), product: o.Product, status: o.Status,
        triggerPrice: n(o.Trigger), price: n(o.Price), qty: n(o.Qty), filledQty: n(o.Filled),
        createTime: o.CreateTime, updateTime: o.UpdateTime, version: n(o.Version), src: o.Src,
        history: unpackHistory(o.History),
      });
      rowOf.set(o.OrderId, r.rowNumber);
    }
    return { known, rowOf };
  }

  async saveOrders(updated: TrackedOrder[], rowOf: Map<string, number>, events: OrderEvent[]): Promise<void> {
    await this.ensure();
    const toRow = (t: TrackedOrder): Cell[] => objectToRow(this.stateHeaders, {
      OrderId: t.orderId,
      Date: istDateKey(Number.isFinite(parseIst(t.createTime)) ? parseIst(t.createTime) : Date.now()),
      Symbol: t.symbol, SecurityId: t.securityId, Segment: t.segment, Side: t.side, Kind: t.kind, Product: t.product,
      LegNo: t.legNo ?? '', Status: t.status, Trigger: t.triggerPrice, Price: t.price, Qty: t.qty, Filled: t.filledQty,
      CreateTime: t.createTime, UpdateTime: t.updateTime, Version: t.version, Src: t.src, History: packHistory(t.history),
    });
    const lastCol = colLetter(this.stateHeaders.length - 1);
    const updates: { range: string; values: Cell[][] }[] = [];
    const fresh: Cell[][] = [];
    for (const t of updated) {
      const row = rowOf.get(t.orderId);
      if (row) updates.push({ range: `'${TAB_ORDER_STATE}'!A${row}:${lastCol}${row}`, values: [toRow(t)] });
      else fresh.push(toRow(t));
    }
    await this.sheets.updateRanges(updates, true);
    await this.sheets.append(TAB_ORDER_STATE, fresh, true);
    if (events.length) {
      await this.sheets.append(TAB_ORDER_EVENTS, events.map((e) => objectToRow(this.eventHeaders, {
        EventKey: e.key, Time: istDateTime(e.ts), Date: e.date, OrderId: e.orderId, Symbol: e.symbol, Side: e.side,
        Kind: e.kind, Status: e.status, Trigger: e.trigger, Price: e.price, Qty: e.qty, Filled: e.filled, Src: e.src, Note: e.note,
      })), true);
    }
  }

  async recentEvents(limit = 30): Promise<{ time: string; symbol: string; side: string; kind: string; status: string; trigger: number; price: number; qty: number; src: string; note: string }[]> {
    await this.ensure();
    const { rows } = await this.sheets.readTail(TAB_ORDER_EVENTS, limit, this.eventHeaders);
    return rows.map((r) => rowToObject(this.eventHeaders, r.cells)).filter((o) => o.EventKey).reverse().map((o) => ({
      time: o.Time, symbol: o.Symbol, side: o.Side, kind: o.Kind, status: o.Status,
      trigger: n(o.Trigger), price: n(o.Price), qty: n(o.Qty), src: o.Src, note: o.Note,
    }));
  }

  /* ------------------------------------------------------------- live trades */

  async loadTrades(): Promise<Map<string, LiveTradeRow>> {
    await this.ensure();
    const rows = this.stash ? this.stash.trades : (await this.sheets.readTail(TAB_LIVE_TRADES, 200, this.tradeHeaders)).rows;
    const out = new Map<string, LiveTradeRow>();
    for (const r of rows) {
      const o: Obj = rowToObject(this.tradeHeaders, r.cells);
      if (!o.GroupId) continue;
      const opt = (v: string) => (v === '' ? '' as const : n(v));
      out.set(o.GroupId, {
        rowNumber: r.rowNumber, GroupId: o.GroupId, Date: o.Date, Symbol: o.Symbol, SecurityId: o.SecurityId,
        Direction: o.Direction, Status: o.Status, NetQty: n(o.NetQty), AvgCost: n(o.AvgCost), RealizedGross: n(o.RealizedGross),
        Adds: n(o.Adds), EntryTime: o.EntryTime, LastTime: o.LastTime, InitialStop: opt(o.InitialStop), LastStop: opt(o.LastStop),
        StopMoves: n(o.StopMoves), TpLast: opt(o.TpLast), RiskInr: opt(o.RiskInr), FillCount: n(o.FillCount), FillKeys: o.FillKeys,
        FinalizedAt: o.FinalizedAt, UpdatedAt: o.UpdatedAt, Note: o.Note,
      });
    }
    return out;
  }

  async saveTrades(rows: LiveTradeRow[]): Promise<void> {
    await this.ensure();
    const lastCol = colLetter(this.tradeHeaders.length - 1);
    const toRow = (t: LiveTradeRow): Cell[] => objectToRow(this.tradeHeaders, { ...t, rowNumber: undefined } as unknown as Record<string, Cell>);
    const updates: { range: string; values: Cell[][] }[] = [];
    const fresh: Cell[][] = [];
    for (const t of rows) {
      if (t.rowNumber) updates.push({ range: `'${TAB_LIVE_TRADES}'!A${t.rowNumber}:${lastCol}${t.rowNumber}`, values: [toRow(t)] });
      else fresh.push(toRow(t));
    }
    await this.sheets.updateRanges(updates, true);
    await this.sheets.append(TAB_LIVE_TRADES, fresh, true);
  }
}
