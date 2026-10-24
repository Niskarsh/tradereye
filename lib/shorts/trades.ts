import { normDate, normTime } from '../live/time';

/**
 * Real trades for the shorts, straight from the monthly journal tabs (one row per fill; trade-level values repeat on
 * every row). Nothing here is invented: prices, times and fills are the journal's, R is the journal's own yardstick
 * (net P&L after charges / the rupees actually risked, RiskInr), exactly as My Setups scores his trades.
 */

export interface Fill { time: string; price: number; qty: number; kind: 'in' | 'out' }

export interface ShortTrade {
  id: string; date: string; symbol: string; dir: 'LONG' | 'SHORT';
  entryTime: string; exitTime: string;          // HH:mm:ss
  avgEntry: number; avgExit: number;
  stop?: number;                                 // the first stop he placed (InitialStop), when logged
  fills: Fill[];
  net: number;                                   // ₹ after charges
  risk?: number;                                 // RiskInr, when logged
  netR?: number;                                 // net / risk, only when the risk was logged
  movePct: number;                               // price move in his favour, entry to exit, %
  holdMin: number;
  exitType: string;
}

const rowToObject = (headers: string[], cells: string[]): Record<string, string> => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
const num = (v: unknown) => { const x = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : NaN; };
const r2 = (n: number) => Math.round(n * 100) / 100;
export const secOfDay = (hhmmss: string) => { const [h, m, s] = hhmmss.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
const avg = (f: Fill[]) => { const q = f.reduce((a, x) => a + x.qty, 0); return q > 0 ? f.reduce((a, x) => a + x.price * x.qty, 0) / q : NaN; };

/** Every closed trade in one monthly tab, with its fills. Trades that cannot be drawn honestly are left out. */
export function journalShortTrades(headers: string[], rows: { cells: string[] }[]): ShortTrade[] {
  const groups = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    const o = rowToObject(headers, r.cells);
    const id = (o.TradeGroupId ?? '').trim();
    if (!id || !o.Symbol) continue;
    const g = groups.get(id) ?? [];
    g.push(o);
    groups.set(id, g);
  }
  const out: ShortTrade[] = [];
  for (const [id, g] of groups) {
    const o = g[0];
    const date = normDate(o['Date (IST)']);
    const dirRaw = `${o.DirFromFills || o.Direction || ''}`.trim().toUpperCase();
    const dir: 'LONG' | 'SHORT' = /SHORT|SELL/.test(dirRaw) ? 'SHORT' : 'LONG';
    const inSide = dir === 'LONG' ? 'BUY' : 'SELL';
    const fills: Fill[] = g.map((x) => ({
      time: normTime(x['Time (IST)']) || '', price: num(x.Price), qty: Math.abs(num(x.Qty)),
      kind: (String(x.OrderType ?? '').trim().toUpperCase() === inSide ? 'in' : 'out') as 'in' | 'out',
    })).filter((f) => f.time && f.price > 0 && f.qty > 0).sort((a, b) => secOfDay(a.time) - secOfDay(b.time));
    const ins = fills.filter((f) => f.kind === 'in'), outs = fills.filter((f) => f.kind === 'out');
    const net = num(o.NetPnL);
    if (!date || !ins.length || !outs.length || !Number.isFinite(net)) continue; // open, or not a full trade
    const avgEntry = num(o.AvgEntry) > 0 ? num(o.AvgEntry) : avg(ins);
    const avgExit = num(o.AvgExit) > 0 ? num(o.AvgExit) : avg(outs);
    const entryTime = normTime(o.EntryTime) || ins[0].time, exitTime = normTime(o.ExitTime) || outs[outs.length - 1].time;
    const risk = num(o.RiskInr) > 0 ? num(o.RiskInr) : undefined;
    const stop = num(o.InitialStop) > 0 ? num(o.InitialStop) : undefined;
    out.push({
      id, date, symbol: o.Symbol.trim().toUpperCase(), dir, entryTime, exitTime, avgEntry: r2(avgEntry), avgExit: r2(avgExit),
      stop, fills, net: r2(net), risk, netR: risk ? r2(net / risk) : undefined,
      movePct: r2(((dir === 'LONG' ? avgExit - avgEntry : avgEntry - avgExit) / avgEntry) * 100),
      holdMin: Math.max(1, Math.round((secOfDay(exitTime) - secOfDay(entryTime)) / 60)),
      exitType: String(o.ExitType ?? '').trim().toUpperCase() || 'UNKNOWN',
    });
  }
  return out.sort((a, b) => (a.date === b.date ? a.entryTime.localeCompare(b.entryTime) : a.date < b.date ? -1 : 1));
}

/** "+2.7R" when his risk was logged, otherwise the price move ("+0.46%"): never an assumed R. */
export function resultOf(t: ShortTrade): { value: number; unit: 'R' | '%' } {
  return t.netR !== undefined ? { value: Math.round(t.netR * 10) / 10, unit: 'R' } : { value: t.movePct, unit: '%' };
}

const IST = 19800_000;
export const istToday = (now = Date.now()) => new Date(now + IST).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/**
 * SEBI: price data used in market education must be at least three months old. Mystery charts reveal the ticker and
 * date, so only trades older than this can be used. Kept a little over 3 months on purpose.
 */
export const MYSTERY_MIN_AGE_DAYS = 92;
export const mysteryCutoff = (now = Date.now()) => addDays(istToday(now), -MYSTERY_MIN_AGE_DAYS);
export const mysteryEligible = (t: ShortTrade, now = Date.now()) => t.date <= mysteryCutoff(now) && t.holdMin >= 3;

/* ---------------- Me vs Algo ---------------- */

export interface AlgoOrder { date: string; symbol: string; sentAt: number; risk?: number; stop: number; status: string; avgPrice?: number }

/** Monday of the week a date falls in. */
export const weekOf = (date: string) => { const d = new Date(`${date}T00:00:00Z`); const wd = (d.getUTCDay() + 6) % 7; return addDays(date, -wd); };
const istSecOfDay = (ms: number) => { const d = new Date(ms + IST); return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(); };

/**
 * Splits journal trades into his own and Algo Live's: a trade is the algo's when an Algo Live order for the same day,
 * stock and side filled (the nearest one in time, within 5 minutes). Everything else is his.
 */
export function splitMeAlgo(trades: ShortTrade[], orders: AlgoOrder[]): { me: ShortTrade[]; algo: (ShortTrade & { orderRisk?: number })[] } {
  const filled = orders.filter((o) => !/REJECT|CANCEL/i.test(o.status) && (o.avgPrice ?? 0) > 0);
  const taken = new Set<string>();
  const algo: (ShortTrade & { orderRisk?: number })[] = [];
  for (const o of filled) {
    const cands = trades.filter((t) => !taken.has(t.id) && t.date === o.date && t.symbol === o.symbol.trim().toUpperCase() && t.dir === 'SHORT');
    const best = cands.map((t) => ({ t, d: Math.abs(secOfDay(t.entryTime) - istSecOfDay(o.sentAt)) })).sort((a, b) => a.d - b.d)[0];
    if (!best || best.d > 300) continue;
    taken.add(best.t.id);
    algo.push({ ...best.t, orderRisk: o.risk });
  }
  return { me: trades.filter((t) => !taken.has(t.id)), algo };
}

/** R for the scoreboard: the journal's own R, else net / the risk the algo sized the order for; else not counted. */
export const scoreR = (t: ShortTrade & { orderRisk?: number }) => (t.netR !== undefined ? t.netR : t.orderRisk ? r2(t.net / t.orderRisk) : undefined);

export interface WeekScore { week: string; me: { r: number; n: number; uncounted: number }; algo: { r: number; n: number; uncounted: number }; winner: 'me' | 'algo' | 'tie' | 'none' }

export function scoreWeek(week: string, me: ShortTrade[], algo: (ShortTrade & { orderRisk?: number })[]): WeekScore {
  const side = (ts: (ShortTrade & { orderRisk?: number })[]) => {
    const rs = ts.map(scoreR);
    return { r: r2(rs.reduce<number>((a, x) => a + (x ?? 0), 0)), n: rs.filter((x) => x !== undefined).length, uncounted: rs.filter((x) => x === undefined).length };
  };
  const m = side(me), a = side(algo);
  const winner = !m.n && !a.n ? 'none' : m.r > a.r ? 'me' : a.r > m.r ? 'algo' : 'tie';
  return { week, me: m, algo: a, winner };
}

/** Season table up to and including `week`: wins per side (ties and empty weeks count for nobody). */
export function seasonScore(weeks: WeekScore[], upTo: string): { me: number; algo: number } {
  const s = { me: 0, algo: 0 };
  for (const w of weeks) if (w.week <= upTo) { if (w.winner === 'me') s.me++; if (w.winner === 'algo') s.algo++; }
  return s;
}

/** The trade that decided a side's week: the one with the biggest R either way (a stop-out is as much a story). */
export function tradeOfWeek<T extends ShortTrade & { orderRisk?: number }>(ts: T[]): T | undefined {
  return ts.filter((t) => scoreR(t) !== undefined).sort((a, b) => Math.abs(scoreR(b)!) - Math.abs(scoreR(a)!))[0];
}
