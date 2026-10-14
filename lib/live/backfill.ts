import type { SheetsClient } from '../sheetsApi';
import { colLetter, rowToObject } from '../sheetsApi';
import { DhanError, previousClose, type DhanClient } from '../dhan';
import { LOOKBACK_CALENDAR_DAYS, computeEnrichment, toSessions, volumeDiagnostics } from './enrich';
import { MONTHLY_ALL, MONTHLY_CONTEXT_COLS, MONTHLY_ENRICH_COLS } from './schema';
import { computeFacts } from '../copilot/features';
import { settings as copilotSettings } from '../copilot/settings';
import { dateKeyToMs, istDateKey, istTime, monthSheetTitle, normDate, normTime, parseIst, MONTHS } from './time';

/**
 * Backfill = fill the market-data columns of trades that are already in the monthly sheets
 * (logged by hand or automatically). It needs the Dhan Data API only while it runs: intraday history
 * goes back 5 years, so a single paid month can enrich everything, then you can unsubscribe.
 *
 * It never changes existing values: blank live columns are filled, enrichment columns are (re)written,
 * and the Setup column is never touched.
 */

export const NIFTY500 = { securityId: '19', segment: 'IDX_I', instrument: 'INDEX' };
const TAB_RE = new RegExp(`^(${MONTHS.join('|')})-\\d{4}$`);

export interface PlanItem { tab: string; groupId: string; date: string; symbol: string; fills: number; status: string }
export interface PlanResult { items: PlanItem[]; pending: number; done: number; tabs: string[] }

interface GroupRows { groupId: string; rows: { rowNumber: number; o: Record<string, string>; cells: string[] }[] }

function groupRows(headers: string[], rows: { rowNumber: number; cells: string[] }[]): GroupRows[] {
  const m = new Map<string, GroupRows>();
  for (const r of rows) {
    const o = rowToObject(headers, r.cells);
    const id = (o.TradeGroupId ?? '').trim();
    if (!id || !o.Symbol) continue;
    const g = m.get(id) ?? { groupId: id, rows: [] };
    g.rows.push({ rowNumber: r.rowNumber, o, cells: r.cells });
    m.set(id, g);
  }
  return [...m.values()];
}

export async function planBackfill(sheets: SheetsClient, opts: { redo?: boolean } = {}): Promise<PlanResult> {
  const tabs = (await sheets.listTabs(true)).map((t) => t.title).filter((t) => TAB_RE.test(t));
  const items: PlanItem[] = [];
  let done = 0;
  for (const tab of tabs) {
    const { headers, rows } = await sheets.readAll(tab);
    for (const g of groupRows(headers, rows)) {
      const st = (g.rows[0].o.EnrichStatus ?? '').trim();
      // done = market columns OK AND the newer context columns filled (so old trades get context too)
      const ok = st === 'OK' && /v2/.test(g.rows[0].o.ContextStatus ?? ''); // v2 = 10-minute chart basis
      if (ok && !opts.redo) { done++; continue; }
      items.push({ tab, groupId: g.groupId, date: normDate(g.rows[0].o['Date (IST)']), symbol: g.rows[0].o.Symbol, fills: g.rows.length, status: st || 'NEW' });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date));
  return { items, pending: items.length, done, tabs };
}

export interface RunDeps {
  dhan: Pick<DhanClient, 'intraday' | 'daily'>;
  sheets: SheetsClient;
  lookupSecurityId: (symbol: string) => Promise<string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
export interface RunItemResult { groupId: string; symbol: string; status: 'OK' | 'PARTIAL' | 'FAILED'; detail: string }
export interface RunResult { results: RunItemResult[]; aborted?: 'TOKEN_EXPIRED' | 'NO_DATA_PLAN' }

const SPACING_MS = 220; // Dhan allows 5 data requests/second

export async function runBackfill(deps: RunDeps, items: { tab: string; groupId: string }[]): Promise<RunResult> {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const nowMs = (deps.now ?? Date.now)();
  const results: RunItemResult[] = [];
  const niftyCache = new Map<string, ReturnType<typeof toSessions>>();
  const byTab = new Map<string, string[]>();
  for (const it of items) byTab.set(it.tab, [...(byTab.get(it.tab) ?? []), it.groupId]);

  for (const [tab, ids] of byTab) {
    if (!TAB_RE.test(tab)) continue;
    const { headers } = await deps.sheets.ensureTab(tab, MONTHLY_ALL);
    const { rows } = await deps.sheets.readAll(tab);
    const groups = new Map(groupRows(headers, rows).map((g) => [g.groupId, g]));
    const col = (name: string) => headers.indexOf(name);
    const updates: { range: string; values: (string | number)[][] }[] = [];

    for (const id of ids) {
      const g = groups.get(id);
      if (!g) { results.push({ groupId: id, symbol: '?', status: 'FAILED', detail: 'trade not found in sheet' }); continue; }
      const symbol = g.rows[0].o.Symbol.trim().toUpperCase();
      try {
        const date = normDate(g.rows[0].o['Date (IST)']);
        // fills in time order; direction from the first fill (the Direction column can be wrong)
        const fills = g.rows.map((r) => ({
          r, ts: parseIst(`${date} ${normTime(r.o['Time (IST)'])}`),
          side: String(r.o.OrderType).trim().toUpperCase(), qty: parseFloat(r.o.Qty) || 0, price: parseFloat(r.o.Price) || 0,
        })).filter((f) => Number.isFinite(f.ts)).sort((a, b) => a.ts - b.ts);
        if (!date || fills.length === 0) throw new Error('missing date/time on the rows');
        const direction = fills[0].side === 'SELL' ? 'SHORT' : 'LONG';
        const entrySide = direction === 'LONG' ? 'BUY' : 'SELL';
        const entries = fills.filter((f) => f.side === entrySide), exits = fills.filter((f) => f.side !== entrySide);
        const wavg = (a: typeof fills) => { const q = a.reduce((s, f) => s + f.qty, 0); return q ? a.reduce((s, f) => s + f.qty * f.price, 0) / q : 0; };
        const avgEntry = wavg(entries), avgExit = wavg(exits);
        const peak = entries.reduce((s, f) => s + f.qty, 0);
        if (!avgEntry) throw new Error('could not work out the entry price');

        let secId = g.rows[0].o.SecurityId?.trim() || (await deps.lookupSecurityId(symbol)) || '';
        if (!secId) throw new Error(`no Dhan security id for ${symbol}`);

        const from = istDateKey(dateKeyToMs(date) - LOOKBACK_CALENDAR_DAYS * 86400_000);
        const stockC = await deps.dhan.intraday({ securityId: secId, segment: 'NSE_EQ', instrument: 'EQUITY', from, to: date });
        await sleep(SPACING_MS);
        let nifty = niftyCache.get(date);
        if (!nifty) {
          nifty = toSessions(await deps.dhan.intraday({ ...NIFTY500, from: date, to: date }));
          niftyCache.set(date, nifty);
          await sleep(SPACING_MS);
        }
        let prevClose: number | undefined;
        let daily: Awaited<ReturnType<RunDeps['dhan']['daily']>> | undefined;
        try {
          // ~5 years: the previous close, and the history a daily 200 EMA needs to match the chart
          const dailyFrom = istDateKey(dateKeyToMs(date) - 5 * 365 * 86400_000);
          daily = await deps.dhan.daily({ securityId: secId, segment: 'NSE_EQ', instrument: 'EQUITY', from: dailyFrom, to: date });
          prevClose = previousClose(daily, date);
          await sleep(SPACING_MS);
        } catch (e) { if (e instanceof DhanError && (e.isAuth || e.isNoDataPlan)) throw e; /* fall back to last 1-min close */ }

        const stopDist = parseFloat(g.rows[0].o.InitialStopDist);
        const enr = computeEnrichment({
          date, entryMs: fills[0].ts, exitMs: fills[fills.length - 1].ts, direction, entryPrice: avgEntry,
          stock: toSessions(stockC), nifty, stopDist: stopDist > 0 ? stopDist : undefined, prevClose,
        });
        const hard = enr.missing.filter((m) => m === 'stock candles');
        const status: RunItemResult['status'] = hard.length ? 'FAILED' : enr.missing.length ? 'PARTIAL' : 'OK';
        const note = enr.missing.length ? `${status}: missing ${enr.missing.join(', ')}` : 'OK';

        const vals: Record<string, string | number> = {
          Nifty500First5Pct: enr.nifty500First5Pct ?? '', Nifty500AtEntryPct: enr.nifty500AtEntryPct ?? '',
          Rvol5: enr.rvol5 ?? '', RvolAtEntry: enr.rvolAtEntry ?? '', RvolDay5: enr.rvolDay5 ?? '', RvolDayAtEntry: enr.rvolDayAtEntry ?? '', Atr10m: enr.atr10m ?? '', Atr2: enr.atr2 ?? '',
          ChgPrevClosePct: enr.chgPrevClosePct ?? '', GapPct: enr.gapPct ?? '', VwapDistPct: enr.vwapDistPct ?? '',
          MfePct: enr.mfePct ?? '', MaePct: enr.maePct ?? '', MfeR: enr.mfeR ?? '', MaeR: enr.maeR ?? '', RBasis: enr.rBasis ?? '',
          EnrichStatus: status === 'OK' ? 'OK' : note, EnrichedAt: `${istDateKey(nowMs)} ${istTime(nowMs)}`,
        };
        // market context at the first fill (the same facts the co-pilot shows), written by column name
        const cfg = copilotSettings();
        const setupCell = String(g.rows[0].o.Setup ?? '').trim().toLowerCase();
        const initialStop = parseFloat(g.rows[0].o.InitialStop);
        const ctx = computeFacts({
          date, nowMs: fills[0].ts, price: avgEntry, direction, setup: setupCell === 'reversal' ? 'REVERSAL' : 'MOMENTUM',
          stock1m: stockC, nifty1m: { t: [], o: [], h: [], l: [], c: [], v: [] }, daily: daily ?? { t: [], o: [], h: [], l: [], c: [], v: [] },
          plannedStop: initialStop > 0 ? initialStop : undefined,
          riskInr: cfg.riskInr, niftyDirPct: cfg.niftyDirPct, emaReachAtr: cfg.emaReachAtr, pocRows: cfg.pocRows,
        });
        // Nifty for relative strength: rebuild from the cached sessions of that day
        const nDay = nifty.find((x) => x.date === date);
        const nOpen = nDay?.bars[0]?.o, nAt = nDay?.bars.filter((b) => b.t * 1000 < Math.floor(fills[0].ts / 60000) * 60000).at(-1)?.c;
        const stockDay = toSessions(stockC).find((x) => x.date === date);
        const sOpen = stockDay && stockDay.bars.length ? stockDay.bars[0].o : undefined;
        const rs = nOpen && nAt && sOpen && enr.nifty500AtEntryPct !== undefined ? Number(((avgEntry / sOpen - 1) * 100 - enr.nifty500AtEntryPct).toFixed(4)) : '';
        const ctxMissing = ctx.missing.filter((m) => !m.startsWith('nifty') && !m.startsWith('room'));
        const ctxVals: Record<string, string | number> = {
          OrHigh: ctx.OrHigh ?? '', OrLow: ctx.OrLow ?? '', EntryVsOr: ctx.EntryVsOr ?? '',
          PdhDistAtr: ctx.PdhDistAtr ?? '', PdlDistAtr: ctx.PdlDistAtr ?? '',
          Ema200_5mAtr: ctx.Ema200_5mAtr ?? '', Ema200_10mAtr: ctx.Ema200_10mAtr ?? '', Ema200_1dAtr: ctx.Ema200_1dAtr ?? '',
          RsVsNiftyPct: rs, ExtAdrPct: ctx.ExtAdrPct ?? '', PocDistAtr: ctx.PocDistAtr ?? '',
          PullbackNo: ctx.PullbackNo ?? '', VolTrend: ctx.VolTrend ?? '',
          ContextStatus: ctxMissing.length ? `PARTIAL v2: ${ctxMissing.join(', ')}`.slice(0, 200) : 'OK v2',
        };
        for (const k of MONTHLY_CONTEXT_COLS) if (!(k in ctxVals)) ctxVals[k] = '';

        // live columns: only fill when blank
        const fillIfBlank: Record<string, string | number> = {
          SecurityId: secId, EntryTime: istTime(fills[0].ts), ExitTime: istTime(fills[fills.length - 1].ts),
          AvgEntry: Number(avgEntry.toFixed(2)), AvgExit: Number(avgExit.toFixed(2)), PeakQty: peak, DirFromFills: direction,
        };

        // enrichment block is contiguous up to EnrichedAt; Setup (the column after) is never written
        const first = col(MONTHLY_ENRICH_COLS[0]), last = col('EnrichedAt');
        const contiguous = first >= 0 && last > first && MONTHLY_ENRICH_COLS.slice(0, MONTHLY_ENRICH_COLS.indexOf('EnrichedAt') + 1).every((c, i) => col(c) === first + i);
        for (const r of g.rows) {
          if (contiguous) {
            updates.push({ range: `'${tab}'!${colLetter(first)}${r.rowNumber}:${colLetter(last)}${r.rowNumber}`,
              values: [MONTHLY_ENRICH_COLS.slice(0, MONTHLY_ENRICH_COLS.indexOf('EnrichedAt') + 1).map((c) => vals[c] ?? '')] });
          } else {
            for (const [k, v] of Object.entries(vals)) if (col(k) >= 0) updates.push({ range: `'${tab}'!${colLetter(col(k))}${r.rowNumber}`, values: [[v]] });
          }
          for (const [k, v] of Object.entries(ctxVals)) if (col(k) >= 0) updates.push({ range: `'${tab}'!${colLetter(col(k))}${r.rowNumber}`, values: [[v]] });
          for (const [k, v] of Object.entries(fillIfBlank)) {
            const c = col(k);
            if (c >= 0 && !String(r.cells[c] ?? '').trim()) updates.push({ range: `'${tab}'!${colLetter(c)}${r.rowNumber}`, values: [[v]] });
          }
        }
        results.push({ groupId: id, symbol, status, detail: note });
      } catch (e) {
        if (e instanceof DhanError && (e.isAuth || e.isNoDataPlan)) {
          if (updates.length) await deps.sheets.updateRanges(updates, true);
          return { results, aborted: e.isAuth ? 'TOKEN_EXPIRED' : 'NO_DATA_PLAN' };
        }
        const msg = (e as Error).message;
        results.push({ groupId: id, symbol, status: 'FAILED', detail: msg });
        const c = col('EnrichStatus');
        if (c >= 0) for (const r of g.rows) updates.push({ range: `'${tab}'!${colLetter(c)}${r.rowNumber}`, values: [[`FAILED: ${msg}`.slice(0, 120)]] });
      }
    }
    if (updates.length) await deps.sheets.updateRanges(updates, true);
  }
  return { results };
}

export { monthSheetTitle };


/** Shows the raw volume numbers behind a trade's relative volume (for checking against a chart). */
export async function inspectVolume(deps: Pick<RunDeps, 'dhan' | 'sheets' | 'lookupSecurityId'>, item: { tab: string; groupId: string }) {
  if (!TAB_RE.test(item.tab)) throw new Error('unknown tab');
  const { headers, rows } = await deps.sheets.readAll(item.tab);
  const g = groupRows(headers, rows).find((x) => x.groupId === item.groupId);
  if (!g) throw new Error('trade not found');
  const symbol = g.rows[0].o.Symbol.trim().toUpperCase();
  const date = normDate(g.rows[0].o['Date (IST)']);
  const times = g.rows.map((r) => parseIst(`${date} ${normTime(r.o['Time (IST)'])}`)).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const secId = g.rows[0].o.SecurityId?.trim() || (await deps.lookupSecurityId(symbol)) || '';
  if (!secId) throw new Error(`no Dhan security id for ${symbol}`);
  const from = istDateKey(dateKeyToMs(date) - LOOKBACK_CALENDAR_DAYS * 86400_000);
  const c = await deps.dhan.intraday({ securityId: secId, segment: 'NSE_EQ', instrument: 'EQUITY', from, to: date });
  const entryMin = Math.floor(times[0] / 60000) * 60000;
  const mins = new Date(entryMin + 330 * 60_000);
  const entryMinOfDay = mins.getUTCHours() * 60 + mins.getUTCMinutes();
  return { symbol, date, entryTime: istTime(times[0]), securityId: secId, rawCandles: c.t.length, ...volumeDiagnostics(toSessions(c), date, entryMinOfDay) };
}
