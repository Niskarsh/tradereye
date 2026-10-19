import type { DhanClient } from '../dhan';
import type { SheetsClient } from '../sheetsApi';
import { LOOKBACK_CALENDAR_DAYS, toSessions } from '../live/enrich';
import { dateKeyToMs, istDateKey } from '../live/time';
import { computeFacts } from '../copilot/features';
import { dailyFor, niftyFor, pickSession, settings } from '../copilot/service';
import { getRiskInr } from '../copilot/userSettings';

/**
 * The day's context for one stock, for the day-extreme reversal alert. Built from Dhan's 1-minute candles (right
 * even if recording started late) with the co-pilot's own fact engine, so every number matches what the co-pilot
 * shows: day high / low, today's POC (10-min chart, 30 rows), 10-min ATR, how stretched the run is against recent
 * days, Nifty 500, 200 EMAs in the way. No Claude, three Dhan data requests (daily candles cached for the day).
 */
export interface DayContext {
  symbol: string; securityId: string; at: number; date: string; live: boolean;
  dayHigh?: number; dayLow?: number; open?: number; poc?: number; atr10m?: number;
  stretchDir?: 'UP' | 'DOWN'; stretchRunPct?: number; stretch?: string;
  niftyNowTrend?: 'RISING' | 'FALLING' | 'FLAT'; niftyLast10Pct?: number; niftyNowPct?: number;
  /** 200 EMAs in the way of each reversal (short at the high / long at the low), as the co-pilot words them */
  emaInPathShort?: string; emaInPathLong?: string;
  riskInr: number;
}

type Deps = { dhan: Pick<DhanClient, 'intraday' | 'daily'>; sheets: SheetsClient; lookupSecurityId: (s: string) => Promise<string | undefined>; now?: () => number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function dayContext(deps: Deps, symbolIn: string, securityIdIn?: string): Promise<DayContext> {
  const nowMs = (deps.now ?? Date.now)();
  const s = settings();
  const symbol = symbolIn.trim().toUpperCase();
  const securityId = securityIdIn || await deps.lookupSecurityId(symbol);
  if (!securityId) throw new Error(`${symbol} is not in Dhan's NSE equity list.`);
  const today = istDateKey(nowMs);
  const from = istDateKey(dateKeyToMs(today) - LOOKBACK_CALENDAR_DAYS * 86400_000);
  const stock1m = await deps.dhan.intraday({ securityId, segment: 'NSE_EQ', instrument: 'EQUITY', from, to: today });
  const sess = pickSession(stock1m, nowMs);
  await sleep(220);
  const nifty1m = await niftyFor(deps.dhan, today, nowMs);
  await sleep(220);
  const daily = await dailyFor(deps.dhan, securityId, sess.date);
  const riskInr = await getRiskInr(deps.sheets).catch(() => 300);
  const day = toSessions(stock1m).find((x) => x.date === sess.date);
  const price = day?.bars.filter((b) => b.t * 1000 < Math.floor(sess.asOfMs / 60000) * 60000).at(-1)?.c ?? day?.bars.at(-1)?.c;
  const base: DayContext = { symbol, securityId, at: nowMs, date: sess.date, live: sess.live, riskInr };
  if (price === undefined) return base;
  const facts = (direction: 'LONG' | 'SHORT') => computeFacts({
    date: sess.date, nowMs: sess.asOfMs, price, direction, setup: 'REVERSAL', stock1m, nifty1m, daily,
    riskInr, niftyDirPct: s.niftyDirPct, emaReachAtr: s.emaReachAtr, pocRows: s.pocRows,
  });
  const fs = facts('SHORT'), fl = facts('LONG');
  return {
    ...base,
    dayHigh: fs.DayHigh, dayLow: fs.DayLow, open: day?.bars[0]?.o, poc: fs.PocPrice, atr10m: fs.Atr10m,
    stretchDir: fs.StretchDir, stretchRunPct: fs.StretchRunPct, stretch: fs.Stretch,
    niftyNowTrend: fs.NiftyNowTrend, niftyLast10Pct: fs.NiftyLast10Pct, niftyNowPct: fs.NiftyNowPct,
    emaInPathShort: fs.Ema200InPath || undefined, emaInPathLong: fl.Ema200InPath || undefined,
  };
}
