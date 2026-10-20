/**
 * The setups that are backtested and alerted on. One list, used by the backtest job, the My Setups page and the
 * live alerts, so a name or a rule can never differ between them.
 *
 * Everything is decided on the 10-minute chart, as he trades it: a setup can only appear when a 10-minute candle
 * closes, the entry is that close, and stops come from 10-minute structure. 1-minute candles are used only behind
 * the scenes, to know whether the stop or the target was reached first inside a 10-minute candle.
 * A case fires at most once per stock, per day and per direction (its first moment).
 */

export type CaseId =
  | 'L1' | 'L2' | 'FB' | 'S1' | 'D1' | 'D2' | 'D3' | 'D4'
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'I' | 'J' | 'K'
  | 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8' | 'M9'
  | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8';

export type Family = 'MOMENTUM' | 'REVERSAL';
/**
 * DELIVERY = multi-day delivery trades (daily candles, held for days or weeks);
 * RESEARCH = intraday strategies from published research / institutional practice; COMBINED = several conditions together
 * (his way of trading); BLOCK = one condition on its own (building block)
 */
export type Group = 'DELIVERY' | 'RESEARCH' | 'COMBINED' | 'BLOCK';

export interface CaseInfo {
  id: CaseId;
  family: Family;
  group: Group;
  name: string;
  /** the rule in plain words (shown on the page) */
  rule: string;
  /** what the structural target is (momentum cases use 2R) */
  target: string;
  /** the exit the headline hit rate is quoted for, when not the family's default */
  primary?: OutKey;
  /** where the evidence comes from (research cases) */
  source?: string;
}

const MOM_CONTEXT = 'Nifty 500 directional his way in the first 5 minutes and still his way open → now, the stock busier than usual, no 200 EMA (5m/10m/1D) within 2 ATR in the way, the stock 10%+ of its daily range his way and under 80%.';
const REV_CONTEXT = 'A quiet stock (not busier than usual), 50%+ of its daily range moved, the 10-min candle in the day high (low) zone, Nifty 500 flat or turning against the stock over the last 30 minutes, no 200 EMA between price and the target.';

export const CASES: CaseInfo[] = [
  // ---- delivery: daily candles, held for days or weeks, long only, delivery charges
  { id: 'D1', family: 'MOMENTUM', group: 'DELIVERY', name: 'Momentum, 6 and 12 months (monthly)', target: 'Held to the next month-end', primary: 'TC',
    source: 'Jegadeesh & Titman momentum; the scoring NSE\'s Nifty200 Momentum 30 index uses (6- and 12-month returns per unit of volatility)',
    rule: 'At each month-end, the 10 stocks in the price range with the best average of their 6- and 12-month returns per unit of volatility (12-month return above 0) are bought at the close and sold at the next month-end close. Stop 3x the daily ATR.' },
  { id: 'D2', family: 'MOMENTUM', group: 'DELIVERY', name: 'Near the 52-week high (monthly)', target: 'Held to the next month-end', primary: 'TC',
    source: 'George & Hwang (2004): stocks near their 52-week high keep outperforming',
    rule: 'At each month-end, the 10 stocks in the price range closest to their 52-week high (within 10%) are bought at the close and sold at the next month-end close. Stop 3x the daily ATR.' },
  { id: 'D3', family: 'REVERSAL', group: 'DELIVERY', name: 'RSI(2) pullback in an uptrend', target: 'First close above the 5-day average', primary: 'TC',
    source: 'Connors & Alvarez: short pullbacks inside long uptrends tend to bounce',
    rule: 'Close above the 200-day average and the 2-day RSI under 10: bought at the close, sold at the first close above the 5-day average (at most 10 sessions). Stop 3x the daily ATR.' },
  { id: 'D4', family: 'MOMENTUM', group: 'DELIVERY', name: 'Trend breakout (55-day high)', target: 'Close below the 20-day low', primary: 'TC',
    source: 'Donchian / turtle trend following',
    rule: 'Close above the 55-day high and above the 200-day average: bought at the close, sold on a close below the 20-day low (at most 60 sessions). Stop 2x the daily ATR.' },

  // ---- research: published / institutional strategies (no opening range breakout: nothing before 09:25)
  { id: 'L1', family: 'MOMENTUM', group: 'RESEARCH', name: 'Last half hour follows the first', target: 'Held to 15:29', primary: 'TC',
    source: 'Gao, Han, Li, Zhou: Market intraday momentum (the first half hour predicts the last half hour)',
    rule: 'Nifty 500 moved 0.1%+ in its first 30 minutes (09:15-09:44). At 15:00, trade the stocks that moved the same way both in their own first 30 minutes and from the open to 15:00. Entry at 15:00, out at the 15:29 close. Safety stop 1 ATR.' },
  { id: 'L2', family: 'REVERSAL', group: 'RESEARCH', name: 'End-of-day reversal', target: 'Held to 15:29', primary: 'TC',
    source: 'Baltussen, Da, Soebhag (Quantpedia Awards 2025): stocks that did badly during the day rebound into the close, strong ones fall',
    rule: 'At 15:00, a stock 1.5%+ worse than Nifty 500 since the open is bought (1.5%+ better is sold). Out at the 15:29 close. Safety stop 1 ATR.' },
  { id: 'FB', family: 'REVERSAL', group: 'RESEARCH', name: 'Breakout fade', target: '2R', primary: 'T1',
    source: 'His own backtest: breakouts in this price range reach 1R less often than random entries',
    rule: 'Whenever a breakout setup appears (A, G, I, M1, M2, M6, M7), the opposite trade at the same 10-min close, stop beyond the nearest solid swing on the other side.' },
  { id: 'S1', family: 'REVERSAL', group: 'DELIVERY', name: '5-day reversal (delivery, 5 days)', target: 'Held 5 sessions', primary: 'TC',
    source: 'Short-term reversal (Jegadeesh 1990, Lehmann 1990): last week\'s biggest losers tend to bounce',
    rule: 'At the close, a stock down 7%+ over the last 5 sessions and 4%+ worse than Nifty 500 is bought (delivery; long only). Out at the close 5 sessions later. Stop 2x the daily ATR. Delivery charges (STT 0.1% both sides, DP charge).' },

  // ---- combined: his playbook
  { id: 'A', family: 'MOMENTUM', group: 'COMBINED', name: 'Momentum, Nifty-led', target: '2R',
    rule: `${MOM_CONTEXT} Trigger: a 10-min close beyond the day's high (low) or the first 10-min candle.` },
  { id: 'B', family: 'MOMENTUM', group: 'COMBINED', name: 'Momentum pullback', target: '2R',
    rule: `${MOM_CONTEXT} Trigger: price pulled back to the first 10-min candle edge, a crossed previous-day level or today's POC, and the next 10-min candle closes back beyond the previous candle's high (low). Split by pullback number.` },
  { id: 'C', family: 'MOMENTUM', group: 'COMBINED', name: 'Momentum with relative strength', target: '2R',
    rule: `${MOM_CONTEXT} Plus: over the last 30 minutes Nifty went against him while the stock held, and this 10-min candle closes at the stock's 30-minute extreme.` },
  { id: 'D', family: 'REVERSAL', group: 'COMBINED', name: 'Reversal at the extreme', target: 'POC',
    rule: `${REV_CONTEXT} Trigger: a rejection candle: the 10-min candle reaches into the zone and closes in its lower (upper) half. Target today's POC (2-day POC before 10:15).` },
  { id: 'E', family: 'REVERSAL', group: 'COMBINED', name: 'Reversal after a failed break', target: 'POC',
    rule: `${REV_CONTEXT} Trigger: a 10-min candle trades beyond the day's high (low), the previous day's high (low) or yesterday's value area edge and closes back inside. Split by which test of the day's high (low) it is: 1st, 2nd, 3rd+, and the time of each test.` },
  { id: 'F', family: 'REVERSAL', group: 'COMBINED', name: 'Reversal after exhaustion', target: 'POC',
    rule: `${REV_CONTEXT} Trigger: the previous 10-min candle had 3x normal volume and made a new extreme; this one makes no new extreme and closes against the run.` },
  { id: 'G', family: 'MOMENTUM', group: 'COMBINED', name: 'Opening drive', target: '2R',
    rule: 'The first two 10-min candles both close the same way, with the gap or Nifty\'s first 5 minutes that way and the stock busier than usual. Entry at the 09:35 close.' },
  { id: 'I', family: 'MOMENTUM', group: 'COMBINED', name: 'Narrow candle at the extreme, then break', target: '2R',
    rule: 'Stock 30-80% of its daily range his way with Nifty his way; a 10-min candle narrower than 0.5 ATR sits within 0.3 ATR of the day\'s high (low); the next 10-min candle closes beyond it.' },
  { id: 'J', family: 'REVERSAL', group: 'COMBINED', name: 'Divergence fade', target: 'POC',
    rule: 'Stock 50%+ of its daily range up while Nifty 500 is down 0.15%+ on the day and not turning up in the last 30 minutes: short on a 10-min close below the previous candle\'s low. Mirror for longs.' },
  { id: 'K', family: 'MOMENTUM', group: 'COMBINED', name: 'Afternoon trend pullback', target: '2R',
    rule: '13:00-14:30 only. A trend day: the stock 60%+ of its daily range his way with Nifty his way on the day; a pullback of 0.5 ATR+ and a 10-min close back beyond the previous candle\'s high (low).' },

  // ---- building blocks: one condition each
  { id: 'M1', family: 'MOMENTUM', group: 'BLOCK', name: '10-min opening range break', target: '2R',
    rule: 'A 10-min close beyond the first 10-min candle (09:15-09:24) high (low), with Nifty 500 his way.' },
  { id: 'M2', family: 'MOMENTUM', group: 'BLOCK', name: '30-min opening range break', target: '2R',
    rule: 'A 10-min close beyond the 09:15-09:44 high (low), with Nifty 500 his way.' },
  { id: 'M3', family: 'MOMENTUM', group: 'BLOCK', name: 'Gap and go', target: '2R',
    rule: 'Gap of 0.5%+ in the direction of Nifty\'s first 5 minutes; the first 10-min candle closes the gap\'s way without filling it. Entry 09:25.' },
  { id: 'M4', family: 'MOMENTUM', group: 'BLOCK', name: 'Trend pullback that holds', target: '2R',
    rule: 'Stock 30%+ of its daily range his way, pulls back 0.5 ATR+ to the first 10-min candle edge, today\'s POC or a crossed previous-day level, and a 10-min candle closes back beyond the previous candle\'s high (low).' },
  { id: 'M5', family: 'MOMENTUM', group: 'BLOCK', name: 'Relative strength vs Nifty', target: '2R',
    rule: 'Over 20 minutes Nifty 500 dips 0.1%+ while the stock holds (long; mirror for short), then Nifty turns back his way and the 10-min close is at the stock\'s 20-minute extreme.' },
  { id: 'M6', family: 'MOMENTUM', group: 'BLOCK', name: 'Previous day high/low break that holds', target: '2R',
    rule: 'A 10-min candle closes beyond the previous day\'s high (low) and the next 10-min candle closes beyond it too, with Nifty 500 his way.' },
  { id: 'M7', family: 'MOMENTUM', group: 'BLOCK', name: 'Squeeze then expansion', target: '2R',
    rule: 'Three 10-min candles each narrower than 0.6 ATR, then a 10-min close beyond their range, with Nifty 500 his way.' },
  { id: 'M8', family: 'MOMENTUM', group: 'BLOCK', name: 'Value area acceptance', target: '2R',
    rule: 'Opened inside yesterday\'s value area; two 10-min closes in a row outside it, with Nifty 500 his way.' },
  { id: 'M9', family: 'MOMENTUM', group: 'BLOCK', name: 'Wait for the pullback (vs M1/M2 entry now)', target: '2R',
    rule: 'Same moments as M1/M2 with Nifty strong (0.3%+ his way): instead of entering now, a limit order 0.5 ATR back, same stop, valid 30 minutes. Not filled = no trade.' },
  { id: 'R1', family: 'REVERSAL', group: 'BLOCK', name: 'Overextension reversal', target: 'POC',
    rule: 'Stock 50%+ of its daily range from the open, the 10-min candle in the day high (low) zone, and it closes below the previous candle\'s low (above its high). Target today\'s POC (2-day POC before 10:15).' },
  { id: 'R2', family: 'REVERSAL', group: 'BLOCK', name: 'Opening range failure', target: 'Other side of the first 10-min candle',
    rule: 'Price breaks the first 10-min candle by 0.1 ATR+, then within two 10-min candles closes back inside.' },
  { id: 'R3', family: 'REVERSAL', group: 'BLOCK', name: 'Gap fill', target: 'Previous close',
    rule: 'Gap of 0.5%+, quieter than usual, Nifty\'s first 5 minutes not with the gap, first 10-min candle closes against the gap. Entry 09:25.' },
  { id: 'R4', family: 'REVERSAL', group: 'BLOCK', name: 'Volume climax, then stall', target: 'POC',
    rule: 'A 10-min candle with 3x normal volume makes a new day high (low); the next 10-min candle makes no new extreme and closes against the run.' },
  { id: 'R5', family: 'REVERSAL', group: 'BLOCK', name: 'Value area edge rejection', target: 'Yesterday\'s POC',
    rule: 'Opened inside yesterday\'s value area; a 10-min candle pokes beyond its edge and closes back inside.' },
  { id: 'R6', family: 'REVERSAL', group: 'BLOCK', name: 'Previous day high/low rejection', target: 'POC',
    rule: 'Opened below the previous day\'s high (above its low); a 10-min candle trades beyond it and closes back.' },
  { id: 'R7', family: 'REVERSAL', group: 'BLOCK', name: 'Failed momentum (high rvol reversing)', target: 'POC',
    rule: 'A busy stock (1.5x usual volume) running 30%+ of its range with Nifty, then a 10-min close 1 ATR back from its extreme. Tests the "skip a high-rvol stock that starts reversing" rule.' },
  { id: 'R8', family: 'REVERSAL', group: 'BLOCK', name: 'VWAP reversion (belief check)', target: 'VWAP',
    rule: 'Price 1.5 ATR+ from VWAP and a 10-min close below the previous candle\'s low (above its high), toward VWAP.' },
];

export const CASE_BY_ID = new Map(CASES.map((c) => [c.id, c]));

/* ---- exits ----------------------------------------------------------------------------------------------- */

/** Systematic exits: fixed targets. */
export type TargetKey = 'T1' | 'T15' | 'TS' | 'TC';
/** Discretionary exits: the markers a discretionary trader exits on before a target. XA = whichever comes first. */
export type ExitKey = 'X1' | 'X2' | 'X3' | 'X4' | 'X5' | 'X6' | 'X7' | 'XA';
export type OutKey = TargetKey | ExitKey;
export const TARGET_KEYS: TargetKey[] = ['T1', 'T15', 'TS', 'TC'];
export const EXIT_KEYS: ExitKey[] = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'XA'];
export const PRIMARY_TARGET: Record<Family, TargetKey> = { MOMENTUM: 'T1', REVERSAL: 'TS' };
export const TARGET_LABEL: Record<TargetKey, string> = { T1: '1R', T15: '1.5R', TS: 'Structure', TC: 'Held to the exit time' };
/** the exit a case's headline hit rate is quoted for */
export function primaryOf(c: CaseId): OutKey { const i = CASE_BY_ID.get(c)!; return i.primary ?? PRIMARY_TARGET[i.family]; }
export const EXIT_LABEL: Record<ExitKey, string> = {
  X1: 'Structure breaks (10-min close beyond the previous candle against you)',
  X2: 'Heavy candle against you (2x normal volume)',
  X3: 'Nifty turns against you (last 30 min)',
  X4: 'Day range reaches 95% of usual',
  X5: 'Next obstacle reached (prev day high/low, 10m 200 EMA, POC)',
  X6: 'No progress: under 0.3R after 30 minutes',
  X7: 'Give-back: was +1R, back to +0.3R',
  XA: 'First of any of these',
};

/* ---- the slices every signal carries ---------------------------------------------------------------------- */

export type Rel = 'WITH' | 'AGAINST' | 'FLAT';
export type TimeBucket = '09:20-09:45' | '09:45-11:00' | '11:00-13:00' | '13:00-15:00';
export type RvolBucket = 'LOW' | 'NORMAL' | 'HIGH';

export interface Signal {
  case: CaseId;
  symbol: string;
  date: string;
  /** minute of the session the decision was made (0 = 09:15): always a 10-minute close; entry at that close */
  slot: number;
  dir: 1 | -1;
  entry: number;
  stop: number;
  /** price of the structural target (momentum: 2R) */
  target: number;
  stopAtr: number;
  /** 10-min ATR(14) at the decision */
  atr: number;
  /** the stop had to be set at 2x ATR (no solid swing close enough) */
  capped: boolean;
  /** SWING = beyond a tested, unbroken swing; ATR2 = no solid swing, 2x ATR; FAR = the solid swing was beyond 2x ATR: no trade */
  stopType: 'SWING' | 'ATR2' | 'FAR';
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
  /** which test of the day's high (low) zone this is (the one being faded / broken): 0 = not at the extreme */
  testNo: number;
  /** the slots (minute of the session) of each test of that zone, in order */
  tests: number[];
  /** the level a failed break / rejection happened at (E): DAY, PDH, VA */
  level: '' | 'DAY' | 'PD' | 'VA';
  /** momentum: how many pullbacks the move has had */
  pullbackNo: number;
  /** a stock in play: among the 20 busiest stocks of the day's universe at 09:25 (first 10 minutes vs usual), set by the backtest job */
  inPlay?: boolean;
  /** other cases that fired the same way on the same stock in the 30 minutes before (or at) this one */
  with: CaseId[];
  /* outcome (backtest only; none for stopType FAR) */
  out?: Outcome;
}

export interface TargetResult {
  /** target reached before the stop (1R / 1.5R / structure) / made money after charges (held to the exit time, discretionary) */
  hit: boolean;
  /** result in R before charges */
  r: number;
  /** after Dhan's charges */
  net: number;
  /** minutes in the trade */
  min: number;
}
export type Outcome = Record<OutKey, TargetResult> & {
  /** best / worst move in R before the stop or 15:00 */
  mfe: number; mae: number;
  /** charges in R */
  costR: number;
  /** M9 only: the limit order was filled */
  filled?: boolean;
};

export function timeBucket(slot: number): TimeBucket {
  if (slot < 30) return '09:20-09:45';
  if (slot < 105) return '09:45-11:00';
  if (slot < 225) return '11:00-13:00';
  return '13:00-15:00';
}

/** the 30-minute slot a minute falls in, as its start time: 09:15, 09:45, 10:15 ... */
export function slot30(slot: number): string {
  const m = 555 + Math.floor(slot / 30) * 30;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
export const SLOT30_VALUES = Array.from({ length: 12 }, (_, i) => slot30(i * 30));

export function hhmm(slot: number): string {
  const m = 555 + slot;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Stretch buckets (in % of the average daily range). */
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
/** reversal: stretch at least ...; momentum: stretch under ... */
export const STRETCH_AT_LEAST = [50, 60, 70, 80, 90, 95];
export const STRETCH_UNDER = [50, 60, 70, 80];
