/**
 * What happened after each alert, so the rules get judged on his stocks, not on one session.
 *
 * Every alert (wall reversal and day-extreme reversal) is followed on the live price for 30 minutes, or until the
 * plan's stop or target is hit (day-extreme alerts carry a plan; wall alerts do not):
 *  - best and worst move in the alert's direction (MFE / MAE, in rupees and in 10-min ATR when known)
 *  - move after 10 and 30 minutes
 *  - for a plan: which came first, TARGET or STOP (or neither in 30 min)
 * One log per day: order-book/alerts/<date>.json.gz in S3, rewritten as alerts finish.
 */

export type Kind = 'WALL' | 'EXTREME';
export interface Tracked {
  id: string; kind: Kind; symbol: string; securityId: string; side: 'LONG' | 'SHORT'; at: number; entry: number;
  stop?: number; target?: number; atr?: number;
  mfe: number; mae: number; after10?: number; after30?: number;
  first?: 'TARGET' | 'STOP'; firstAt?: number; done: boolean; endedAt?: number;
}

export const FOLLOW_MS = 30 * 60_000;

export class OutcomeLog {
  items: Tracked[] = [];
  onFinish?: (t: Tracked) => void;

  start(a: Omit<Tracked, 'mfe' | 'mae' | 'done'>) { this.items.push({ ...a, mfe: 0, mae: 0, done: false }); }

  /** A live price for a stock: update every open alert on it. */
  price(securityId: string, p: number, t: number) {
    for (const x of this.items) {
      if (x.done || x.securityId !== securityId || t < x.at) continue;
      const s = x.side === 'LONG' ? 1 : -1;
      const move = Math.round(s * (p - x.entry) * 100) / 100;
      x.mfe = Math.max(x.mfe, move); x.mae = Math.min(x.mae, move);
      if (x.after10 === undefined && t - x.at >= 10 * 60_000) x.after10 = move;
      if (!x.first && x.target !== undefined && s * (p - x.target) >= 0) { x.first = 'TARGET'; x.firstAt = t; }
      if (!x.first && x.stop !== undefined && s * (p - x.stop) <= 0) { x.first = 'STOP'; x.firstAt = t; }
      const timeUp = t - x.at >= FOLLOW_MS;
      if (timeUp) x.after30 = move;
      if (timeUp || x.first) { x.done = true; x.endedAt = t; this.onFinish?.(x); }
    }
  }

  /** Plain rows for the day file (ATR-scaled moves added where ATR is known). */
  rows() {
    return this.items.map((x) => ({
      ...x,
      mfeAtr: x.atr ? Math.round((x.mfe / x.atr) * 100) / 100 : undefined,
      maeAtr: x.atr ? Math.round((x.mae / x.atr) * 100) / 100 : undefined,
    }));
  }
}

export const alertLogKey = (date: string) => `order-book/alerts/${date}.json.gz`;
export const ALERT_LOG_RE = /^order-book\/alerts\/\d{4}-\d{2}-\d{2}\.json\.gz$/;
