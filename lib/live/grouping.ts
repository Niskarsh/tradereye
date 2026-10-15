import type { Direction, Fill, FillPart, TradeGroup } from './types';
import { istDateKey } from './time';

/**
 * Turns a day's executions into trades.
 *
 * A trade = the life of a position in one symbol: it starts when the net quantity leaves zero and
 * ends when it returns to zero. Adds, partial exits and scale-outs all stay inside the same trade.
 * Direction is the side of the FIRST fill (BUY -> LONG, SELL -> SHORT). A single fill that flips the
 * position (e.g. long 10 then sell 15) is split: 10 closes the long, 5 opens a new short trade.
 */
export function groupFills(fills: Fill[]): TradeGroup[] {
  const bySymbol = new Map<string, Fill[]>();
  for (const f of fills) {
    const arr = bySymbol.get(f.symbol) ?? [];
    arr.push(f);
    bySymbol.set(f.symbol, arr);
  }

  const out: TradeGroup[] = [];

  for (const [symbol, list] of bySymbol) {
    const sorted = [...list].sort((a, b) => a.ts - b.ts || a.tradeId.localeCompare(b.tradeId));
    let cur: TradeGroup | null = null;
    let net = 0;       // signed open quantity
    let avgCost = 0;   // average price of the open quantity
    let entryQty = 0, entryVal = 0, exitQty = 0, exitVal = 0;
    // an add is a NEW entry order; one order split into several fills by the exchange is not an add
    let entryOrders = new Set<string>();
    const orderKey = (f: { orderId?: string; ts: number }) => f.orderId || `t${Math.floor(f.ts / 3000)}`;

    const finish = (g: TradeGroup) => {
      g.status = g.netQty === 0 ? 'CLOSED' : 'OPEN';
      g.avgEntry = entryQty ? entryVal / entryQty : 0;
      g.avgExit = exitQty ? exitVal / exitQty : 0;
      g.avgCost = g.netQty === 0 ? g.avgEntry : avgCost;
      out.push(g);
    };

    for (const fill of sorted) {
      let remaining = fill.qty;
      const sign = fill.side === 'BUY' ? 1 : -1;
      const parts: FillPart[] = [];

      while (remaining > 0) {
        if (!cur) {
          const direction: Direction = sign > 0 ? 'LONG' : 'SHORT';
          cur = {
            id: `TRD-${fill.ts}-${symbol}`,
            date: istDateKey(fill.ts),
            symbol, securityId: fill.securityId, segment: fill.segment,
            direction, status: 'OPEN', netQty: 0, avgCost: 0, avgEntry: 0, avgExit: 0,
            peakQty: 0, adds: 0, realizedGross: 0,
            buyQty: 0, sellQty: 0, buyVal: 0, sellVal: 0,
            entryTs: fill.ts, lastTs: fill.ts, parts: [],
          };
          net = 0; avgCost = 0; entryQty = 0; entryVal = 0; exitQty = 0; exitVal = 0; entryOrders = new Set();
        }
        const dirSign = cur.direction === 'LONG' ? 1 : -1;
        const isEntry = sign === dirSign;
        const take = isEntry ? remaining : Math.min(remaining, Math.abs(net));

        const part: FillPart = { fill, qty: take, partId: fill.tradeId };
        cur.parts.push(part);
        parts.push(part);

        const val = Number((fill.price * take).toFixed(2));
        if (fill.side === 'BUY') { cur.buyQty += take; cur.buyVal += val; } else { cur.sellQty += take; cur.sellVal += val; }
        cur.lastTs = fill.ts;

        if (isEntry) {
          const k = orderKey(fill);
          if (entryQty > 0 && !entryOrders.has(k)) cur.adds += 1;
          entryOrders.add(k);
          avgCost = (avgCost * Math.abs(net) + fill.price * take) / (Math.abs(net) + take);
          net += sign * take;
          entryQty += take; entryVal += fill.price * take;
          cur.peakQty = Math.max(cur.peakQty, Math.abs(net));
        } else {
          cur.realizedGross += (fill.price - avgCost) * take * dirSign;
          net += sign * take;
          exitQty += take; exitVal += fill.price * take;
        }
        cur.netQty = net;
        remaining -= take;

        if (net === 0) { finish(cur); cur = null; }
      }

      // A fill split across two trades keeps unique, stable ids (tradeId~1, tradeId~2).
      if (parts.length > 1) parts.forEach((p, i) => { p.partId = `${fill.tradeId}~${i + 1}`; });
    }

    if (cur) finish(cur);
  }

  for (const g of out) g.realizedGross = Number(g.realizedGross.toFixed(2));
  return out.sort((a, b) => a.entryTs - b.entryTs);
}

/** Open quantity (absolute) and average cost of a group as of a moment in time. */
export function positionAt(g: TradeGroup, ts: number): { qty: number; avgCost: number } {
  const dirSign = g.direction === 'LONG' ? 1 : -1;
  let net = 0, avg = 0;
  for (const p of g.parts) {
    if (p.fill.ts > ts) break;
    const sign = p.fill.side === 'BUY' ? 1 : -1;
    if (sign === dirSign) {
      avg = (avg * Math.abs(net) + p.fill.price * p.qty) / (Math.abs(net) + p.qty);
      net += sign * p.qty;
    } else {
      net += sign * p.qty;
    }
  }
  return { qty: Math.abs(net), avgCost: avg };
}
