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

/**
 * Market context at your actual first fill, filled by Backfill for every trade (also ones logged before the co-pilot
 * existed). They land to the right of Setup on existing sheets, so they are always written by column name.
 */
export const MONTHLY_CONTEXT_COLS = [
  'OrHigh', 'OrLow', 'EntryVsOr', 'PdhDistAtr', 'PdlDistAtr',
  'Ema200_5mAtr', 'Ema200_10mAtr', 'Ema200_1dAtr', 'RsVsNiftyPct', 'ExtAdrPct', 'PocDistAtr',
  'PullbackNo', 'VolTrend', 'ContextStatus',
] as const;

/** Co-pilot: the entry check (Ck...) and a summary of in-trade re-checks (Rc...), copied on when the trade is logged. */
export const MONTHLY_COPILOT_COLS = [
  'CkTime', 'CkNiftyState', 'CkNiftyFirst5Pct', 'CkNiftyNowPct', 'CkRvolDay',
  'CkEma200_5mAtr', 'CkEma200_10mAtr', 'CkEma200_1dAtr', 'CkEma200InPath',
  'CkEntryVsOr', 'CkPdhDistAtr', 'CkPdlDistAtr', 'CkVwapSide', 'CkRsVsNiftyPct', 'CkRs20mPct', 'CkExtAdrPct',
  'CkPocDistAtr', 'CkPullbackNo', 'CkVolTrend', 'CkPushVsPullVol', 'CkClimax', 'CkFailedBreak',
  'CkStopVsAtr2', 'CkRoomVsStop', 'CkEstChargesInr', 'CkFirstTradeLost', 'CkSameSymbolStopped', 'CkMinSinceLoss',
  'CkId', 'CkVerdict', 'CkLines', 'CkWatch', 'CkDecision', 'CkPromptVersion', 'CkModel', 'CkCostInr',
  'RcCount', 'RcLastTime', 'RcLastLabel', 'RcLastLines', 'RcLastWatch', 'RcCostInr',
] as const;

export const MONTHLY_EXTRA = [...MONTHLY_LIVE_COLS, ...MONTHLY_ENRICH_COLS, ...MONTHLY_CONTEXT_COLS, ...MONTHLY_COPILOT_COLS] as const;
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

/**
 * One row per co-pilot check (taken or skipped), in a tab per month: "october-2026-checks".
 * Journal and Stats read only tabs named exactly "october-2026", so they never see it.
 */
export const checksTabTitle = (monthTitle: string) => `${monthTitle}-checks`;

export const COPILOT_CHECK_COLS = [
  'CheckId', 'Date', 'Time', 'CreatedAt', 'Symbol', 'SecurityId', 'Direction', 'Setup', 'Mode', 'PlannedStop', 'Ltp', 'LtpSource',
  // market
  'NiftyFirst5Pct', 'NiftyNowPct', 'NiftyLast10Pct', 'NiftyState',
  // stock
  'RvolDay', 'Atr10m', 'Atr2', 'Ema200_5mAtr', 'Ema200_10mAtr', 'Ema200_1dAtr', 'Ema200InPath',
  'OrHigh', 'OrLow', 'EntryVsOr', 'PdhDistAtr', 'PdlDistAtr', 'VwapSide', 'VwapHeldMin',
  'RsVsNiftyPct', 'Rs20mPct', 'ExtAdrPct', 'PocPrice', 'PocDistAtr', 'PullbackNo', 'VolTrend', 'PushVsPullVol',
  'Climax', 'FailedBreak',
  // plan
  'StopDist', 'StopVsAtr2', 'SizeQty', 'RiskInr', 'RoomAtr', 'RoomVsStop', 'EstChargesInr',
  // you
  'TradesToday', 'PnlToday', 'FirstTradeLost', 'SameSymbolStopped', 'MinSinceLoss', 'SetupTrades', 'SetupWinRate', 'SetupAvgPnl',
  // in trade (MANAGE rows only)
  'AvgEntry', 'CurrentStop', 'OpenR', 'BestR', 'GivebackR', 'StopDistAtr', 'CounterVolRatio', 'ClimaxAgainst', 'FailedExtreme',
  'NiftySinceEntryPct', 'MinInTrade', 'StopMoves',
  // Claude
  'Status', 'Model', 'PromptVersion', 'Verdict', 'Line1', 'Line2', 'Line3', 'Watch',
  'InTokens', 'OutTokens', 'CostInr', 'LatencyMs', 'Error',
  // you, after
  'Decision', 'TradeGroupId',
  // what happened next (Backfill)
  'AfterMfeR30', 'AfterMaeR30', 'AfterHitStop',
  'Notes', 'PayloadJson',
  // added later (land on the right of existing tabs)
  'RoomTo', 'DayHigh', 'DayLow', 'Ema200_5m', 'Ema200_10m', 'Ema200_1d',
  'RvolSameTime', 'RvolBusy',
  'StopIdea', 'AltDirection', 'AltSetup', 'AltStop', 'AltReason',
  'MoveToday', 'SetupByMove', 'CoreMet', 'CoreMissing', 'FitsNow',
  'Poc2d', 'Vwap', 'Scenarios',
  'NiftyNowTrend', 'PendingEntry', 'PendingStop', 'PendingTarget', 'RewardRisk', 'TargetPastObstacle', 'CurrentTarget',
  'Stretch', 'StretchDir', 'StretchRunPct', 'StretchVwapAtr', 'Nifty20mPct', 'NiftyVsStock',
  'EntryTiming', 'EntryLevel', 'EntryLevelName', 'EntryInvalid', 'EntryInvalidName', 'EntryWhy',
  'PendingAddPrice', 'PendingAddQty',
] as const;

/** live-trades.Status values */
export type LiveStatus = 'OPEN' | 'CLOSED' | 'LOGGED' | 'DUPLICATE' | 'STALE';
