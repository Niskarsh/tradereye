import type { DayState, OrderRec } from './engine';
import { slotTime } from './engine';
import type { FillRow } from './fills';

/**
 * Backtest vs live, day by day (read only). For every day Algo Live has run, the trades the backtest's F took that day
 * (the newest Algo Lab run's own out-of-sample trades) next to the orders Algo Live sent, each mismatch with its reason
 * as Algo Live's own day file recorded it. R here is before charges on both sides (the backtest's `gross`), so the two
 * are measured the same way.
 */

/** one backtest trade: [day, symbol, time HH:MM, side, prediction, net R, gross R, ...] (ml.json tradeCols) */
export type BtTrade = [string, string, string, number, number, number, number, ...unknown[]];

export type RowKind = 'same' | 'other-time' | 'missed' | 'extra';
export interface Row { symbol: string; kind: RowKind; btTime?: string; liveTime?: string; btR?: number; liveR?: number | null; exit?: string; why: string }
export interface Day { date: string; inBacktest: boolean; ran: boolean; bar: number | null; rows: Row[] }
export interface Totals { days: number; btTrades: number; liveTrades: number; same: number; missed: number; extra: number; btR: number; liveR: number; liveClosed: number }

const toSlot = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m - 555; };
const rr = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(2)}R`);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** a live trade's R before charges, from its fill and its journal exit (null while open or unknown) */
function liveR(o: OrderRec, fill?: FillRow): number | null {
  if (!fill || fill.exit == null) return null;
  const dist = o.stop - fill.entry;
  return dist > 0 ? r2((fill.entry - fill.exit) / dist) : null;
}

/** why the backtest's trade has no live order on that day */
function whyMissed(s: DayState, sym: string, time: string): string {
  if (!s.list.some((x) => x.symbol === sym)) return 'Not on the live day list that morning';
  const tick = s.ticks[String(toSlot(time))];
  if (!tick) return `The ${time} close was not run live (page not open then?)`;
  if (s.vetoes.includes(sym)) return 'You vetoed it';
  const sc = tick.scored.find((x) => x.symbol === sym);
  if (!sc || sc.pred == null) return tick.missing.includes(sym) ? `Its candles were missing live at ${time}` : `No live score at ${time}${sc?.note ? `: ${sc.note}` : ''}`;
  if (!sc.above) return `Live scored it ${rr(sc.pred)}, under the bar ${rr(s.model?.threshold)}`;
  if (tick.picked.includes(sym)) return 'Picked live, but no order went (not armed, or the order failed)';
  return 'Over the bar live but not picked (2 already taken that day)';
}

export function reconcile(dates: string[], states: (DayState | undefined)[], bt: BtTrade[], dataTo: string, fills: FillRow[]): { days: Day[]; totals: Totals } {
  const days: Day[] = [];
  const t: Totals = { days: 0, btTrades: 0, liveTrades: 0, same: 0, missed: 0, extra: 0, btR: 0, liveR: 0, liveClosed: 0 };
  dates.forEach((date, i) => {
    const s = states[i];
    const orders = (s?.orders ?? []).filter((o) => !/REJECT|CANCEL/i.test(o.status));
    const ran = !!s && s.list.length > 0;
    const inBacktest = date <= dataTo;
    const mine = bt.filter((x) => x[0] === date);
    if (!ran && !mine.length) return; // a holiday, or a day with nothing on either side
    const fill = (o: OrderRec) => fills.find((f) => f.date === date && f.symbol === o.symbol);
    const rows: Row[] = [];
    const used = new Set<OrderRec>();
    if (inBacktest) {
      for (const x of mine) {
        const [, sym, time, , , , gross] = x;
        const o = orders.find((y) => y.symbol === sym && !used.has(y));
        if (o) {
          used.add(o);
          const lt = slotTime(o.slot), f = fill(o);
          rows.push({ symbol: sym, kind: lt === time ? 'same' : 'other-time', btTime: time, liveTime: lt, btR: gross, liveR: liveR(o, f), exit: f?.exitType,
            why: lt === time ? 'Taken live as in the backtest' : `Taken live at ${lt}, the backtest at ${time}` });
        } else rows.push({ symbol: sym, kind: 'missed', btTime: time, btR: gross, why: s && ran ? whyMissed(s, sym, time) : 'Algo Live did not run that day (no day list)' });
      }
    }
    for (const o of orders) {
      if (used.has(o)) continue;
      const lt = slotTime(o.slot), f = fill(o);
      const earlier = mine.filter((x) => x[2] < lt).length;
      rows.push({ symbol: o.symbol, kind: 'extra', liveTime: lt, liveR: liveR(o, f), exit: f?.exitType,
        why: !inBacktest ? 'After the backtest\'s data: the next Re-run checks it'
          : earlier >= 2 ? 'The backtest had already taken its 2 that day' : 'The backtest did not take it (the full-day candles or its score differed)' });
    }
    rows.sort((a, b) => (a.btTime ?? a.liveTime ?? '').localeCompare(b.btTime ?? b.liveTime ?? ''));
    days.push({ date, inBacktest, ran, bar: s?.model?.threshold ?? null, rows });
    if (!inBacktest) return;
    t.days++;
    for (const r of rows) {
      if (r.kind !== 'extra') { t.btTrades++; t.btR += r.btR ?? 0; }
      if (r.kind === 'same' || r.kind === 'other-time') t.same++;
      if (r.kind === 'missed') t.missed++;
      if (r.kind === 'extra') t.extra++;
      if (r.kind !== 'missed') { t.liveTrades++; if (r.liveR != null) { t.liveR += r.liveR; t.liveClosed++; } }
    }
  });
  t.btR = r2(t.btR); t.liveR = r2(t.liveR);
  return { days: days.reverse(), totals: t };
}
