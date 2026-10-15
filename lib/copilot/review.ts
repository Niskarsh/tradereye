import type { Candles, DhanClient } from '../dhan';
import { DhanError } from '../dhan';
import { rowToObject, type Cell, type SheetsClient } from '../sheetsApi';
import { LOOKBACK_CALENDAR_DAYS, tenMinuteBars, toSessions, type Bar } from '../live/enrich';
import { MONTHLY_REVIEW_COLS } from '../live/schema';
import { dateKeyToMs, istDateKey, istParts, istTime, normDate, normTime, parseIst } from '../live/time';
import type { Direction } from '../live/types';
import { summarizeTrades } from './behaviour';
import { computeFacts, computeManageFacts, type Facts, type ManageFacts, type Setup } from './features';
import { settings } from './settings';
import { readChecks } from './store';

/**
 * Trade review ("Review this trade" in the journal): everything the app knows about ONE finished trade, the market
 * at entry and at exit, what price did after the exit, and the co-pilot's checks, so Claude can say what he did
 * right, what he did wrong, whether the exit was early, and what to look for next time. The app decides the
 * measurable parts (exit call, stay/go signals at the exit); Claude explains them. Stored on the trade's own row.
 */

export const REVIEW_VERSION = 'review-v2';
const NIFTY500 = { securityId: '19', segment: 'IDX_I', instrument: 'INDEX' };
const r2 = (n: number) => Number(n.toFixed(2));

export type ExitCall = 'STOPPED' | 'STOPPED_THEN_WORKED' | 'EARLY' | 'GOOD' | 'OK' | 'UNKNOWN';

export interface AfterExit {
  /** Further move his way after the exit, from the exit price, in R (R = entry-to-initial-stop, or 2x ATR). */
  BestR30?: number; BestR60?: number; BestRClose?: number;
  /** Move against him after the exit, in R (what he avoided). */
  WorstR60?: number;
  /** Close of the day vs his exit, in R (+ = it kept going his way). */
  CloseVsExitR?: number;
  /** Would his last stop have been hit before that best point, within 60 minutes? */
  StopHitFirst60?: boolean;
  /** For a stopped trade: best move his way from the ENTRY within 60 minutes after the stop, in R. */
  FromEntryBestR60?: number;
  ExitCall: ExitCall;
  RBasis: string;
}

/** What price did after he got out, judged against his own risk unit. Pure: candles in, numbers out. */
export function afterExit(p: {
  bars: Bar[]; direction: Direction; avgEntry: number; avgExit: number; exitMs: number;
  rDist: number; rBasis: string; lastStop?: number; exitType: string;
}): AfterExit {
  const sign = p.direction === 'LONG' ? 1 : -1;
  const exitMin = Math.floor(p.exitMs / 60000) * 60000;
  const after = p.bars.filter((b) => b.t * 1000 >= exitMin + 60_000); // from the next full minute
  const out: AfterExit = { ExitCall: 'UNKNOWN', RBasis: p.rBasis };
  if (!after.length || !(p.rDist > 0)) return out;
  const within = (min: number) => after.filter((b) => b.t * 1000 < exitMin + min * 60_000);
  const best = (bs: Bar[]) => (bs.length ? Math.max(0, ...bs.map((b) => (sign === 1 ? b.h - p.avgExit : p.avgExit - b.l))) / p.rDist : 0);
  const worst = (bs: Bar[]) => (bs.length ? Math.max(0, ...bs.map((b) => (sign === 1 ? p.avgExit - b.l : b.h - p.avgExit))) / p.rDist : 0);
  const b60 = within(60);
  out.BestR30 = r2(best(within(30)));
  out.BestR60 = r2(best(b60));
  out.BestRClose = r2(best(after));
  out.WorstR60 = r2(worst(b60));
  out.CloseVsExitR = r2(((after[after.length - 1].c - p.avgExit) * sign) / p.rDist);
  if (p.lastStop !== undefined && b60.length) {
    // walk forward: did price touch his stop before it made its best move his way?
    let peak = -Infinity, peakAt = -1, stopAt = -1;
    b60.forEach((b, i) => {
      const fav = sign === 1 ? b.h : -b.l;
      if (fav > peak) { peak = fav; peakAt = i; }
      if (stopAt < 0 && (sign === 1 ? b.l <= p.lastStop! : b.h >= p.lastStop!)) stopAt = i;
    });
    out.StopHitFirst60 = stopAt >= 0 && stopAt <= peakAt;
  }
  const stopped = p.exitType === 'STOP';
  if (stopped) {
    const fromEntry = b60.length ? Math.max(0, ...b60.map((b) => (sign === 1 ? b.h - p.avgEntry : p.avgEntry - b.l))) / p.rDist : 0;
    out.FromEntryBestR60 = r2(fromEntry);
    out.ExitCall = fromEntry >= 1 ? 'STOPPED_THEN_WORKED' : 'STOPPED';
  } else if ((out.BestR60 ?? 0) >= 1 && !out.StopHitFirst60) out.ExitCall = 'EARLY';
  else if ((out.BestR60 ?? 0) < 0.3 || (out.WorstR60 ?? 0) >= 1) out.ExitCall = 'GOOD';
  else out.ExitCall = 'OK';
  return out;
}

/** Signs at the moment he exited: reasons the trade could keep going (stay) and reasons it was ending (go). */
export function exitSignals(f: Facts, m: ManageFacts, direction: Direction, last30MoveAtr?: number): { stay: string[]; go: string[] } {
  const up = direction === 'LONG';
  const stay: string[] = [], go: string[] = [];
  if (last30MoveAtr !== undefined) {
    if (last30MoveAtr >= 0.5) stay.push(`stock still moving your way in the last 30 min (${last30MoveAtr} ATR)`);
    else if (last30MoveAtr <= -0.3) go.push(`stock moving against you in the last 30 min (${last30MoveAtr} ATR)`);
    else go.push('stock stalled in the last 30 min');
  }
  const n30 = f.NiftyLast30Trend;
  if (n30 === (up ? 'RISING' : 'FALLING')) stay.push(`Nifty 500 with you in the last 30 min (${f.NiftyLast30Pct}%)`);
  else if (n30 === (up ? 'FALLING' : 'RISING')) go.push(`Nifty 500 against you in the last 30 min (${f.NiftyLast30Pct}%)`);
  else if (n30 === 'FLAT') go.push('Nifty 500 flat in the last 30 min: no tailwind');
  if (m.CounterVolRatio !== undefined) {
    if (m.CounterVolRatio < 0.8) stay.push(`volume against you lighter than volume with you (${m.CounterVolRatio})`);
    else if (m.CounterVolRatio > 1) go.push(`volume against you heavier than volume with you (${m.CounterVolRatio})`);
  }
  if (m.ClimaxAgainst) go.push(`climax candle against you (${m.ClimaxAgainst.toLowerCase().replace(/_/g, ' ')})`);
  if (m.FailedExtreme) go.push(`failed break of the day's ${up ? 'high' : 'low'}`);
  if (!m.ClimaxAgainst && !m.FailedExtreme) stay.push('no climax or failed break against you');
  if (m.BestR !== undefined && m.GivebackR !== undefined && m.BestR >= 1 && m.GivebackR >= m.BestR / 2) go.push(`gave back ${m.GivebackR}R of the best ${m.BestR}R`);
  if (f.VwapSide) (f.VwapSide === (up ? 'BUYERS' : 'SELLERS') ? stay : go).push(`${f.VwapSide.toLowerCase()} in control (VWAP)`);
  if (f.Stretch === 'VERY_STRETCHED' && f.StretchDir === (up ? 'UP' : 'DOWN')) go.push(`very stretched your way: run bigger than ${f.StretchRunPct}% of recent days`);
  if (f.RoomAtr !== undefined && f.RoomTo && f.RoomAtr < 0.3) go.push(`at the next level (${f.RoomTo})`);
  else if (f.RoomAtr !== undefined && f.RoomTo && f.RoomAtr >= 1) stay.push(`room left to ${f.RoomTo} (${f.RoomAtr} ATR)`);
  return { stay, go };
}

/**
 * Fills -> orders. The sheet has no order id, so fills on the same side within 3 seconds of the previous one, with
 * no fill on the other side in between, are one order split by the exchange (60 shares filled as 30 + 30).
 */
export function ordersOf(fills: { ts: number; side: string; qty: number; price: number }[], side: string) {
  const out: { ts: number; qty: number; avg: number; fills: number }[] = [];
  let cur: { ts: number; last: number; qty: number; val: number; fills: number } | undefined;
  for (const f of [...fills].sort((a, b) => a.ts - b.ts)) {
    if (f.side !== side) { if (cur) { out.push({ ts: cur.ts, qty: cur.qty, avg: cur.val / cur.qty, fills: cur.fills }); cur = undefined; } continue; }
    if (cur && f.ts - cur.last <= 3000) { cur.qty += f.qty; cur.val += f.qty * f.price; cur.fills++; cur.last = f.ts; continue; }
    if (cur) out.push({ ts: cur.ts, qty: cur.qty, avg: cur.val / cur.qty, fills: cur.fills });
    cur = { ts: f.ts, last: f.ts, qty: f.qty, val: f.qty * f.price, fills: 1 };
  }
  if (cur) out.push({ ts: cur.ts, qty: cur.qty, avg: cur.val / cur.qty, fills: cur.fills });
  return out;
}

/* ---- gathering one trade ---------------------------------------------------------------------------------- */

export interface ReviewDeps {
  sheets: SheetsClient;
  dhan?: Pick<DhanClient, 'intraday' | 'daily'>;
  lookupSecurityId: (symbol: string) => Promise<string | undefined>;
}

export interface ReviewInput {
  title: string; headers: string[]; firstRowNumber: number; message: string; exitCall: ExitCall; notes: string[];
}

const fmtPx = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(2) : n.toPrecision(5).replace(/\.?0+$/, ''));
const hhmm = (t: number) => { const p = istParts(t * 1000); return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`; };
const num = (v: unknown) => { const x = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : undefined; };
function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) out[k] = v;
  return out;
}

export async function gatherReview(deps: ReviewDeps, title: string, groupId: string): Promise<ReviewInput> {
  const { headers, rows } = await deps.sheets.readAll(title);
  const mine = rows.map((r) => ({ rowNumber: r.rowNumber, o: rowToObject(headers, r.cells) })).filter((r) => (r.o.TradeGroupId ?? '').trim() === groupId);
  if (!mine.length) throw new Error('Trade not found in the sheet.');
  const o0 = mine[0].o;
  const date = normDate(o0['Date (IST)']);
  const symbol = String(o0.Symbol ?? '').trim().toUpperCase();
  const notes: string[] = [];

  const fills = mine.map((r) => ({
    ts: parseIst(`${date} ${normTime(r.o['Time (IST)'])}`), side: String(r.o.OrderType ?? '').trim().toUpperCase(),
    qty: num(r.o.Qty) ?? 0, price: num(r.o.Price) ?? 0,
  })).filter((f) => Number.isFinite(f.ts)).sort((a, b) => a.ts - b.ts);
  if (!fills.length) throw new Error('The trade rows have no time.');
  const dirCol = String(o0.DirFromFills || '').toUpperCase();
  const direction: Direction = dirCol === 'SHORT' || dirCol === 'LONG' ? dirCol : fills[0].side === 'SELL' ? 'SHORT' : 'LONG';
  const entrySide = direction === 'LONG' ? 'BUY' : 'SELL';
  const entries = fills.filter((f) => f.side === entrySide), exits = fills.filter((f) => f.side !== entrySide);
  const entryOrders = ordersOf(fills, entrySide), exitOrders = ordersOf(fills, entrySide === 'BUY' ? 'SELL' : 'BUY');
  const wavg = (a: typeof fills) => { const q = a.reduce((s, f) => s + f.qty, 0); return q ? a.reduce((s, f) => s + f.qty * f.price, 0) / q : 0; };
  const avgEntry = wavg(entries), avgExit = wavg(exits);
  const entryMs = entries[0]?.ts ?? fills[0].ts, exitMs = exits.length ? exits[exits.length - 1].ts : fills[fills.length - 1].ts;
  const setupCol = String(o0.Setup ?? '').trim().toLowerCase();
  const setup: Setup = setupCol === 'reversal' ? 'REVERSAL' : 'MOMENTUM';
  const initialStop = num(o0.InitialStop), lastStop = num(o0.LastStop) ?? initialStop;
  const exitType = String(o0.ExitType ?? '').trim().toUpperCase();

  const trade = compact({
    Symbol: symbol, Date: date, Direction: direction, Setup: setupCol ? setup : `${setup} (not tagged: assumed)`,
    EntryTime: hhmm(entryMs / 1000), ExitTime: hhmm(exitMs / 1000), MinutesInTrade: Math.round((exitMs - entryMs) / 60000),
    AvgEntry: r2(avgEntry), AvgExit: avgExit ? r2(avgExit) : undefined, Qty: entries.reduce((s, f) => s + f.qty, 0),
    // the exchange splits one order into several fills: count ORDERS, and list them, so split fills are never read as adds
    EntryOrders: entryOrders.map((o) => `${istTime(o.ts)} ${o.qty} @ ${r2(o.avg)}${o.fills > 1 ? ` (${o.fills} fills, one order)` : ''}`),
    Adds: Math.max(0, entryOrders.length - 1),
    ExitOrders: exitOrders.map((o) => `${istTime(o.ts)} ${o.qty} @ ${r2(o.avg)}${o.fills > 1 ? ` (${o.fills} fills, one order)` : ''}`),
    InitialStop: initialStop, LastStop: lastStop, StopMoves: num(o0.StopMoves), TargetFirst: num(o0.TpFirst), TargetLast: num(o0.TpLast),
    ExitType: exitType || 'UNKNOWN', GrossPnL: num(o0.GrossPnL), NetPnL: num(o0.NetPnL), Charges: num(o0.TotalCharges), RiskInr: num(o0.RiskInr),
    MfeR: num(o0.MfeR), MaeR: num(o0.MaeR), RBasis: o0.RBasis || undefined,
  });

  // ---- market data (optional: without it the review uses the sheet only)
  let stock1m: Candles | undefined, nifty1m: Candles | undefined, daily: Candles | undefined;
  if (deps.dhan) {
    try {
      const secId = o0.SecurityId?.trim() || (await deps.lookupSecurityId(symbol)) || '';
      if (!secId) throw new Error(`no Dhan security id for ${symbol}`);
      const from = istDateKey(dateKeyToMs(date) - LOOKBACK_CALENDAR_DAYS * 86400_000);
      [stock1m, nifty1m, daily] = await Promise.all([
        deps.dhan.intraday({ securityId: secId, segment: 'NSE_EQ', instrument: 'EQUITY', from, to: date }),
        deps.dhan.intraday({ ...NIFTY500, from: date, to: date }),
        deps.dhan.daily({ securityId: secId, segment: 'NSE_EQ', instrument: 'EQUITY', from: istDateKey(dateKeyToMs(date) - 5 * 365 * 86400_000), to: date }),
      ]);
    } catch (e) {
      if (e instanceof DhanError && e.isAuth) throw e;
      notes.push(`Market data not available (${(e as Error).message}); review from the journal only.`);
      stock1m = undefined;
    }
  } else notes.push('No Dhan token: review from the journal only (no candles, no after-exit check).');

  const parts: string[] = [`TRADE ${JSON.stringify(trade)}`];
  let exitCall: ExitCall = 'UNKNOWN';
  const day = stock1m ? toSessions(stock1m).find((s) => s.date === date) : undefined;
  if (stock1m && nifty1m && daily && day?.bars.length) {
    const s = settings();
    const common = { date, direction, setup, stock1m, nifty1m, daily, riskInr: s.riskInr, niftyDirPct: s.niftyDirPct, emaReachAtr: s.emaReachAtr, pocRows: s.pocRows };
    const atEntry = computeFacts({ ...common, nowMs: entryMs, price: avgEntry, plannedStop: initialStop });
    const exitPx = avgExit || day.bars.filter((b) => b.t * 1000 < exitMs).at(-1)?.c || avgEntry;
    const atExit = computeFacts({ ...common, nowMs: exitMs, price: exitPx });
    const manage = computeManageFacts({ date, nowMs: exitMs, price: exitPx, direction, stock1m, nifty1m, avgEntry, entryMs, initialStop, currentStop: lastStop, stopMoves: num(o0.StopMoves), atr10m: atEntry.Atr10m });
    const sign = direction === 'LONG' ? 1 : -1;
    const before = day.bars.filter((b) => b.t * 1000 < Math.floor(exitMs / 60000) * 60000);
    const last30 = before.length > 30 && atExit.Atr10m ? r2(((exitPx - before[before.length - 31].c) * sign) / atExit.Atr10m) : undefined;
    const rDist = initialStop !== undefined && Math.abs(avgEntry - initialStop) > 0 ? Math.abs(avgEntry - initialStop) : (atEntry.Atr10m ?? 0) * 2;
    const rBasis = initialStop !== undefined ? 'his initial stop' : '2x ATR (no stop recorded)';
    const ax = afterExit({ bars: day.bars, direction, avgEntry, avgExit: exitPx, exitMs, rDist, rBasis, lastStop, exitType });
    exitCall = ax.ExitCall;
    const sig = exitSignals(atExit, manage, direction, last30);
    const keep = (f: Facts) => {
      const { flags, missing, ...rest } = f; void missing;
      return compact({ ...rest, flags: flags.length ? flags : undefined });
    };
    parts.push(`AT_ENTRY ${JSON.stringify(keep(atEntry))}`);
    parts.push(`AT_EXIT ${JSON.stringify(keep(atExit))}`);
    const { missing: mm, ...mf } = manage; void mm;
    parts.push(`IN_TRADE_AT_EXIT ${JSON.stringify(compact(mf as unknown as Record<string, unknown>))}`);
    parts.push(`EXIT_SIGNALS ${JSON.stringify({ stay: sig.stay, go: sig.go, StockLast30AtrYourWay: last30 })}`);
    parts.push(`AFTER_EXIT ${JSON.stringify(ax)}`);
    // the day on his 10-minute chart, with entry and exit marked
    const tens = tenMinuteBars([{ date, bars: day.bars }]);
    const mark = (start: number) => {
      const end = start + 600;
      const tags = [entryMs / 1000 >= start && entryMs / 1000 < end ? 'ENTRY' : '', exitMs / 1000 >= start && exitMs / 1000 < end ? 'EXIT' : ''].filter(Boolean);
      return tags.length ? `,${tags.join('+')}` : '';
    };
    parts.push('STOCK_10M the whole day (time,o,h,l,c,v)', ...tens.map((b) => `${hhmm(b.start)},${fmtPx(b.o)},${fmtPx(b.h)},${fmtPx(b.l)},${fmtPx(b.c)},${Math.round(b.v)}${mark(b.start)}`));
    const nDay = toSessions(nifty1m).find((x) => x.date === date);
    if (nDay) parts.push('NIFTY500_10M', ...tenMinuteBars([{ date, bars: nDay.bars }]).map((b) => `${hhmm(b.start)},${fmtPx(b.c)}`));
  } else {
    // sheet-only context captured at entry
    const ctx = Object.fromEntries(Object.entries(o0).filter(([k]) => /^(Nifty|Rvol|Atr|Ema200|Or|EntryVsOr|Pdh|Pdl|RsVsNifty|ExtAdr|Poc|Pullback|VolTrend|Stock30m|StockNow|ChgPrev|Gap|VwapDist)/.test(k)));
    parts.push(`AT_ENTRY_FROM_JOURNAL ${JSON.stringify(compact(ctx))}`);
  }

  // co-pilot checks linked to this trade (and any for the same stock that day before the entry)
  try {
    const { rows: ck } = await readChecks(deps.sheets, date, 400);
    const linked = ck.filter((r) => r.o.TradeGroupId === groupId
      || (r.o.Symbol?.toUpperCase() === symbol && r.o.Date === date && Number(r.o.CreatedAt) <= exitMs && Number(r.o.CreatedAt) >= entryMs - 30 * 60_000));
    if (linked.length) {
      parts.push('COPILOT_CHECKS', ...linked.slice(-8).map((r) => `${r.o.Time?.slice(0, 5)} ${r.o.Mode} ${r.o.Direction} ${r.o.Setup}: ${r.o.Verdict || 'facts only'}${r.o.Line1 ? ` | ${[r.o.Line1, r.o.Line2, r.o.Line3].filter(Boolean).join(' / ')}` : ''}${r.o.Watch ? ` | watch: ${r.o.Watch}` : ''}${r.o.CoreMissing ? ` | core missing: ${r.o.CoreMissing}` : ''}${r.o.Decision ? ` | he ${r.o.Decision.toLowerCase()}` : ''}`));
    } else parts.push('COPILOT_CHECKS none for this trade');
  } catch { /* no checks tab */ }

  // his record in this setup and direction (this month), for context only
  const all = summarizeTrades(headers, rows);
  const same = all.filter((t) => t.setup === setup.toLowerCase() && t.direction === direction && Number.isFinite(t.netPnl));
  if (same.length >= 5) parts.push(`HIS_MONTH ${JSON.stringify({ SameSetupTrades: same.length, WinRate: r2(same.filter((t) => t.netPnl > 0).length / same.length), AvgNet: r2(same.reduce((s, t) => s + t.netPnl, 0) / same.length) })}`);
  if (o0.Comment?.trim()) parts.push(`HIS_NOTES (his own words, written after the trade) ${o0.Comment.trim().slice(0, 1500)}`);
  if (notes.length) parts.push(`MISSING ${notes.join('; ')}`);

  return { title, headers, firstRowNumber: mine[0].rowNumber, message: parts.join('\n'), exitCall, notes };
}

/* ---- the reply ------------------------------------------------------------------------------------------- */

export const REVIEW_RULES = `REVIEW MODE
This is not a live read. The trade is finished and Nik asked for a review of it in his journal, to learn from it later. Ignore the live verdict labels, entry-timing and scenario rules above; your knowledge of his method and of the facts still holds. The data: TRADE (what he did), AT_ENTRY and AT_EXIT (the app's facts at those moments, same names as the live read), IN_TRADE_AT_EXIT, EXIT_SIGNALS (the app's own list of signs that said stay or go at the moment he exited), AFTER_EXIT (what price did after he got out, in R of his risk), COPILOT_CHECKS (what the co-pilot told him and what he did), HIS_NOTES (his own account) and the day's 10-minute candles with ENTRY and EXIT marked.
- EntryOrders / ExitOrders are his ORDERS. The exchange often fills one order in several pieces at the same second ("2 fills, one order"): that is ONE entry, never an add. Adds counts only separate entry orders placed later; call something an add (or averaging down) only when Adds is 1 or more, and name its time.
- Judge the PROCESS, not the P&L. A loss taken on a sound plan with the stop honoured is SOLID; a win from a trade that broke his rules is MIXED or POOR. Grade: SOLID (followed a sound plan), MIXED, POOR (the setup was not there, or rules broken).
- Every point is ONE short line, under 18 words, plain words. Name the fact behind it ("Nifty was flat for 30 min before entry"), a number only when it means something. No jargon, no field names, no filler.
- right: up to 3 things he did well. wrong: up to 3 mistakes, most costly first. If there is genuinely nothing for one of them, give an empty list; never invent one.
- exit: the app has made the exit call (ExitCall in AFTER_EXIT): EARLY = price went 1R+ further his way within 60 min without touching his stop first; GOOD = it did not (or turned against him); OK = in between; STOPPED = the stop was hit; STOPPED_THEN_WORKED = stopped, then it went 1R+ his way from his entry within the hour (the stop placement is the question). Never contradict it. exit_points (up to 3) explain it using EXIT_SIGNALS: for EARLY, which stay signs were there when he got out and what would have told him to keep going; for GOOD, which go signs were there. If the exit looks driven by fear (EARLY with mostly stay signs), say so plainly and kindly in one line.
- next_time: up to 3 rules he can check in the moment, each "If <measurable thing the app shows>, then <what it means>", using the app's measures in plain words (last 30 min of Nifty and the stock, stretch vs recent days, volume against vs with him, VWAP control, room to the next level, first 10-min candle). Only rules this trade supports.
- If COPILOT_CHECKS exist, one point (in right or wrong) says whether the co-pilot's read was right and whether he followed it.
- Treat HIS_NOTES as his account; agree with it only where the data does. Do not soften a point because of what he wrote.
- If MISSING says there was no market data, review from TRADE and the journal context only and say once, in headline, that the review is partial.
- headline: one line, under 15 words: the main lesson of this trade.`;

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    grade: { type: 'string', enum: ['SOLID', 'MIXED', 'POOR'] },
    headline: { type: 'string' },
    right: { type: 'array', items: { type: 'string' } },
    wrong: { type: 'array', items: { type: 'string' } },
    exit_points: { type: 'array', items: { type: 'string' } },
    next_time: { type: 'array', items: { type: 'string' } },
  },
  required: ['grade', 'headline', 'right', 'wrong', 'exit_points', 'next_time'],
  additionalProperties: false,
} as const;

export interface StoredReview {
  grade: 'SOLID' | 'MIXED' | 'POOR' | 'RAW'; headline: string; right: string[]; wrong: string[];
  exit: ExitCall; exitPoints: string[]; nextTime: string[]; at: string; costInr: number; model: string; version: string;
}

const list = (v: unknown, max: number) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, max) : []);

export function toStoredReview(json: Record<string, unknown>, raw: string, exitCall: ExitCall, meta: { at: string; costInr: number; model: string }): StoredReview {
  const g = String(json.grade ?? '').toUpperCase();
  const ok = g === 'SOLID' || g === 'MIXED' || g === 'POOR';
  return {
    grade: ok ? (g as StoredReview['grade']) : 'RAW',
    headline: ok ? String(json.headline ?? '').trim() : raw.slice(0, 600) || 'Claude returned no review.',
    right: list(json.right, 3), wrong: list(json.wrong, 3), exit: exitCall, exitPoints: list(json.exit_points, 3), nextTime: list(json.next_time, 3),
    ...meta, version: REVIEW_VERSION,
  };
}

/** The four review columns, written on the trade's FIRST row only (the journal reads them from there). */
export function reviewCells(r: StoredReview): Record<typeof MONTHLY_REVIEW_COLS[number], Cell> {
  return { AiReview: JSON.stringify(r).slice(0, 45_000), AiReviewGrade: r.grade, AiReviewAt: r.at, AiReviewCostInr: r.costInr };
}
