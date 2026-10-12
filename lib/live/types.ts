// Shared types for live capture, grouping, and enrichment.

export type Side = 'BUY' | 'SELL';
export type Direction = 'LONG' | 'SHORT';
export type OrderKind = 'LIMIT' | 'MARKET' | 'SL' | 'SLM' | 'OTHER';

/** One execution (a row of Dhan's trade book). */
export interface Fill {
  tradeId: string;       // exchangeTradeId
  orderId: string;
  symbol: string;
  securityId: string;
  segment: string;       // e.g. NSE_EQ
  side: Side;
  qty: number;
  price: number;
  ts: number;            // epoch ms
  time: string;          // "YYYY-MM-DD HH:mm:ss" IST, as Dhan reports it
}

/** A slice of a fill that belongs to one trade group (a fill that flips the position is split in two). */
export interface FillPart {
  fill: Fill;
  qty: number;
  partId: string;        // tradeId, or tradeId~1 / tradeId~2 when split
}

export interface TradeGroup {
  id: string;
  date: string;          // IST date of the first fill
  symbol: string;
  securityId: string;
  segment: string;
  direction: Direction;  // from the FIRST fill, never from a manual toggle
  status: 'OPEN' | 'CLOSED';
  netQty: number;        // signed: + long, - short, 0 when closed
  avgCost: number;       // average price of the quantity still open (entry avg once closed)
  avgEntry: number;      // volume-weighted average of every entry-side fill
  avgExit: number;       // volume-weighted average of every exit-side fill (0 if none yet)
  peakQty: number;       // largest open quantity at any point
  adds: number;          // entry-side fills after the first
  realizedGross: number; // gross P&L booked so far (average-cost method)
  buyQty: number; sellQty: number; buyVal: number; sellVal: number;
  entryTs: number;
  lastTs: number;
  parts: FillPart[];
}

/** Canonical order snapshot, whichever feed (REST, WebSocket, postback) it came from. */
export interface OrderSnap {
  orderId: string;
  status: string;        // PENDING, TRANSIT, TRADED, CANCELLED, REJECTED, EXPIRED, PART_TRADED, ...
  side: Side;
  kind: OrderKind;
  legNo: number | null;
  symbol: string;
  securityId: string;
  segment: string;
  product: string;
  triggerPrice: number;
  price: number;
  qty: number;
  filledQty: number;
  createTime: string;    // IST string
  updateTime: string;    // IST string
}

export interface OrderHistoryPoint { ts: number; status: string; trigger: number; price: number; qty: number; filled: number }

/** An order plus the changes we have seen it go through. */
export interface TrackedOrder extends OrderSnap {
  history: OrderHistoryPoint[];
  version: number;
  src: string;
}

export interface OrderEvent {
  key: string;
  ts: number;
  date: string;
  orderId: string;
  symbol: string;
  side: Side;
  kind: OrderKind;
  status: string;
  trigger: number;
  price: number;
  qty: number;
  filled: number;
  src: string;
  note: string;
}

export type ExitType = 'STOP' | 'TARGET' | 'MANUAL' | 'UNKNOWN';

export interface TradeMeta {
  initialStop?: number;
  initialStopDist?: number;  // per share, vs the average cost at the moment the stop was first placed
  riskInr?: number;          // initialStopDist x quantity open at that moment
  lastStop?: number;
  stopMoves: number;
  tpFirst?: number;
  tpLast?: number;
  tpMoves: number;
  exitType: ExitType;
  ordersSeen: number;
}

export interface Pnl {
  grossPnL: number;
  netPnL: number;
  totalCharges: number;
  durationSec: number;
  status: 'WIN' | 'LOSS';
  isConsistent: boolean;
  buyQty: number;
  sellQty: number;
}
