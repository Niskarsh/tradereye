import type { DhanClient } from '../dhan';
import { colLetter, type Cell, type SheetsClient } from '../sheetsApi';
import { toSessions, type Bar } from '../live/enrich';
import { MONTHS, normTime, parseIst } from '../live/time';

/**
 * "What happened next" for every co-pilot check, taken or skipped: over the 30 minutes after the check, the best and
 * worst move from the check price in R (R = your planned stop distance, else 2x ATR) and whether that stop would have
 * been hit. This is what makes skipped checks worth keeping.
 */

export const CHECKS_TAB_RE = new RegExp(`^(${MONTHS.join('|')})-\\d{4}-checks$`);
const WINDOW_MIN = 30;
const SPACING_MS = 220;

export interface Outcome { mfeR: number; maeR: number; hitStop: boolean }

/** Pure: bars that start after the check minute and within the next 30 minutes. */
export function outcomeOf(bars: Bar[], p: { ts: number; price: number; direction: 'LONG' | 'SHORT'; dist: number }): Outcome | undefined {
  const start = Math.floor(p.ts / 60000) * 60000 + 60000;
  const win = bars.filter((b) => b.t * 1000 >= start && b.t * 1000 < start + WINDOW_MIN * 60000);
  if (!win.length || !(p.dist > 0)) return undefined;
  const hi = Math.max(...win.map((b) => b.h)), lo = Math.min(...win.map((b) => b.l));
  const fav = p.direction === 'LONG' ? hi - p.price : p.price - lo;
  const adv = p.direction === 'LONG' ? p.price - lo : hi - p.price;
  return { mfeR: Number((Math.max(fav, 0) / p.dist).toFixed(2)), maeR: Number((Math.max(adv, 0) / p.dist).toFixed(2)), hitStop: adv >= p.dist };
}

export interface OutcomeItem { tab: string; checkId: string }

export async function planOutcomes(sheets: SheetsClient, nowMs: number): Promise<OutcomeItem[]> {
  const tabs = (await sheets.listTabs(true)).map((t) => t.title).filter((t) => CHECKS_TAB_RE.test(t));
  const items: OutcomeItem[] = [];
  for (const tab of tabs) {
    const { headers, rows } = await sheets.readAll(tab);
    const c = (n: string) => headers.indexOf(n);
    for (const r of rows) {
      const id = r.cells[c('CheckId')] ?? '';
      if (!id || String(r.cells[c('AfterMfeR30')] ?? '').trim() !== '') continue;
      const ts = parseIst(`${r.cells[c('Date')]} ${normTime(r.cells[c('Time')])}`);
      if (Number.isFinite(ts) && ts + (WINDOW_MIN + 1) * 60000 <= nowMs) items.push({ tab, checkId: id });
    }
  }
  return items;
}

export async function runOutcomes(
  deps: { dhan: Pick<DhanClient, 'intraday'>; sheets: SheetsClient; sleep?: (ms: number) => Promise<void> },
  items: OutcomeItem[],
): Promise<{ done: number; skipped: number }> {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cache = new Map<string, Bar[]>();
  let done = 0, skipped = 0;
  const byTab = new Map<string, string[]>();
  for (const it of items) if (CHECKS_TAB_RE.test(it.tab)) byTab.set(it.tab, [...(byTab.get(it.tab) ?? []), it.checkId]);
  for (const [tab, ids] of byTab) {
    const { headers, rows } = await deps.sheets.readAll(tab);
    const c = (n: string) => headers.indexOf(n);
    const q = `'${tab.replace(/'/g, "''")}'`;
    const updates: { range: string; values: Cell[][] }[] = [];
    const put = (row: number, col: string, v: Cell) => { if (c(col) >= 0) updates.push({ range: `${q}!${colLetter(c(col))}${row}`, values: [[v]] }); };
    for (const id of ids) {
      const r = rows.find((x) => x.cells[c('CheckId')] === id);
      if (!r) { skipped++; continue; }
      const get = (n: string) => String(r.cells[c(n)] ?? '').trim();
      const date = get('Date'), secId = get('SecurityId');
      const price = parseFloat(get('Ltp')), stop = parseFloat(get('PlannedStop')), atr2 = parseFloat(get('Atr2'));
      const direction = get('Direction') === 'SHORT' ? 'SHORT' : 'LONG';
      const dist = stop > 0 && Math.abs(price - stop) > 0 ? Math.abs(price - stop) : atr2;
      const ts = parseIst(`${date} ${normTime(get('Time'))}`);
      if (!secId || !(price > 0) || !(dist > 0) || !Number.isFinite(ts)) { put(r.rowNumber, 'AfterMfeR30', 'n/a'); skipped++; continue; }
      const key = `${secId}|${date}`;
      let bars = cache.get(key);
      if (!bars) {
        const cs = await deps.dhan.intraday({ securityId: secId, segment: 'NSE_EQ', instrument: 'EQUITY', from: date, to: date });
        bars = toSessions(cs).find((s) => s.date === date)?.bars ?? [];
        cache.set(key, bars);
        await sleep(SPACING_MS);
      }
      const o = outcomeOf(bars, { ts, price, direction, dist });
      if (!o) { put(r.rowNumber, 'AfterMfeR30', 'n/a'); skipped++; continue; }
      put(r.rowNumber, 'AfterMfeR30', o.mfeR); put(r.rowNumber, 'AfterMaeR30', o.maeR); put(r.rowNumber, 'AfterHitStop', o.hitStop ? 'YES' : 'NO');
      done++;
    }
    if (updates.length) await deps.sheets.updateRanges(updates, true);
  }
  return { done, skipped };
}
