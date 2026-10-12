import type {
  ExitType, Fill, OrderEvent, OrderKind, OrderSnap, Side, TrackedOrder, TradeGroup, TradeMeta,
} from './types';
import { istDateKey, parseIst } from './time';
import { positionAt } from './grouping';

/* eslint-disable @typescript-eslint/no-explicit-any */

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

function kindOf(raw: unknown): OrderKind {
  const t = str(raw).toUpperCase().replace(/[\s-]/g, '_');
  if (t === 'LIMIT' || t === 'LMT') return 'LIMIT';
  if (t === 'MARKET' || t === 'MKT') return 'MARKET';
  if (t === 'STOP_LOSS' || t === 'SL') return 'SL';
  if (t === 'STOP_LOSS_MARKET' || t === 'SLM' || t === 'SL_M') return 'SLM';
  return 'OTHER';
}

function sideOf(raw: unknown): Side {
  const t = str(raw).toUpperCase();
  return t === 'B' || t === 'BUY' ? 'BUY' : 'SELL';
}

const SEGMENTS: Record<string, string> = { E: 'EQ', D: 'FNO', C: 'CURRENCY', M: 'COMM' };
const PRODUCTS: Record<string, string> = { I: 'INTRADAY', C: 'CNC', M: 'MARGIN', F: 'MTF', B: 'BO', V: 'CO' };

function legNoOf(o: any): number | null {
  if (o.LegNo !== undefined && o.LegNo !== null && o.LegNo !== '') return num(o.LegNo);
  const leg = str(o.legName).toUpperCase();
  if (leg === 'ENTRY_LEG') return 1;
  if (leg === 'STOP_LOSS_LEG') return 2;
  if (leg === 'TARGET_LEG') return 3;
  return null;
}

/**
 * Accepts an order in ANY of the shapes Dhan produces:
 *  - REST order book row            (orderId, orderStatus, transactionType, orderType: LIMIT/STOP_LOSS...)
 *  - Order-update WebSocket "Data"  (OrderNo, Status, TxnType: B/S, OrderType: LMT/SL..., LegNo)
 *  - Postback payload               (same field names as the REST order book)
 * and returns one canonical snapshot. Returns null when there is no usable order id.
 */
export function normalizeOrder(raw: any): OrderSnap | null {
  if (!raw || typeof raw !== 'object') return null;
  const orderId = str(raw.orderId ?? raw.OrderNo ?? raw.orderNo);
  if (!orderId) return null;
  const segment = raw.exchangeSegment
    ? str(raw.exchangeSegment)
    : `${str(raw.Exchange) || 'NSE'}_${SEGMENTS[str(raw.Segment).toUpperCase()] ?? str(raw.Segment)}`;
  const createTime = str(raw.createTime ?? raw.OrderDateTime);
  const updateTime = str(raw.updateTime ?? raw.LastUpdatedTime) || createTime;
  const product = str(raw.productType ?? raw.ProductName) || PRODUCTS[str(raw.Product).toUpperCase()] || str(raw.Product);
  return {
    orderId,
    status: str(raw.orderStatus ?? raw.Status).toUpperCase().replace(/[\s-]/g, '_'),
    side: sideOf(raw.transactionType ?? raw.TxnType),
    kind: kindOf(raw.orderType ?? raw.OrderType),
    legNo: legNoOf(raw),
    symbol: str(raw.tradingSymbol ?? raw.Symbol).toUpperCase(),
    securityId: str(raw.securityId ?? raw.SecurityId),
    segment,
    product: product.toUpperCase(),
    triggerPrice: num(raw.triggerPrice ?? raw.TriggerPrice),
    price: num(raw.price ?? raw.Price),
    qty: num(raw.quantity ?? raw.Quantity),
    filledQty: num(raw.filledQty ?? raw.TradedQty),
    createTime,
    updateTime,
  };
}

/** One row of Dhan's trade book -> Fill. */
export function normalizeTrade(raw: any): Fill | null {
  if (!raw || typeof raw !== 'object') return null;
  const time = str(raw.createTime ?? raw.exchangeTime);
  const ts = parseIst(time);
  const qty = num(raw.tradedQuantity);
  const price = num(raw.tradedPrice);
  const tradeId = str(raw.exchangeTradeId);
  if (!Number.isFinite(ts) || qty <= 0 || !tradeId) return null;
  return {
    tradeId,
    orderId: str(raw.orderId),
    symbol: str(raw.tradingSymbol).toUpperCase(),
    securityId: str(raw.securityId),
    segment: str(raw.exchangeSegment) || 'NSE_EQ',
    side: sideOf(raw.transactionType),
    qty, price, ts, time,
  };
}

/** Postback bodies are a single order; WebSocket frames are {Type:'order_alert', Data:{...}}. */
export function snapsFromPayload(body: any): OrderSnap[] {
  const items: any[] = Array.isArray(body) ? body : [body];
  const out: OrderSnap[] = [];
  for (const it of items) {
    const data = it && typeof it === 'object' && it.Data && typeof it.Data === 'object' ? it.Data : it;
    const snap = normalizeOrder(data);
    if (snap) out.push(snap);
  }
  return out;
}

/* ------------------------------------------------------------------ diffing */

const HISTORY_CAP = 80;

export interface ApplyResult { events: OrderEvent[]; updated: TrackedOrder[] }

/**
 * Compares incoming snapshots with what we already know and produces change events.
 * Safe to call repeatedly with the same data (no change -> no events) and with out-of-order data
 * (a snapshot older than what we hold is ignored).
 */
export function applyOrderSnaps(
  known: Map<string, TrackedOrder>, snaps: OrderSnap[], src: string, nowMs: number,
): ApplyResult {
  const events: OrderEvent[] = [];
  const updated = new Map<string, TrackedOrder>();

  for (const s of snaps) {
    const prev = updated.get(s.orderId) ?? known.get(s.orderId);
    const sTs = parseIst(s.updateTime);
    const ts = Number.isFinite(sTs) ? sTs : nowMs;

    if (prev) {
      const pTs = parseIst(prev.updateTime);
      if (Number.isFinite(pTs) && Number.isFinite(sTs) && sTs < pTs) continue; // stale
    }

    const notes: string[] = [];
    if (!prev) {
      notes.push('NEW');
    } else {
      if (prev.status !== s.status) notes.push(`STATUS ${prev.status}→${s.status}`);
      if (prev.triggerPrice !== s.triggerPrice) notes.push(`TRIGGER ${prev.triggerPrice}→${s.triggerPrice}`);
      if (prev.price !== s.price) notes.push(`PRICE ${prev.price}→${s.price}`);
      if (prev.qty !== s.qty) notes.push(`QTY ${prev.qty}→${s.qty}`);
      if (prev.filledQty !== s.filledQty) notes.push(`FILLED ${prev.filledQty}→${s.filledQty}`);
    }
    if (notes.length === 0) continue;

    const point = { ts, status: s.status, trigger: s.triggerPrice, price: s.price, qty: s.qty, filled: s.filledQty };
    const history = [...(prev?.history ?? []), point].slice(-HISTORY_CAP);
    const next: TrackedOrder = {
      ...s,
      createTime: s.createTime || prev?.createTime || '',
      symbol: s.symbol || prev?.symbol || '',
      securityId: s.securityId || prev?.securityId || '',
      history,
      version: (prev?.version ?? 0) + 1,
      src,
    };
    updated.set(s.orderId, next);
    events.push({
      key: `${s.orderId}|${s.updateTime}|${s.status}|${s.triggerPrice}|${s.price}|${s.qty}|${s.filledQty}`,
      ts, date: istDateKey(ts), orderId: s.orderId, symbol: next.symbol, side: s.side, kind: s.kind,
      status: s.status, trigger: s.triggerPrice, price: s.price, qty: s.qty, filled: s.filledQty,
      src, note: notes.join('; '),
    });
  }
  return { events, updated: [...updated.values()] };
}

/* ------------------------------------------------------------ trade analysis */

const isStop = (k: OrderKind) => k === 'SL' || k === 'SLM';

function dedupeConsecutive(values: number[]): number[] {
  const out: number[] = [];
  for (const v of values) if (out.length === 0 || out[out.length - 1] !== v) out.push(v);
  return out;
}

/**
 * Reconstructs what you did with stops and targets during a trade from the orders' change history:
 * where the first stop went in (that distance IS your real risk), how often you moved it, whether a
 * target was ever shown, and how the position finally ended (stop / target / manual).
 * Everything is optional: with no order history the result is simply empty (exitType UNKNOWN).
 */
export function analyzeTrade(g: TradeGroup, orders: TrackedOrder[]): TradeMeta {
  const closing: Side = g.direction === 'LONG' ? 'SELL' : 'BUY';
  const startTs = g.entryTs - 30_000;
  const endTs = g.status === 'CLOSED' ? g.lastTs + 10_000 : Number.POSITIVE_INFINITY;

  const mine = orders.filter((o) =>
    o.symbol === g.symbol && o.side === closing && o.history.length > 0 &&
    o.history[0].ts >= startTs && o.history[0].ts <= endTs);

  const meta: TradeMeta = { stopMoves: 0, tpMoves: 0, exitType: 'UNKNOWN', ordersSeen: mine.length };

  // ---- stops
  const stopPts = mine.filter((o) => isStop(o.kind))
    .flatMap((o) => o.history.map((h) => ({ ...h, qty: o.qty })))
    .filter((h) => h.trigger > 0)
    .sort((a, b) => a.ts - b.ts);
  if (stopPts.length > 0) {
    const path = dedupeConsecutive(stopPts.map((p) => p.trigger));
    const first = stopPts[0];
    const pos = positionAt(g, first.ts);
    const avg = pos.avgCost || g.avgEntry;
    const qty = pos.qty || first.qty;
    meta.initialStop = path[0];
    meta.lastStop = path[path.length - 1];
    meta.stopMoves = path.length - 1;
    meta.initialStopDist = Number(Math.abs(avg - path[0]).toFixed(2));
    meta.riskInr = Number((Math.abs(avg - path[0]) * qty).toFixed(2));
  }

  // ---- targets (limit orders on the profit side of the position)
  const profitSide = (price: number, avg: number) => (g.direction === 'LONG' ? price > avg : price < avg);
  const tpPts = mine.filter((o) => o.kind === 'LIMIT')
    .flatMap((o) => o.history.map((h) => ({ ...h })))
    .filter((h) => {
      const avg = positionAt(g, h.ts).avgCost || g.avgEntry;
      return h.price > 0 && profitSide(h.price, avg);
    })
    .sort((a, b) => a.ts - b.ts);
  if (tpPts.length > 0) {
    const path = dedupeConsecutive(tpPts.map((p) => p.price));
    meta.tpFirst = path[0];
    meta.tpLast = path[path.length - 1];
    meta.tpMoves = path.length - 1;
  }

  // ---- how it ended
  if (g.status === 'CLOSED') {
    const exits = g.parts.filter((p) => p.fill.side === closing);
    const last = exits[exits.length - 1];
    const ord = last ? orders.find((o) => o.orderId === last.fill.orderId) : undefined;
    let t: ExitType = 'UNKNOWN';
    if (ord) {
      if (isStop(ord.kind)) t = 'STOP';
      else if (ord.kind === 'LIMIT') t = profitSide(ord.price, g.avgEntry) ? 'TARGET' : 'MANUAL';
      else if (ord.kind === 'MARKET') t = 'MANUAL';
    }
    meta.exitType = t;
  }
  return meta;
}
