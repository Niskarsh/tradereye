/**
 * Column layout.
 *
 * MONTHLY_BASE are the columns the app already writes (unchanged, same order, never touched).
 * MONTHLY_EXTRA are added to the RIGHT of them, automatically, the first time live logging or backfill
 * touches a monthly sheet (see SheetsClient.ensureTab). Nothing needs to be added to the sheet by hand.
 */

export const MONTHLY_BASE = [
  'TradeGroupId', 'Date (IST)', 'Symbol', 'Direction', 'OrderType',
  'Price', 'Qty', 'GrossPnL', 'NetPnL', 'TotalCharges',
  'Status', 'Time (IST)', 'Duration (Sec)', 'IsConsistent', 'ExchTradeId',
  'Comment', 'ScreenshotUrl',
] as const;

/** Captured live (from your orders and fills). Group-level values repeat on every fill row, like NetPnL does. */
export const MONTHLY_LIVE_COLS = [
  'Source',            // AUTO for trades logged by live capture; blank/MANUAL for ones you synced by hand
  'SecurityId',
  'EntryTime',         // HH:mm:ss of the first fill
  'ExitTime',          // HH:mm:ss of the last fill
  'AvgEntry',
  'AvgExit',
  'PeakQty',
  'AddCount',          // entries added after the first
  'InitialStop',       // trigger price of the first stop-loss order you placed
  'InitialStopDist',   // per-share distance from average cost to that stop (your real risk)
  'RiskInr',           // InitialStopDist x quantity open when the stop was placed
  'LastStop',          // where the stop ended up
  'StopMoves',         // how many times the stop price changed
  'TpFirst',           // first target (limit order on the profit side) you showed
  'TpLast',
  'ExitType',          // STOP / TARGET / MANUAL / UNKNOWN
  'DirFromFills',      // direction derived from the first fill (the Direction column can be wrong when set by hand)
] as const;

/** Filled by the backfill route from market data (needs the Dhan Data API plan active while it runs). */
export const MONTHLY_ENRICH_COLS = [
  'Nifty500First5Pct', 'Nifty500AtEntryPct',
  'Rvol5', 'RvolAtEntry', 'RvolDay5', 'RvolDayAtEntry',
  'Atr10m', 'Atr2',
  'ChgPrevClosePct', 'GapPct', 'VwapDistPct',
  'MfePct', 'MaePct', 'MfeR', 'MaeR', 'RBasis',
  'EnrichStatus',      // OK / PARTIAL / FAILED: reason
  'EnrichedAt',
  'Setup',             // left blank for you to fill in (momentum / reversal) whenever you like
] as const;

export const MONTHLY_EXTRA = [...MONTHLY_LIVE_COLS, ...MONTHLY_ENRICH_COLS] as const;
export const MONTHLY_ALL = [...MONTHLY_BASE, ...MONTHLY_EXTRA] as const;

/* ---- tabs used only by live capture (created automatically; analytics ignores them) ---------- */

export const TAB_ORDER_STATE = 'order-state';
export const TAB_ORDER_EVENTS = 'order-events';
export const TAB_LIVE_TRADES = 'live-trades';

export const ORDER_STATE_COLS = [
  'OrderId', 'Date', 'Symbol', 'SecurityId', 'Segment', 'Side', 'Kind', 'Product', 'LegNo',
  'Status', 'Trigger', 'Price', 'Qty', 'Filled', 'CreateTime', 'UpdateTime', 'Version', 'Src', 'History',
] as const;

export const ORDER_EVENT_COLS = [
  'EventKey', 'Time', 'Date', 'OrderId', 'Symbol', 'Side', 'Kind', 'Status', 'Trigger', 'Price', 'Qty', 'Filled', 'Src', 'Note',
] as const;

export const LIVE_TRADE_COLS = [
  'GroupId', 'Date', 'Symbol', 'SecurityId', 'Direction', 'Status', 'NetQty', 'AvgCost', 'RealizedGross', 'Adds',
  'EntryTime', 'LastTime', 'InitialStop', 'LastStop', 'StopMoves', 'TpLast', 'RiskInr', 'FillCount', 'FillKeys',
  'FinalizedAt', 'UpdatedAt', 'Note',
] as const;

/** live-trades.Status values */
export type LiveStatus = 'OPEN' | 'CLOSED' | 'LOGGED' | 'DUPLICATE' | 'STALE';
