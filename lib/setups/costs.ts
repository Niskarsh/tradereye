/**
 * Dhan's charges for one NSE intraday equity round trip (buy + sell), in rupees. An estimate for the backtest: it
 * uses the published rates, not a contract note.
 *  - brokerage: ₹20 or 0.03% of the order value per executed order, whichever is lower
 *  - STT 0.025% on the sell side; NSE transaction 0.00297% both sides; SEBI ₹10 per crore; stamp duty 0.003% on the buy
 *  - GST 18% on brokerage + transaction + SEBI
 */
export function roundTripCharges(qty: number, entry: number, exit: number, dir: 1 | -1): number {
  if (!(qty > 0)) return 0;
  const buy = qty * (dir === 1 ? entry : exit);
  const sell = qty * (dir === 1 ? exit : entry);
  const brokerage = Math.min(20, buy * 0.0003) + Math.min(20, sell * 0.0003);
  const stt = sell * 0.00025;
  const txn = (buy + sell) * 0.0000297;
  const sebi = (buy + sell) * 0.000001;
  const stamp = buy * 0.00003;
  const gst = 0.18 * (brokerage + txn + sebi);
  return brokerage + stt + txn + sebi + stamp + gst;
}

/** Shares bought for a risk budget: as many as the stop distance allows (at least 1). */
export function sizeFor(riskInr: number, stopDist: number): number {
  return stopDist > 0 ? Math.max(1, Math.floor(riskInr / stopDist)) : 0;
}
