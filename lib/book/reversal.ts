import type { BookModel, Side } from './model';

/**
 * Reversal alerts from the order book: price ran into a wall and the push is being absorbed there.
 *
 *  REVERSAL LONG:  price fell into a BUY wall, sellers keep hitting it, the wall holds and price stops falling.
 *  REVERSAL SHORT: price rose into a SELL wall, buyers keep lifting it, the wall holds and price stops rising.
 *
 * All four must be true at the same moment:
 *  1. a wall (4x a normal level) that has been TRADED INTO and is still there (HOLDING), still seen live
 *  2. price sitting on it: best bid (long) / best ask (short) within 2 ticks of the wall
 *  3. absorption over the last 2 minutes: heavy aggression into the wall (2x the other side) and price not giving way
 *  4. there was a move INTO the wall over the last 10 minutes (a reversal needs something to reverse)
 *
 * Plain code, no Claude: checked every couple of seconds per stock for free. It is a "go look" prompt, never a signal.
 */

export type ReversalSide = 'LONG' | 'SHORT';
export interface Reversal {
  side: ReversalSide;
  wallPrice: number; wallSide: Side; wallQty: number; times: number; traded: number; refills: number;
  ltp: number; at: number;
  why: string; // one plain line with the numbers
}
export interface ReversalAlert extends Reversal { id: string; securityId: string; symbol: string }

export const NEAR_TICKS = 2;
export const ABSORB_SEC = 120;
export const MOVE_SEC = 600;

const fmtQ = (q: number) => (q >= 1000 ? `${(q / 1000).toFixed(1)}k` : String(Math.round(q)));

export function detectReversal(model: BookModel, now: number): Reversal | undefined {
  const ltp = model.ltp, bid = model.bestBid, ask = model.bestAsk;
  if (ltp === undefined || bid === undefined || ask === undefined) return undefined;
  if (model.staleSince(now) !== undefined) return undefined; // a frozen book's walls are not real
  const tick = model.tick / 100;
  const f = model.flow(now, ABSORB_SEC);
  if (!f.absorption) return undefined;
  const side: ReversalSide = f.absorption === 'SELLING_ABSORBED' ? 'LONG' : 'SHORT';
  const wallSide: Side = side === 'LONG' ? 'BID' : 'ASK';

  // 4. the move into the wall: at least 5 ticks and 0.2% of price over the last 10 minutes
  const move = model.flow(now, MOVE_SEC).moveTicks * tick;
  const need = Math.max(5 * tick, ltp * 0.002);
  if (side === 'LONG' ? move > -need : move < need) return undefined;

  // 1 + 2. a holding wall on that side, right where price is
  const touch = side === 'LONG' ? bid : ask;
  const wall = model.walls(now, 5)
    .filter((w) => w.side === wallSide && w.status === 'HOLDING' && w.seenAgoSec <= 10)
    .filter((w) => (side === 'LONG' ? touch - w.price : w.price - touch) >= -tick / 2 && Math.abs(touch - w.price) <= NEAR_TICKS * tick + 1e-9)
    .sort((a, b) => b.qty - a.qty)[0];
  if (!wall) return undefined;

  const hit = side === 'LONG' ? f.sell : f.buy, other = side === 'LONG' ? f.buy : f.sell;
  const why = side === 'LONG'
    ? `Fell ${Math.abs(move).toFixed(2)} into a ${fmtQ(wall.qty)} buy wall at ${wall.price.toFixed(2)} (${wall.times}x normal). 2 min: sellers ${fmtQ(hit)} vs buyers ${fmtQ(other)}, price ${f.moveTicks >= 0 ? '+' : ''}${f.moveTicks} ticks: selling absorbed${wall.refills ? `, refilled ${wall.refills}x` : ''}.`
    : `Rose ${move.toFixed(2)} into a ${fmtQ(wall.qty)} sell wall at ${wall.price.toFixed(2)} (${wall.times}x normal). 2 min: buyers ${fmtQ(hit)} vs sellers ${fmtQ(other)}, price ${f.moveTicks >= 0 ? '+' : ''}${f.moveTicks} ticks: buying absorbed${wall.refills ? `, refilled ${wall.refills}x` : ''}.`;
  return { side, wallPrice: wall.price, wallSide, wallQty: wall.qty, times: wall.times, traded: wall.traded, refills: wall.refills, ltp, at: now, why };
}

/**
 * Runs the check per stock as its events arrive (not on a timer, so a background tab is not slowed down), at most
 * every 2 s per stock, and fires once per wall: the same wall cannot alert again for 15 minutes.
 */
export class ReversalWatch {
  private lastCheck = new Map<string, number>();
  private fired = new Map<string, number>();
  private onAlert: (a: ReversalAlert) => void;
  private everyMs: number;
  private cooldownMs: number;
  constructor(onAlert: (a: ReversalAlert) => void, everyMs = 2_000, cooldownMs = 15 * 60_000) {
    this.onAlert = onAlert; this.everyMs = everyMs; this.cooldownMs = cooldownMs;
  }

  check(securityId: string, symbol: string, model: BookModel, t: number) {
    if (t - (this.lastCheck.get(securityId) ?? 0) < this.everyMs) return;
    this.lastCheck.set(securityId, t);
    const r = detectReversal(model, t);
    if (!r) return;
    const key = `${securityId}:${r.side}:${r.wallPrice.toFixed(2)}`;
    if (t - (this.fired.get(key) ?? -Infinity) < this.cooldownMs) return;
    this.fired.set(key, t);
    this.onAlert({ ...r, id: `${key}:${t}`, securityId, symbol });
  }
}
