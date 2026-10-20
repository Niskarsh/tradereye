import { normDate, normTime } from '../live/time';
import { slot30 } from './cases';

/**
 * His own trades on the same yardstick as the backtest: R after charges, R before charges, the charges in R, the
 * hit rate (made money after charges), per month, per setup, per time of day and per exit type.
 *
 * Read from the monthly journal tabs (one row per fill; group values repeat on every row, so everything is counted
 * once per TradeGroupId). R = net P&L / the rupees he actually risked (RiskInr = his first stop's distance x quantity,
 * logged live). Trades with no logged stop use his max risk (₹300) and are counted separately, so they can be judged
 * on their own.
 */

export interface MyTrade {
  id: string; date: string; month: string; symbol: string; dir: 'LONG' | 'SHORT';
  entry: string; slot30: string; setup: string; exitType: string;
  net: number; gross: number; charges: number; risk: number; riskLogged: boolean;
  netR: number; grossR: number; costR: number;
}

/** header -> cell (the same as sheetsApi's rowToObject, without pulling the Google client into the tests) */
const rowToObject = (headers: string[], cells: string[]): Record<string, string> => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
const num = (v: unknown) => { const x = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : NaN; };
const r2 = (n: number) => Math.round(n * 100) / 100;

export function scoreTrades(headers: string[], rows: { cells: string[] }[], defaultRisk = 300): MyTrade[] {
  const seen = new Map<string, MyTrade>();
  for (const r of rows) {
    const o = rowToObject(headers, r.cells);
    const id = (o.TradeGroupId ?? '').trim();
    if (!id || !o.Symbol || seen.has(id)) continue;
    const net = num(o.NetPnL), gross = num(o.GrossPnL);
    if (!Number.isFinite(net)) continue;
    const charges = Number.isFinite(num(o.TotalCharges)) ? num(o.TotalCharges) : Number.isFinite(gross) ? gross - net : 0;
    const logged = num(o.RiskInr);
    const risk = logged > 0 ? logged : defaultRisk;
    const date = normDate(o['Date (IST)']);
    const t = normTime(o.EntryTime || o['Time (IST)']);
    const [hh, mm] = t.split(':').map(Number);
    const slot = Number.isFinite(hh) ? hh * 60 + (mm || 0) - 555 : NaN;
    const dirRaw = String(o.DirFromFills || o.Direction || '').trim().toUpperCase();
    const g = Number.isFinite(gross) ? gross : net + charges;
    seen.set(id, {
      id, date, month: date.slice(0, 7), symbol: o.Symbol.trim().toUpperCase(), dir: dirRaw === 'SHORT' ? 'SHORT' : 'LONG',
      entry: t.slice(0, 5), slot30: Number.isFinite(slot) && slot >= 0 ? slot30(slot) : '', setup: String(o.Setup ?? '').trim().toLowerCase() || 'not tagged',
      exitType: String(o.ExitType ?? '').trim().toUpperCase() || 'UNKNOWN',
      net, gross: g, charges, risk, riskLogged: logged > 0,
      netR: r2(net / risk), grossR: r2(g / risk), costR: r2(charges / risk),
    });
  }
  return [...seen.values()].sort((a, b) => (a.date === b.date ? a.entry.localeCompare(b.entry) : a.date < b.date ? -1 : 1));
}

export interface MyStats { n: number; hit: number; netR: number; grossR: number; costR: number; totalNet: number; totalCharges: number }
export function myStats(t: MyTrade[]): MyStats {
  const n = t.length;
  const sum = (f: (x: MyTrade) => number) => t.reduce((a, x) => a + f(x), 0);
  return {
    n, hit: n ? r2(t.filter((x) => x.net > 0).length / n) : 0,
    netR: n ? r2(sum((x) => x.netR) / n) : 0, grossR: n ? r2(sum((x) => x.grossR) / n) : 0, costR: n ? r2(sum((x) => x.costR) / n) : 0,
    totalNet: Math.round(sum((x) => x.net)), totalCharges: Math.round(sum((x) => x.charges)),
  };
}

export interface MyReport {
  all: MyStats; riskLogged: MyStats; riskAssumed: MyStats;
  byMonth: { key: string; stats: MyStats }[]; bySetup: { key: string; stats: MyStats }[];
  byTime: { key: string; stats: MyStats }[]; byExit: { key: string; stats: MyStats }[]; byDir: { key: string; stats: MyStats }[];
  trades: MyTrade[];
}

export function myReport(t: MyTrade[]): MyReport {
  const group = (f: (x: MyTrade) => string) => {
    const m = new Map<string, MyTrade[]>();
    for (const x of t) { const k = f(x) || '?'; const a = m.get(k) ?? []; a.push(x); m.set(k, a); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, g]) => ({ key, stats: myStats(g) }));
  };
  return {
    all: myStats(t), riskLogged: myStats(t.filter((x) => x.riskLogged)), riskAssumed: myStats(t.filter((x) => !x.riskLogged)),
    byMonth: group((x) => x.month), bySetup: group((x) => x.setup), byTime: group((x) => x.slot30), byExit: group((x) => x.exitType), byDir: group((x) => x.dir),
    trades: t,
  };
}
