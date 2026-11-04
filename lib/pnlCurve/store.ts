import { createHash } from 'node:crypto';
import { MONTHS, gunzip, gzip } from '../book/record';
import { dayIsOver, loadDayMinutes, type LoadDeps } from '../candles/store';
import type { Candles } from '../dhan';
import { normalizeTrade } from '../live/orders';
import { buildCurve, estimateCharges, positionsKey, type Curve, type PnlFill, type PnlPosition } from './curve';

/**
 * The day's curve in S3, so it is worked out once:
 *   pnl-curve/2026/november/2026-11-04.json.gz
 * Saved only when the day is over and every stock had candles. The file remembers what it was built from: if that
 * day's trades are edited in the journal the fingerprint no longer matches and the curve is drawn again.
 */

interface CurveFile { v: 1; hash: string; savedAt: number; curve: Curve }

export const curveKey = (date: string) => {
  const [y, m] = date.split('-');
  return `pnl-curve/${y}/${MONTHS[Number(m) - 1]}/${date}.json.gz`;
};
export const curveHash = (positions: PnlPosition[]) => createHash('sha256').update(positionsKey(positions)).digest('hex').slice(0, 24);

export interface CurveResult { curve: Curve; fromS3: boolean; saved: boolean; live: boolean }

export async function loadCurve(deps: LoadDeps, date: string, positions: PnlPosition[]): Promise<CurveResult> {
  const now = (deps.now ?? Date.now)();
  const hash = curveHash(positions);
  const key = curveKey(date);
  const over = dayIsOver(date, now);
  if (over) {
    const bytes = await deps.store.get(key).catch(() => undefined);
    if (bytes) {
      try {
        const f = JSON.parse(await gunzip(bytes)) as CurveFile;
        if (f?.v === 1 && f.hash === hash && f.curve?.times) return { curve: f.curve, fromS3: true, saved: true, live: false };
      } catch { /* a broken file is treated as missing and written again */ }
    }
  }
  const candles: Record<string, Candles> = {};
  // one stock at a time: Dhan allows 5 data requests a second; throws NeedsDhanError when not saved and no token
  for (const p of positions) candles[p.symbol] = await loadDayMinutes(deps, { symbol: p.symbol, date, securityId: p.securityId });
  const curve = buildCurve(date, positions, candles, over ? undefined : now);
  let saved = false;
  if (over && positions.every((p) => candles[p.symbol]?.t.length)) {
    try {
      const file: CurveFile = { v: 1, hash, savedAt: now, curve };
      await deps.store.put(key, await gzip(JSON.stringify(file)));
      saved = true;
    } catch { /* a failed save never breaks the chart: worked out again next time */ }
  }
  return { curve, fromS3: false, saved, live: !over };
}

/**
 * While today's market is open, Dhan's trade book is the truth: the journal logs a trade only once it closes, so a
 * running position is only there. What the journal knows (direction, stop, target) is kept for each stock.
 */
export function positionsFromTradeBook(date: string, raw: unknown[], journal: PnlPosition[]): PnlPosition[] {
  const by = new Map<string, { securityId: string; fills: PnlFill[] }>();
  for (const r of raw) {
    const f = normalizeTrade(r);
    if (!f || !f.time.startsWith(date) || (f.segment && f.segment !== 'NSE_EQ')) continue;
    const x = by.get(f.symbol) ?? { securityId: f.securityId, fills: [] };
    x.fills.push({ t: f.ts, side: f.side === 'SELL' ? 'SELL' : 'BUY', qty: f.qty, price: f.price });
    by.set(f.symbol, x);
  }
  return [...by].map(([symbol, x]) => {
    const j = journal.find((p) => p.symbol === symbol);
    return { ...j, symbol, securityId: x.securityId, fills: x.fills, charges: estimateCharges(x.fills) };
  });
}
