import type { SheetsClient } from '../sheetsApi';
import { colLetter, rowToObject } from '../sheetsApi';
import { DhanError, previousClose, type DhanClient } from '../dhan';
import { LOOKBACK_CALENDAR_DAYS, computeEnrichment, toSessions } from './enrich';
import { MONTHLY_ALL, MONTHLY_ENRICH_COLS } from './schema';
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
      const ok = st === 'OK';
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
        try {
          const dailyFrom = istDateKey(dateKeyToMs(date) - 10 * 86400_000);
          prevClose = previousClose(await deps.dhan.daily({ securityId: secId, segment: 'NSE_EQ', instrument: 'EQUITY', from: dailyFrom, to: date }), date);
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
