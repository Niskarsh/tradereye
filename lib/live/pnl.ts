import type { Pnl, TradeGroup } from './types';

const r2 = (n: number) => Number(n.toFixed(2));

/**
 * Same charge model as app/sync-trades/page.tsx (kept identical on purpose so auto-logged trades
 * and manually-logged trades are comparable in Stats).
 */
export function computeCharges(buyVal: number, sellVal: number) {
  const turnover = r2(buyVal + sellVal);
  const brokerage = r2(Math.min(buyVal * 0.0003, 20) + Math.min(sellVal * 0.0003, 20));
  const exchTxn = r2(turnover * 0.00003071);
  const stt = r2(sellVal * 0.00025);
  const sebi = r2(turnover * 0.000001);
  const stamp = r2(buyVal * 0.00003);
  const gst = r2((brokerage + exchTxn + sebi) * 0.18);
  const totalCharges = r2(brokerage + exchTxn + sebi + stt + stamp + gst);
  return { turnover, brokerage, exchTxn, stt, sebi, stamp, gst, totalCharges };
}

/** Realised P&L for a CLOSED group (gross = sells - buys, exactly like the manual sync page). */
export function computePnl(g: TradeGroup): Pnl {
  let bVal = 0, sVal = 0, bQty = 0, sQty = 0;
  for (const p of g.parts) {
    const val = r2(p.fill.price * p.qty);
    if (p.fill.side === 'BUY') { bVal += val; bQty += p.qty; } else { sVal += val; sQty += p.qty; }
  }
  const grossPnL = r2(sVal - bVal);
  const { totalCharges } = computeCharges(bVal, sVal);
  const netPnL = r2(grossPnL - totalCharges);
  return {
    grossPnL, netPnL, totalCharges,
    durationSec: Math.max(0, Math.round((g.lastTs - g.entryTs) / 1000)),
    status: netPnL >= 0 ? 'WIN' : 'LOSS',
    isConsistent: bQty === sQty && bQty > 0,
    buyQty: bQty, sellQty: sQty,
  };
}
