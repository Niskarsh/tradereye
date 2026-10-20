/**
 * The setups that are backtested and alerted on. One list, used by the backtest job, the My Setups page and the
 * live alerts, so a name or a rule can never differ between them.
 *
 * Every case is measured on the 10-minute chart as he trades it, from 1-minute candles, using only candles that were
 * complete at the decision minute. A case fires at most once per stock, per day and per direction (its first moment).
 */

export type CaseId =
  | 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8' | 'M9'
  | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8';

export type Family = 'MOMENTUM' | 'REVERSAL';

export interface CaseInfo {
  id: CaseId;
  family: Family;
  name: string;
  /** the rule in plain words (shown on the page) */
  rule: string;
  /** what the structural target is (momentum cases use 2R) */
  target: string;
}

export const CASES: CaseInfo[] = [
  { id: 'M1', family: 'MOMENTUM', name: '10-min opening range break', target: '2R',
    rule: 'Price breaks the first 10-min candle (09:15-09:24) high (long) or low (short), with Nifty 500 his way.' },
  { id: 'M2', family: 'MOMENTUM', name: '30-min opening range break', target: '2R',
    rule: 'Price breaks the 09:15-09:44 high or low (from 09:45), with Nifty 500 his way.' },
  { id: 'M3', family: 'MOMENTUM', name: 'Gap and go', target: '2R',
    rule: 'Gap of 0.5%+ in the direction of Nifty\'s first 5 minutes; the first 10-min candle closes the gap\'s way without filling it. Entry 09:25.' },
  { id: 'M4', family: 'MOMENTUM', name: 'Trend pullback that holds', target: '2R',
    rule: 'Stock 30%+ of its daily range his way, pulls back 0.5 ATR+ to the first 10-min candle edge, today\'s POC or a crossed previous-day level, holds, and turns back (1-min close beyond the previous minute).' },
  { id: 'M5', family: 'MOMENTUM', name: 'Relative strength vs Nifty', target: '2R',
    rule: 'Over 20 minutes Nifty 500 dips 0.1%+ while the stock holds (long; mirror for short), then Nifty turns back his way and the stock is at its 20-minute extreme.' },
  { id: 'M6', family: 'MOMENTUM', name: 'Previous day high/low break that holds', target: '2R',
    rule: 'A 10-min candle closes beyond the previous day\'s high (low) and the next 10-min candle closes beyond it too, with Nifty 500 his way.' },
  { id: 'M7', family: 'MOMENTUM', name: 'Squeeze then expansion', target: '2R',
    rule: 'Three 10-min candles each narrower than 0.6 ATR, then price breaks their range, with Nifty 500 his way.' },
  { id: 'M8', family: 'MOMENTUM', name: 'Value area acceptance', target: '2R',
    rule: 'Opened inside yesterday\'s value area; two 10-min closes in a row outside it, with Nifty 500 his way.' },
  { id: 'M9', family: 'MOMENTUM', name: 'Wait for the pullback (vs M1/M2 entry now)', target: '2R',
    rule: 'Same moments as M1/M2 with Nifty strong (0.3%+ his way): instead of entering now, a limit order 0.5 ATR back, same stop, valid 30 minutes. Not filled = no trade.' },
  { id: 'R1', family: 'REVERSAL', name: 'Overextension reversal', target: 'POC',
    rule: 'Stock 50%+ of its daily range from the open, price in the day high (low) zone, and the 1-min close turns against the run. Target today\'s POC (2-day POC before 10:15).' },
  { id: 'R2', family: 'REVERSAL', name: 'Opening range failure', target: 'Other side of the first 10-min candle',
    rule: 'Price breaks the first 10-min candle by 0.1 ATR+, then within 20 minutes closes back inside.' },
  { id: 'R3', family: 'REVERSAL', name: 'Gap fill', target: 'Previous close',
    rule: 'Gap of 0.5%+, quieter than usual, Nifty\'s first 5 minutes not with the gap, first 10-min candle closes against the gap. Entry 09:25.' },
  { id: 'R4', family: 'REVERSAL', name: 'Volume climax, then stall', target: 'POC',
    rule: 'A 10-min candle with 3x normal volume makes a new day high (low); the next 10-min candle makes no new extreme and closes against the run.' },
  { id: 'R5', family: 'REVERSAL', name: 'Value area edge rejection', target: 'Yesterday\'s POC',
    rule: 'Opened inside yesterday\'s value area; a 10-min candle pokes beyond its edge and closes back inside.' },
  { id: 'R6', family: 'REVERSAL', name: 'Previous day high/low rejection', target: 'POC',
    rule: 'Opened below the previous day\'s high (above its low); a 10-min candle trades beyond it and closes back.' },
  { id: 'R7', family: 'REVERSAL', name: 'Failed momentum (high rvol reversing)', target: 'POC',
    rule: 'A busy stock (1.5x usual volume) running 30%+ of its range with Nifty, then falls back 1 ATR from its extreme. Tests the "skip a high-rvol stock that starts reversing" rule.' },
  { id: 'R8', family: 'REVERSAL', name: 'VWAP reversion (belief check)', target: 'VWAP',
    rule: 'Price 1.5 ATR+ from VWAP and the 1-min close turns back toward it.' },
];

export const CASE_BY_ID = new Map(CASES.map((c) => [c.id, c]));

/** The target the hit rate is quoted for: momentum 1R (small chunks), reversal the structural level. */
export type TargetKey = 'T1' | 'T15' | 'TS';
export const PRIMARY_TARGET: Record<Family, TargetKey> = { MOMENTUM: 'T1', REVERSAL: 'TS' };
export const TARGET_LABEL: Record<TargetKey, string> = { T1: '1R', T15: '1.5R', TS: 'Structure' };

/* ---- the slices every signal carries ---------------------------------------------------------------------- */

export type Rel = 'WITH' | 'AGAINST' | 'FLAT';
export type TimeBucket = '09:20-09:45' | '09:45-11:00' | '11:00-13:00' | '13:00-15:00';
export type RvolBucket = 'LOW' | 'NORMAL' | 'HIGH';

export interface Signal {
  case: CaseId;
  symbol: string;
  date: string;
  /** minute of the session the decision was made (0 = 09:15); entry at the close of the minute before */
  slot: number;
  dir: 1 | -1;
  entry: number;
  stop: number;
  /** price of the structural target (momentum: 2R) */
  target: number;
  stopAtr: number;
  /** 10-min ATR(14) at the decision */
  atr: number;
  /** the stop had to be pulled in to 2x ATR */
  capped: boolean;
  /* slices */
  time: TimeBucket;
  /** Nifty 500 first 5 minutes, relative to the trade */
  nFirst5: Rel;
  /** Nifty 500 open -> decision minute, relative to the trade; 'EARLY' before 09:30 */
  nDay: Rel | 'EARLY';
  /** Nifty 500 in the 30 minutes before the decision, relative to the trade; 'EARLY' before 09:46 */
  nRecent: Rel | 'EARLY';
  /** volume so far vs the same time of day over the last 10 sessions */
  rvol: RvolBucket;
  /** his open rule: TradingView relative volume at 09:20 above 0.1 */
  openBusy: boolean;
  /**
   * How far the move has gone, in % of the 10-day average daily range, from the open. Momentum: the move his way
   * (negative = the stock is against him on the day). Reversal: the run being faded.
   */
  stretch: number;
  /** a 200 EMA (5m, 10m or 1D) within 2 ATR in the trade's path */
  emaInWay: boolean;
  gapPct: number;
  /** other cases that fired the same way on the same stock in the 30 minutes before (or at) this one */
  with: CaseId[];
  /* outcome (backtest only) */
  out?: Outcome;
}

export interface TargetResult {
  /** target reached before the stop */
  hit: boolean;
  /** result in R before charges (target R, -1 at the stop, or wherever price was at 15:00) */
  r: number;
  /** after Dhan's charges */
  net: number;
  /** minutes in the trade */
  min: number;
}
export interface Outcome {
  T1: TargetResult; T15: TargetResult; TS: TargetResult;
  /** best / worst move in R before the stop or 15:00 */
  mfe: number; mae: number;
  /** charges in R */
  costR: number;
  /** M9 only: the limit order was filled */
  filled?: boolean;
}

export function timeBucket(slot: number): TimeBucket {
  if (slot < 30) return '09:20-09:45';
  if (slot < 105) return '09:45-11:00';
  if (slot < 225) return '11:00-13:00';
  return '13:00-15:00';
}

/** Stretch buckets (in % of the average daily range). Reversal pages also show them cumulatively (50%+, 60%+ ...). */
export const STRETCH_EDGES = [0, 30, 50, 60, 70, 80, 90, 95];
export function stretchBucket(s: number): string {
  if (s < 0) return '<0';
  let label = '0-30';
  for (let i = 0; i < STRETCH_EDGES.length; i++) {
    const lo = STRETCH_EDGES[i], hi = STRETCH_EDGES[i + 1];
    if (s >= lo) label = hi === undefined ? `${lo}+` : `${lo}-${hi}`;
  }
  return label;
}
export const STRETCH_CUMULATIVE = [50, 60, 70, 80, 90, 95];
