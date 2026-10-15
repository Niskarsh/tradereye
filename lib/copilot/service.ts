/* eslint-disable @typescript-eslint/no-explicit-any */
import { DhanError, type Candles, type DhanClient } from '../dhan';
import type { SheetsClient } from '../sheetsApi';
import { LOOKBACK_CALENDAR_DAYS, toSessions } from '../live/enrich';
import { NIFTY500 } from '../live/backfill';
import { LiveStore } from '../live/store';
import { normalizeOrder, normalizeTrade } from '../live/orders';
import { groupFills } from '../live/grouping';
import { dateKeyToMs, istDateKey, istParts, istTime, monthSheetTitle, MONTHS, SESSION_CLOSE_MIN } from '../live/time';
import type { Direction } from '../live/types';
import { chargeRate, computeBehaviour, summarizeTrades, type Behaviour, type TradeSummary } from './behaviour';
import { computeFacts, computeManageFacts, niftyState, type Facts, type ManageFacts, type Setup } from './features';
import { buildMessage, PROMPT_VERSION } from './prompt';
import type { CheckRow } from './store';
import { settings } from './settings';
import { getRiskInr } from './userSettings';

export { settings };

/* ---- small caches (one serverless instance lives for minutes; that is enough to share data between taps) ---- */

const niftyCache = new Map<string, { at: number; c: Candles }>();
const dailyCache = new Map<string, Candles>();
const behaviourCache = { at: 0, key: '', trades: [] as TradeSummary[] };

const SPACING_MS = 220; // Dhan allows 5 data requests a second
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function niftyFor(dhan: Pick<DhanClient, 'intraday'>, date: string, now = Date.now()): Promise<Candles> {
  const hit = niftyCache.get(date);
  if (hit && now - hit.at < 30_000) return hit.c;
  // a week back, not just the day: a same-day-only request has come back empty (both "vs Nifty" values blank)
  const c = await dhan.intraday({ ...NIFTY500, from: istDateKey(dateKeyToMs(date) - 7 * 86400_000), to: date });
  niftyCache.set(date, { at: now, c });
  return c;
}

/** About 5 years of daily candles BEFORE `date` (Dhan's toDate is exclusive), cached for the day. */
export async function dailyFor(dhan: Pick<DhanClient, 'daily'>, securityId: string, date: string): Promise<Candles> {
  const key = `${securityId}|${date}`;
  const hit = dailyCache.get(key);
  if (hit) return hit;
  const from = istDateKey(dateKeyToMs(date) - 5 * 365 * 86400_000);
  const c = await dhan.daily({ securityId, segment: 'NSE_EQ', instrument: 'EQUITY', from, to: date });
  if (dailyCache.size > 200) dailyCache.clear();
  dailyCache.set(key, c);
  return c;
}

/** This month's and last month's trades (cached 30 s). */
export async function recentTrades(sheets: SheetsClient, today: string, now = Date.now()): Promise<TradeSummary[]> {
  const cur = monthSheetTitle(today);
  const [y, m] = today.split('-').map(Number);
  const prev = `${MONTHS[(m + 10) % 12]}-${m === 1 ? y - 1 : y}`;
  const key = `${cur}|${prev}`;
  if (behaviourCache.key === key && now - behaviourCache.at < 30_000) return behaviourCache.trades;
  const tabs = new Set((await sheets.listTabs()).map((t) => t.title));
  const specs = [prev, cur].filter((t) => tabs.has(t)).map((title) => ({ title, tail: 1500 }));
  const reads = specs.length ? await sheets.readTails(specs) : [];
  const trades = reads.flatMap((r) => summarizeTrades(r.headers, r.rows));
  behaviourCache.at = now; behaviourCache.key = key; behaviourCache.trades = trades;
  return trades;
}

/** The session to read: today if the stock has candles today, else the last session in the data (evenings, weekends). */
export function pickSession(stock: Candles, nowMs: number): { date: string; asOfMs: number; live: boolean } {
  const today = istDateKey(nowMs);
  const sessions = toSessions(stock);
  if (sessions.some((s) => s.date === today)) {
    const close = dateKeyToMs(today) + SESSION_CLOSE_MIN * 60_000;
    return { date: today, asOfMs: Math.min(nowMs, close), live: nowMs < close };
  }
  const last = sessions[sessions.length - 1];
  if (!last) return { date: today, asOfMs: nowMs, live: false };
  return { date: last.date, asOfMs: dateKeyToMs(last.date) + SESSION_CLOSE_MIN * 60_000, live: false };
}

export interface CheckRequest { direction: Direction; setup: Setup; symbol: string; plannedStop?: number; manage?: boolean }

export interface CheckResult {
  checkId: string; mode: 'ENTRY' | 'MANAGE'; date: string; time: string; live: boolean;
  symbol: string; direction: Direction; setup: Setup; price: number; priceSource: 'LTP' | 'LAST_CANDLE';
  facts: Facts; manage?: ManageFacts; behaviour: Behaviour; row: CheckRow; payload: string; notes: string[];
  alternatives: Alternative[];
  fitsNow: FitNow[];
}

/** A setup the data fits right now (core conditions met, no flags), with the stop from the 10-minute chart. */
export interface FitNow { direction: Direction; setup: Setup; stop?: number; roomTo?: string; roomAtr?: number }

/** Another setup on the same stock, read from the same data, for the "better fit" suggestion. */
export interface Alternative { direction: Direction; setup: Setup; facts: Facts }

interface Deps {
  dhan: Pick<DhanClient, 'intraday' | 'daily' | 'ltp' | 'positions' | 'trades' | 'orders'>;
  sheets: SheetsClient;
  clientId?: string;
  lookupSecurityId: (symbol: string) => Promise<string | undefined>;
  now?: () => number;
}

const OPEN_STATUSES = new Set(['PENDING', 'TRANSIT', 'PART_TRADED', 'TRIGGER_PENDING', 'OPEN', 'MODIFIED', 'CONFIRM']);

export async function buildCheck(deps: Deps, req: CheckRequest): Promise<CheckResult> {
  const s = { ...settings(), riskInr: await getRiskInr(deps.sheets) };
  const nowMs = (deps.now ?? Date.now)();
  const symbol = req.symbol.trim().toUpperCase();
  const notes: string[] = [];
  const securityId = await deps.lookupSecurityId(symbol);
  if (!securityId) throw new Error(`${symbol} is not in Dhan's NSE equity list.`);

  const today = istDateKey(nowMs);
  const from = istDateKey(dateKeyToMs(today) - LOOKBACK_CALENDAR_DAYS * 86400_000);
  const stock1m = await deps.dhan.intraday({ securityId, segment: 'NSE_EQ', instrument: 'EQUITY', from, to: today });
  const sess = pickSession(stock1m, nowMs);
  if (sess.date !== today) notes.push(`No candles today yet: reading the last session (${sess.date}) as of its close.`);
  await sleep(SPACING_MS);
  // Nifty 500: the SAME request as the market strip (a week back, up to today), which is known to work; then,
  // only if the session is missing from it, a request ending on the session's own date.
  let nifty1m = await niftyFor(deps.dhan, today, nowMs);
  if (!toSessions(nifty1m).some((x) => x.date === sess.date) && sess.date !== today) {
    await sleep(SPACING_MS);
    nifty1m = await niftyFor(deps.dhan, sess.date, nowMs);
  }
  const nSess = toSessions(nifty1m);
  const nDayBars = nSess.find((x) => x.date === sess.date)?.bars ?? [];
  if (!nDayBars.length || istParts(nDayBars[0].t * 1000).minuteOfDay !== 9 * 60 + 15) {
    const first = nifty1m.t.length ? istDateKey(nifty1m.t[0] * 1000) : '-', last = nifty1m.t.length ? istDateKey(nifty1m.t[nifty1m.t.length - 1] * 1000) : '-';
    notes.push(`Nifty 500 for ${sess.date}: Dhan returned ${nifty1m.t.length} candles (${first} to ${last}), ${nDayBars.length} for that day${nDayBars.length ? `, first at ${istTime(nDayBars[0].t * 1000).slice(0, 5)}` : ''}.`);
  }
  await sleep(SPACING_MS);
  const daily = await dailyFor(deps.dhan, securityId, sess.date);

  // live price: the Market Quote API when the session is live, else the last 1-minute close
  const day = toSessions(stock1m).find((x) => x.date === sess.date);
  const lastClose = day?.bars.filter((b) => b.t * 1000 < Math.floor(sess.asOfMs / 60000) * 60000).at(-1)?.c ?? day?.bars.at(-1)?.c;
  let price = lastClose ?? NaN;
  let priceSource: CheckResult['priceSource'] = 'LAST_CANDLE';
  if (sess.live && deps.clientId) {
    try {
      await sleep(SPACING_MS);
      const p = await deps.dhan.ltp(deps.clientId, 'NSE_EQ', securityId);
      if (p) { price = p; priceSource = 'LTP'; }
    } catch (e) {
      if (e instanceof DhanError && (e.isAuth || e.isNoDataPlan)) throw e;
      notes.push('Live price unavailable; using the last 1-minute close.');
    }
  }
  if (!Number.isFinite(price)) throw new Error(`No price for ${symbol}.`);

  // trading API (free): positions, and for a re-check the fills and pending stop
  const positions = await deps.dhan.positions().catch(() => [] as any[]);
  const openPositions = positions.filter((p: any) => Number(p.netQty) !== 0);
  const held = openPositions.find((p: any) => String(p.securityId ?? '') === securityId || String(p.tradingSymbol ?? '').toUpperCase() === symbol);
  const mode: 'ENTRY' | 'MANAGE' = held && req.manage !== false ? 'MANAGE' : 'ENTRY';
  let direction = req.direction;
  if (mode === 'MANAGE') {
    const posDir: Direction = Number(held.netQty) > 0 ? 'LONG' : 'SHORT';
    if (posDir !== direction) notes.push(`Your position is ${posDir}; reading it as ${posDir}.`);
    direction = posDir;
  }

  // sheets: your day and record, and your charge rate
  const trades = await recentTrades(deps.sheets, sess.date, nowMs).catch((e) => { notes.push(`Journal not readable: ${(e as Error).message}`); return [] as TradeSummary[]; });

  const facts = computeFacts({
    date: sess.date, nowMs: sess.asOfMs, price, direction, setup: req.setup, stock1m, nifty1m, daily,
    plannedStop: mode === 'ENTRY' ? req.plannedStop : undefined,
    riskInr: s.riskInr, niftyDirPct: s.niftyDirPct, emaReachAtr: s.emaReachAtr, pocRows: s.pocRows,
    chargeRate: chargeRate(trades),
  });
  const behaviour = computeBehaviour(trades, { today: sess.date, nowMs: sess.asOfMs, symbol, direction, setup: req.setup, openPositions: openPositions.length });
  const ruleFlags = (fx: Facts, b: Behaviour, setup: Setup, dir: Direction) => {
    if (b.FirstTradeLost) fx.flags.push('First trade of the day lost and nothing else is open');
    if (b.SameSymbolStopped) fx.flags.push(`Stopped out of ${symbol} ${dir} earlier today`);
    // the setup's core conditions, decided by the app (includes "reversal on a busy stock" and "momentum while Nifty is flat")
    if (fx.CoreMet === 'NO') fx.flags.push(`Not a ${setup.toLowerCase()} ${dir.toLowerCase()}: ${fx.CoreMissing}`);
  };
  if (mode === 'ENTRY') ruleFlags(facts, behaviour, req.setup, direction);

  // the other three setups, read from the same data, each with a stop from the 10-minute chart (ENTRY only)
  const alternatives: Alternative[] = [];
  if (mode === 'ENTRY') {
    const combos: [Direction, Setup][] = [['LONG', 'MOMENTUM'], ['SHORT', 'MOMENTUM'], ['LONG', 'REVERSAL'], ['SHORT', 'REVERSAL']];
    for (const [dir, setup] of combos) {
      if (dir === direction && setup === req.setup) continue;
      const common = {
        date: sess.date, nowMs: sess.asOfMs, price, direction: dir, setup, stock1m, nifty1m, daily,
        riskInr: s.riskInr, niftyDirPct: s.niftyDirPct, emaReachAtr: s.emaReachAtr, pocRows: s.pocRows, chargeRate: chargeRate(trades),
      };
      const first = computeFacts(common);
      const fx = first.StopIdea !== undefined ? computeFacts({ ...common, plannedStop: first.StopIdea }) : first;
      const b = computeBehaviour(trades, { today: sess.date, nowMs: sess.asOfMs, symbol, direction: dir, setup, openPositions: openPositions.length });
      ruleFlags(fx, b, setup, dir);
      alternatives.push({ direction: dir, setup, facts: fx });
    }
  }

  let manage: ManageFacts | undefined;
  if (mode === 'MANAGE') {
    const [rawTrades, rawOrders] = await Promise.all([deps.dhan.trades().catch(() => [] as any[]), deps.dhan.orders().catch(() => [] as any[])]);
    const fills = rawTrades.map(normalizeTrade).filter((f): f is NonNullable<typeof f> => !!f && f.symbol.toUpperCase() === symbol);
    const group = groupFills(fills).filter((g) => g.status === 'OPEN').at(-1);
    const avgEntry = group?.avgCost || Number(direction === 'LONG' ? held.buyAvg : held.sellAvg) || Number(held.costPrice) || price;
    const entryTs = group?.entryTs ?? sess.asOfMs;
    const stopSide = direction === 'LONG' ? 'SELL' : 'BUY';
    const stops = rawOrders.map(normalizeOrder).filter((o): o is NonNullable<typeof o> => !!o)
      .filter((o) => (o.securityId === securityId || o.symbol?.toUpperCase() === symbol) && o.side === stopSide
        && (o.triggerPrice ?? 0) > 0 && OPEN_STATUSES.has(String(o.status ?? '').toUpperCase()));
    const currentStop = stops.at(-1)?.triggerPrice;
    let initialStop: number | undefined, stopMoves: number | undefined;
    if (group) {
      try {
        const live = await new LiveStore(deps.sheets).loadTrades();
        const row = live.get(group.id);
        if (row && row.InitialStop !== '') initialStop = Number(row.InitialStop);
        if (row) stopMoves = row.StopMoves;
      } catch { /* the live-trades tab is optional */ }
    }
    if (currentStop === undefined) notes.push('No pending stop order found in Dhan for this position.');
    manage = computeManageFacts({
      date: sess.date, nowMs: sess.asOfMs, price, direction, stock1m, nifty1m, avgEntry, entryMs: entryTs,
      initialStop, currentStop, stopMoves, atr10m: facts.Atr10m,
    });
  }

  // setups whose core conditions are met with no flags, read by the app alone (no Claude needed)
  const fitsNow: FitNow[] = mode === 'ENTRY'
    ? [{ direction, setup: req.setup, facts }, ...alternatives]
      .filter((a) => a.facts.CoreMet === 'YES' && a.facts.flags.length === 0)
      .sort((a, b) => (b.facts.RoomAtr ?? 0) - (a.facts.RoomAtr ?? 0))
      .map((a) => ({ direction: a.direction, setup: a.setup, stop: a.facts.StopIdea, roomTo: a.facts.RoomTo, roomAtr: a.facts.RoomAtr }))
    : [];

  const time = istTime(sess.asOfMs);
  const checkId = `C${sess.date.replace(/-/g, '')}-${time.replace(/:/g, '')}-${symbol}-${Math.random().toString(36).slice(2, 6)}`;
  const todayTrades = trades.filter((t) => t.date === sess.date).map((t) => ({ symbol: t.symbol, direction: t.direction, netPnl: t.netPnl, exitType: t.exitType }));
  const payload = buildMessage({
    mode, time: time.slice(0, 5), direction, setup: req.setup, symbol, riskInr: s.riskInr, price,
    facts, manage, behaviour, todayTrades, stock1m, nifty1m, date: sess.date, asOfMs: sess.asOfMs, live: sess.live,
    alternatives,
  });

  const { flags, missing, ...plain } = facts;
  const row: CheckRow = {
    CheckId: checkId, Date: sess.date, Time: time, CreatedAt: nowMs, Symbol: symbol, SecurityId: securityId, Direction: direction,
    Setup: req.setup, Mode: mode, PlannedStop: req.plannedStop ?? '', Ltp: price, LtpSource: priceSource,
    ...(plain as Record<string, string | number | undefined>),
    TradesToday: behaviour.TradesToday, PnlToday: behaviour.PnlToday, FirstTradeLost: behaviour.FirstTradeLost ? 'YES' : 'NO',
    SameSymbolStopped: behaviour.SameSymbolStopped ? 'YES' : 'NO', MinSinceLoss: behaviour.MinSinceLoss ?? '',
    SetupTrades: behaviour.SetupTrades, SetupWinRate: behaviour.SetupWinRate ?? '', SetupAvgPnl: behaviour.SetupAvgPnl ?? '',
    FitsNow: fitsNow.map((x) => `${x.setup} ${x.direction}${x.stop !== undefined ? ` stop ${x.stop}` : ''}`).join(' | '),
    Status: 'FACTS', PromptVersion: PROMPT_VERSION,
    Notes: [...flags.map((x) => `FLAG ${x}`), ...missing.map((x) => `MISSING ${x}`), ...notes].join('; ').slice(0, 1000),
    PayloadJson: payload.slice(0, 45_000),
  } as CheckRow;
  if (manage) {
    const { missing: mm, ...mf } = manage;
    Object.assign(row, mf);
    if (mm.length) row.Notes = `${row.Notes}; ${mm.map((x) => `MISSING ${x}`).join('; ')}`;
  }
  for (const k of Object.keys(row)) if ((row as Record<string, unknown>)[k] === undefined) (row as Record<string, unknown>)[k] = '';

  return { checkId, mode, date: sess.date, time, live: sess.live, symbol, direction, setup: req.setup, price, priceSource, facts, manage, behaviour, row, payload, notes, alternatives, fitsNow };
}

/** Today's market strip: Nifty 500 state and your day so far. */
export async function marketStrip(deps: Pick<Deps, 'dhan' | 'sheets' | 'now'>) {
  const s = settings();
  const nowMs = (deps.now ?? Date.now)();
  const today = istDateKey(nowMs);
  const nifty = await niftyFor(deps.dhan, today, nowMs);
  // evening / weekend / holiday: no candles today, so show the last session in the data
  const sessions = toSessions(nifty);
  const date = sessions.some((x) => x.date === today) ? today : sessions.at(-1)?.date ?? today;
  const asOfMs = date === today ? nowMs : dateKeyToMs(date) + SESSION_CLOSE_MIN * 60_000;
  const nDay = toSessions(nifty).find((x) => x.date === date);
  const bars = nDay ? nDay.bars.filter((b) => b.t * 1000 < Math.floor(asOfMs / 60000) * 60000) : [];
  let first5: number | undefined, nowPct: number | undefined, last10: number | undefined;
  if (bars.length && istParts(bars[0].t * 1000).minuteOfDay === 9 * 60 + 15) {
    const f5 = bars.filter((b) => istParts(b.t * 1000).minuteOfDay < 9 * 60 + 20);
    if (f5.length >= 4 && istParts(f5.at(-1)!.t * 1000).minuteOfDay >= 9 * 60 + 18 && istParts(asOfMs).minuteOfDay >= 9 * 60 + 20) first5 = Number(((f5.at(-1)!.c / bars[0].o - 1) * 100).toFixed(4));
    nowPct = Number(((bars.at(-1)!.c / bars[0].o - 1) * 100).toFixed(4));
  }
  if (bars.length > 10) last10 = Number(((bars.at(-1)!.c / bars.at(-11)!.c - 1) * 100).toFixed(4));
  const state = niftyState(first5, nowPct, last10, s.niftyDirPct, istParts(asOfMs).minuteOfDay);
  const last30 = bars.length > 30 ? Number(((bars.at(-1)!.c / bars.at(-31)!.c - 1) * 100).toFixed(4)) : undefined;
  const nowTrend = last30 === undefined ? undefined : last30 >= s.niftyDirPct ? 'RISING' : last30 <= -s.niftyDirPct ? 'FALLING' : 'FLAT';
  return { date, live: date === today && istParts(nowMs).minuteOfDay < SESSION_CLOSE_MIN, asOf: istTime(asOfMs), first5, nowPct, last10, last30, nowTrend, state };
}

