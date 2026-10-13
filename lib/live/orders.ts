import type {
  ExitType, Fill, OrderEvent, OrderKind, OrderSnapIn, Side, TrackedOrder, TradeGroup, TradeMeta,
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

/** Trade book rows always carry BUY/SELL, so there the default is harmless. */
function sideOf(raw: unknown): Side {
  const t = str(raw).toUpperCase();
  return t === 'B' || t === 'BUY' ? 'BUY' : 'SELL';
}
/** For order feeds: an unknown or absent side stays unknown instead of silently becoming SELL. */
function sideStrict(raw: unknown): Side | undefined {
  const t = str(raw).toUpperCase();
  if (t === 'B' || t === 'BUY') return 'BUY';
  if (t === 'S' || t === 'SELL') return 'SELL';
  return undefined;
}

const SEGMENTS: Record<string, string> = { E: 'EQ', D: 'FNO', C: 'CURRENCY', M: 'COMM' };
const PRODUCTS: Record<string, string> = { I: 'INTRADAY', C: 'CNC', M: 'MARGIN', F: 'MTF', B: 'BO', V: 'CO' };

/** Field names differ in case and style between Dhan's feeds (OrderNo / orderNo / orderId ...), so look them up loosely. */
const key = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
function fieldMap(raw: any): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const k of Object.keys(raw)) m.set(key(k), raw[k]);
  return m;
}
function first(m: Map<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    const v = m.get(n);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}
/** Dhan fills unset timestamps with 1980-01-01 / 0001-01-01; those are "no time", not a real time. */
const realTime = (v: unknown): string | undefined => {
  const t = str(v);
  return t && !/^(1980|0001|1970)/.test(t) ? t : undefined;
};

function legNoOf(m: Map<string, unknown>): number | null | undefined {
  const n = first(m, 'legno');
  if (n !== undefined) return num(n);
  const leg = str(first(m, 'legname')).toUpperCase();
  if (leg === 'ENTRY_LEG') return 1;
  if (leg === 'STOP_LOSS_LEG') return 2;
  if (leg === 'TARGET_LEG') return 3;
  return undefined;
}

/**
 * Accepts an order in ANY of the shapes Dhan produces:
 *  - REST order book row            (orderId, orderStatus, transactionType, orderType: LIMIT/STOP_LOSS...)
 *  - Order-update WebSocket "Data"  (OrderNo, Status, TxnType: B/S, OrderType: LMT/SL..., LegNo)
 *  - Postback payload               (same field names as the REST order book)
 * Only the fields actually present are returned (see OrderSnapIn). Returns null when there is no usable order id.
 */
export function normalizeOrder(raw: any): OrderSnapIn | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = fieldMap(raw);
  const orderId = str(first(m, 'orderid', 'orderno', 'ordernumber'));
  if (!orderId) return null;
  const out: OrderSnapIn = { orderId };

  const status = first(m, 'orderstatus', 'status', 'orderstate');
  if (status !== undefined) out.status = str(status).toUpperCase().replace(/[\s-]/g, '_');
  const side = sideStrict(first(m, 'transactiontype', 'txntype', 'side', 'buysell'));
  if (side) out.side = side;
  const kind = first(m, 'ordertype', 'ordtype');
  if (kind !== undefined) out.kind = kindOf(kind);
  const leg = legNoOf(m);
  if (leg !== undefined) out.legNo = leg;
  const symbol = str(first(m, 'tradingsymbol', 'symbol')).toUpperCase();
  if (symbol) out.symbol = symbol;
  const sec = str(first(m, 'securityid'));
  if (sec) out.securityId = sec;

  const exchSeg = first(m, 'exchangesegment');
  if (exchSeg !== undefined) out.segment = str(exchSeg);
  else {
    const seg = first(m, 'segment');
    if (seg !== undefined) out.segment = `${str(first(m, 'exchange')) || 'NSE'}_${SEGMENTS[str(seg).toUpperCase()] ?? str(seg)}`;
  }
  const productName = first(m, 'producttype', 'productname');
  const productCode = first(m, 'product');
  const product = productName !== undefined ? str(productName) : productCode !== undefined ? PRODUCTS[str(productCode).toUpperCase()] || str(productCode) : '';
  if (product) out.product = product.toUpperCase();

  const trig = first(m, 'triggerprice'); if (trig !== undefined) out.triggerPrice = num(trig);
  const price = first(m, 'price'); if (price !== undefined) out.price = num(price);
  const qty = first(m, 'quantity', 'qty'); if (qty !== undefined) out.qty = num(qty);
  const filled = first(m, 'filledqty', 'tradedqty', 'tradedquantity'); if (filled !== undefined) out.filledQty = num(filled);

  const created = realTime(first(m, 'createtime', 'orderdatetime'));
  if (created) out.createTime = created;
  const updated = realTime(first(m, 'updatetime', 'lastupdatedtime')) ?? created;
  if (updated) out.updateTime = updated;
  return out;
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
export function snapsFromPayload(body: any): OrderSnapIn[] {
  const items: any[] = Array.isArray(body) ? body : [body];
  const out: OrderSnapIn[] = [];
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
  known: Map<string, TrackedOrder>, snaps: OrderSnapIn[], src: string, nowMs: number,
): ApplyResult {
  const events: OrderEvent[] = [];
  const updated = new Map<string, TrackedOrder>();

  for (const s of snaps) {
    const prev = updated.get(s.orderId) ?? known.get(s.orderId);
    // A partial frame about an order we have never seen cannot tell us which side it is on: let the poll create it.
    if (!prev && !s.side) continue;

    const sTs = s.updateTime ? parseIst(s.updateTime) : NaN;
    const ts = Number.isFinite(sTs) ? sTs : nowMs;
    if (prev) {
      const pTs = parseIst(prev.updateTime);
      if (Number.isFinite(pTs) && Number.isFinite(sTs) && sTs < pTs) continue; // stale
    }

    // Merge: only what the feed really sent replaces what we know.
    const merged: Omit<TrackedOrder, 'history' | 'version' | 'src'> = {
      orderId: s.orderId,
      status: s.status ?? prev?.status ?? '',
      side: (s.side ?? prev?.side) as Side,
      kind: s.kind ?? prev?.kind ?? 'OTHER',
      legNo: s.legNo !== undefined ? s.legNo : prev?.legNo ?? null,
      symbol: s.symbol || prev?.symbol || '',
      securityId: s.securityId || prev?.securityId || '',
      segment: s.segment ?? prev?.segment ?? '',
      product: s.product ?? prev?.product ?? '',
      triggerPrice: s.triggerPrice ?? prev?.triggerPrice ?? 0,
      price: s.price ?? prev?.price ?? 0,
      qty: s.qty ?? prev?.qty ?? 0,
      filledQty: s.filledQty ?? prev?.filledQty ?? 0,
      createTime: s.createTime || prev?.createTime || '',
      updateTime: s.updateTime ?? prev?.updateTime ?? '',
    };

    const notes: string[] = [];
    if (!prev) {
      notes.push('NEW');
    } else {
      if (prev.status !== merged.status) notes.push(`STATUS ${prev.status}→${merged.status}`);
      if (prev.triggerPrice !== merged.triggerPrice) notes.push(`TRIGGER ${prev.triggerPrice}→${merged.triggerPrice}`);
      if (prev.price !== merged.price) notes.push(`PRICE ${prev.price}→${merged.price}`);
      if (prev.qty !== merged.qty) notes.push(`QTY ${prev.qty}→${merged.qty}`);
      if (prev.filledQty !== merged.filledQty) notes.push(`FILLED ${prev.filledQty}→${merged.filledQty}`);
      if (prev.side !== merged.side) notes.push(`SIDE ${prev.side}→${merged.side}`);
      if (prev.kind !== merged.kind && merged.kind !== 'OTHER') notes.push(`KIND ${prev.kind}→${merged.kind}`);
    }
    if (notes.length === 0) continue;

    const point = { ts, status: merged.status, trigger: merged.triggerPrice, price: merged.price, qty: merged.qty, filled: merged.filledQty };
    const history = [...(prev?.history ?? []), point].slice(-HISTORY_CAP);
    const next: TrackedOrder = { ...merged, history, version: (prev?.version ?? 0) + 1, src };
    updated.set(s.orderId, next);
    events.push({
      key: `${merged.orderId}|${merged.updateTime}|${merged.status}|${merged.triggerPrice}|${merged.price}|${merged.qty}|${merged.filledQty}`,
      ts, date: istDateKey(ts), orderId: merged.orderId, symbol: next.symbol, side: merged.side, kind: merged.kind,
      status: merged.status, trigger: merged.triggerPrice, price: merged.price, qty: merged.qty, filled: merged.filledQty,
      src, note: notes.join('; '),
    });
  }
  return { events, updated: [...updated.values()] };
}

/* ------------------------------------------------------------ trade analysis */

const isStop = (k: OrderKind) => k === 'SL' || k === 'SLM';
/**
 * A stop that has fired is shown by Dhan as a plain MARKET order (the "SL" badge in the order book), so the kind alone
 * is not enough: any order that ever carried a trigger price was a stop, whatever it turned into.
 */
const stopLike = (o: TrackedOrder) => isStop(o.kind) || o.history.some((h) => h.trigger > 0);

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

  const inWindow = (o: TrackedOrder) => o.history.length > 0 && o.history[0].ts >= startTs && o.history[0].ts <= endTs;
  // Orders the feed told us about without a symbol (older partial frames): theirs if the size matches the open position then.
  const orphanFits = (o: TrackedOrder) => {
    if (o.symbol || !inWindow(o)) return false;
    const q = positionAt(g, o.history[0].ts).qty;
    return q > 0 && o.qty === q;
  };
  const mine = orders.filter((o) =>
    inWindow(o) && ((o.symbol === g.symbol && o.side === closing) || orphanFits(o)));

  const meta: TradeMeta = { stopMoves: 0, tpMoves: 0, exitType: 'UNKNOWN', ordersSeen: mine.length };

  // A limit order that was first placed on the losing side of the position is a stop-limit (the feed may give only its
  // price, no trigger); it stays a stop even if it is later trailed into profit.
  const lossSide = (price: number, avg: number) => (g.direction === 'LONG' ? price < avg : price > avg);
  const limitStop = (o: TrackedOrder) => {
    if (isStop(o.kind) || o.history.some((h) => h.trigger > 0)) return false;
    const h = o.history.find((x) => x.price > 0);
    // a resting order only: an order that was already filled when first seen is just an exit, not a stop
    return !!h && h.filled === 0 && h.status !== 'TRADED' && lossSide(h.price, positionAt(g, h.ts).avgCost || g.avgEntry);
  };
  const stopLevel = (o: TrackedOrder, h: { trigger: number; price: number }) => (h.trigger > 0 ? h.trigger : limitStop(o) ? h.price : 0);

  // ---- stops
  const stopPts = mine.filter((o) => stopLike(o) || limitStop(o))
    .flatMap((o) => o.history.map((h) => ({ ...h, qty: o.qty, level: stopLevel(o, h) })))
    .filter((h) => h.level > 0)
    .sort((a, b) => a.ts - b.ts);
  if (stopPts.length > 0) {
    const path = dedupeConsecutive(stopPts.map((p) => p.level));
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
  const tpPts = mine.filter((o) => o.kind === 'LIMIT' && !limitStop(o))
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
      if (stopLike(ord)) t = 'STOP';
      else if (ord.kind === 'LIMIT') t = profitSide(ord.price, g.avgEntry) ? 'TARGET' : 'MANUAL';
      else if (ord.kind === 'MARKET') t = 'MANUAL';
    }
    // Still not a stop by its own record? If it filled at or beyond where your stop was sitting, the stop is what closed it.
    if (t !== 'STOP' && last && meta.lastStop !== undefined) {
      const px = last.fill.price, tol = meta.lastStop * 0.0003;
      const crossed = g.direction === 'LONG' ? px <= meta.lastStop + tol : px >= meta.lastStop - tol;
      if (crossed) t = 'STOP';
    }
    meta.exitType = t;
  }
  return meta;
}
