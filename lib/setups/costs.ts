/**
 * Dhan's charges for one NSE intraday equity round trip (buy + sell), in rupees. An estimate for the backtest: it
 * uses the published rates, not a contract note.
 *  - brokerage: ₹20 or 0.03% of the order value per executed order, whichever is lower
 *  - STT 0.025% on the sell side; NSE transaction 0.00297% both sides; SEBI ₹10 per crore; stamp duty 0.003% on the buy
 *  - NSE investor protection fund (IPFT) ₹10 per crore both sides
 *  - GST 18% on brokerage + transaction + SEBI + IPFT
 */
export function roundTripCharges(qty: number, entry: number, exit: number, dir: 1 | -1): number {
  if (!(qty > 0)) return 0;
  const buy = qty * (dir === 1 ? entry : exit);
  const sell = qty * (dir === 1 ? exit : entry);
  const brokerage = Math.min(20, buy * 0.0003) + Math.min(20, sell * 0.0003);
  const stt = sell * 0.00025;
  const txn = (buy + sell) * 0.0000297;
  const sebi = (buy + sell) * 0.000001;
  const ipft = (buy + sell) * 0.000001; // NSE investor protection fund: ₹10 per crore
  const stamp = buy * 0.00003;
  const gst = 0.18 * (brokerage + txn + sebi + ipft);
  return brokerage + stt + txn + sebi + ipft + stamp + gst;
}

/** Shares bought for a risk budget: as many as the stop distance allows (at least 1). */
export function sizeFor(riskInr: number, stopDist: number): number {
  return stopDist > 0 ? Math.max(1, Math.floor(riskInr / stopDist)) : 0;
}

/**
 * Dhan's charges for one NSE delivery round trip (buy, hold, sell), in rupees: brokerage ₹0, STT 0.1% on both sides,
 * NSE transaction 0.00297% both sides, SEBI ₹10 per crore, stamp duty 0.015% on the buy, DP charge ₹12.50 + GST on
 * the sell, GST 18% on transaction + SEBI + DP.
 */
export function deliveryCharges(qty: number, buyPx: number, sellPx: number): number {
  if (!(qty > 0)) return 0;
  const buy = qty * buyPx, sell = qty * sellPx;
  const stt = (buy + sell) * 0.001;
  const txn = (buy + sell) * 0.0000297;
  const sebi = (buy + sell) * 0.000001;
  const stamp = buy * 0.00015;
  const dp = 12.5;
  return stt + txn + sebi + stamp + dp + 0.18 * (txn + sebi + dp);
}
