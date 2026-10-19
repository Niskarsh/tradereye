import type { BookModel, Wall } from './model';
import type { DayContext } from './context';

/**
 * Reversal at the day's extreme (his rule set, 19 Oct). Fires only when ALL of these line up:
 *
 *  1. ZONE: price works in a band at the day's high (short) / low (long), not one exact price. The band is the top
 *     (bottom) 15% of today's range, at least 0.3 ATR (10-min) wide.
 *  2. STRETCHED: the day's run that way is bigger than 70% of recent days (the co-pilot's stretch measure).
 *  3. REJECTION, the fakeout filter, all three:
 *     - a wall (4x a normal level) on the far side, inside or just beyond the zone, there 2+ minutes, not pulled;
 *     - 2+ pushes into the zone in the last 15 minutes, the last one NOT clearly beyond the earlier ones;
 *     - the aggression behind the pushes fading: less aggressive buying (selling) into the last push than the one before.
 *  4. TRIGGER, control flips: since the last push topped out, the other side has been the aggressor (1.5x), and
 *     price breaks the swing low (high) between the last two pushes. The first touch never alerts.
 *  5. Nifty 500 running hard with the stock (trend that way AND still moving that way in the last 10 min): no alert.
 *  6. WORTH IT: room to today's POC at least as big as the stop (stop just beyond the zone / wall, 2x ATR at most).
 *
 * Breakouts cancel themselves: a new high moves the zone up, and the old pushes fall out of it.
 */

export type ExtremeSide = 'SHORT' | 'LONG';
export interface Push { high: number; low: number; t: number; start: number; aggr: number } // high = extreme (low for LONG)
export interface ExtremePlan { entry: number; stop: number; target: number; risk: number; reward: number; rr: number; qty: number; capped: boolean }
export interface ExtremeSetup {
  side: ExtremeSide; at: number; ltp: number;
  zone: [number, number]; dayHigh: number; dayLow: number;
  wall: Wall; pushes: Push[]; breakLevel: number;
  flowSincePush: { buy: number; sell: number };
  plan: ExtremePlan;
  niftyNote: string; emaNote?: string; stretchPct: number;
  why: string;
}

export const ZONE_SHARE = 0.15, ZONE_MIN_ATR = 0.3, STRETCH_MIN = 70, LOOKBACK_MS = 15 * 60_000, WALL_MIN_AGE = 2, FLIP_X = 1.5;

const fmtQ = (q: number) => (q >= 1000 ? `${(q / 1000).toFixed(1)}k` : String(Math.round(q)));

/** Pushes into the zone from the price series: a push ends when price backs off `rev` from its best inside the zone. */
export function findPushes(pts: { t: number; p: number }[], side: ExtremeSide, edge: number, rev: number): { pushes: Push[]; inPush: boolean } {
  const s = side === 'SHORT' ? 1 : -1; // work in "up = toward the extreme"
  const pushes: Push[] = [];
  let inPush = false, best = 0, bestT = 0, start = 0, since = Infinity;
  for (const { t, p } of pts) {
    const x = s * p;
    // a push starts in the zone; after one ends, the next only counts once price has come back up `rev` from its
    // pullback (otherwise every wiggle inside the zone would count as a new push)
    if (x >= s * edge && (inPush || !pushes.length || x - since >= rev)) {
      if (!inPush) {
        // a new push: freeze the pullback low after the previous one
        if (pushes.length) pushes[pushes.length - 1].low = s * since;
        inPush = true; best = x; bestT = t; start = t;
      } else if (x > best) { best = x; bestT = t; }
    }
    if (inPush && best - x >= rev) {
      pushes.push({ high: s * best, low: s * x, t: bestT, start, aggr: 0 });
      inPush = false; since = x;
    } else if (!inPush) since = Math.min(since, x);
  }
  if (!inPush && pushes.length) pushes[pushes.length - 1].low = s * since;
  return { pushes, inPush };
}

/** Aggressive volume toward the extreme while a push was being made (buyers for SHORT, sellers for LONG). */
function aggression(model: BookModel, side: ExtremeSide, from: number, to: number): number {
  let v = 0;
  for (const tr of model.trades) { const t = tr.t * 1000; if (t >= from - 1000 && t <= to + 1000) v += side === 'SHORT' ? tr.buy : tr.sell; }
  return v;
}

export function detectExtreme(model: BookModel, ctx: DayContext, live: { high?: number; low?: number }, now: number): ExtremeSetup | undefined {
  const ltp = model.ltp, atr = ctx.atr10m, poc = ctx.poc;
  if (ltp === undefined || !atr || poc === undefined) return undefined;
  if (model.staleSince(now) !== undefined) return undefined; // a frozen book's walls are not real
  const high = Math.max(ctx.dayHigh ?? -Infinity, live.high ?? -Infinity), low = Math.min(ctx.dayLow ?? Infinity, live.low ?? Infinity);
  if (!Number.isFinite(high) || !Number.isFinite(low) || !(high > low)) return undefined;
  const tick = model.tick / 100;
  const band = Math.max(ZONE_SHARE * (high - low), ZONE_MIN_ATR * atr);

  for (const side of ['SHORT', 'LONG'] as const) {
    const s = side === 'SHORT' ? 1 : -1;
    const extreme = side === 'SHORT' ? high : low;
    const edge = extreme - s * band;
    // 2. stretched that way
    const stretchPct = ctx.stretchRunPct ?? 0;
    if (ctx.stretchDir !== (side === 'SHORT' ? 'UP' : 'DOWN') || stretchPct < STRETCH_MIN) continue;
    // 5. Nifty running hard with the stock
    const nUp = ctx.niftyNowTrend === 'RISING' && (ctx.niftyLast10Pct ?? 0) > 0;
    const nDown = ctx.niftyNowTrend === 'FALLING' && (ctx.niftyLast10Pct ?? 0) < 0;
    if (side === 'SHORT' ? nUp : nDown) continue;
    // 3a. the wall on the far side, in or just beyond the zone
    const wallSide = side === 'SHORT' ? 'ASK' : 'BID';
    const wall = model.walls(now, 6)
      .filter((w) => w.side === wallSide && w.seenAgoSec <= 10 && w.ageMin >= WALL_MIN_AGE)
      .filter((w) => s * w.price >= s * edge && s * w.price <= s * extreme + band * 0.5)
      .sort((a, b) => b.qty - a.qty)[0];
    if (!wall) continue;
    // 3b. pushes into the zone in the last 15 minutes
    const pts = model.quotes.filter((q) => q.t >= now - LOOKBACK_MS && q.t <= now && q.ltp !== undefined).map((q) => ({ t: q.t, p: q.ltp! }));
    const rev = Math.max(0.2 * atr, 3 * tick);
    const { pushes, inPush } = findPushes(pts, side, edge, rev);
    if (inPush || pushes.length < 2) continue;
    const last = pushes[pushes.length - 1], prev = pushes[pushes.length - 2];
    const bestBefore = Math.max(...pushes.slice(0, -1).map((p) => s * p.high));
    if (s * last.high > bestBefore + tick + 1e-9) continue; // the last push made real progress: not failing
    // 3c. fading aggression
    for (const p of pushes) p.aggr = aggression(model, side, p.start, p.t);
    if (!(last.aggr < prev.aggr)) continue;
    // 4. trigger: break of the swing between the last two pushes, and control flipped since the last push topped
    const breakLevel = prev.low;
    if (!(s * ltp < s * breakLevel)) continue;
    const f = model.flow(now, Math.max(20, Math.ceil((now - last.t) / 1000)));
    const against = side === 'SHORT' ? f.sell : f.buy, withIt = side === 'SHORT' ? f.buy : f.sell;
    if (!(against >= FLIP_X * withIt && against > 0)) continue;
    // 6. the trade: stop just beyond the zone / wall, 2x ATR at most; target today's POC
    const beyond = s * Math.max(s * extreme, s * wall.price) + s * Math.max(0.1 * atr, tick);
    let risk = s * (beyond - ltp), capped = false;
    if (risk > 2 * atr) { risk = 2 * atr; capped = true; }
    const stop = ltp + s * risk;
    const reward = s * (ltp - poc);
    if (!(reward > 0) || !(risk > 0) || reward < risk) continue;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const rr = reward / risk;
    // size from the rupee stop distance shown on the card, so the numbers he reads always multiply out
    const qty = Math.floor(ctx.riskInr / Math.max(r2(risk), 0.01));
    const plan: ExtremePlan = { entry: r2(ltp), stop: r2(stop), target: r2(poc), risk: r2(risk), reward: r2(reward), rr: Math.round(rr * 10) / 10, qty, capped };
    const niftyNote = ctx.niftyLast10Pct === undefined ? 'Nifty 500: not known'
      : (side === 'SHORT' ? ctx.niftyLast10Pct < 0 : ctx.niftyLast10Pct > 0) ? `Nifty 500 turning ${side === 'SHORT' ? 'down' : 'up'} (${ctx.niftyLast10Pct > 0 ? '+' : ''}${ctx.niftyLast10Pct.toFixed(2)}% last 10 min)`
      : `Nifty 500 not helping yet (${ctx.niftyLast10Pct > 0 ? '+' : ''}${ctx.niftyLast10Pct.toFixed(2)}% last 10 min)`;
    const emaNote = side === 'SHORT' ? ctx.emaInPathShort : ctx.emaInPathLong;
    const word = side === 'SHORT' ? 'high' : 'low';
    const why = `${pushes.length} pushes at the day ${word} failed under a ${fmtQ(wall.qty)} ${side === 'SHORT' ? 'sell' : 'buy'} wall at ${wall.price.toFixed(2)} (there ${wall.ageMin} min); `
      + `${side === 'SHORT' ? 'buying' : 'selling'} faded ${fmtQ(prev.aggr)} → ${fmtQ(last.aggr)}; now ${side === 'SHORT' ? 'sellers' : 'buyers'} ${fmtQ(against)} vs ${fmtQ(withIt)} since the last push, and price broke ${breakLevel.toFixed(2)}. `
      + `Run bigger than ${stretchPct}% of recent days. ${niftyNote}.${emaNote ? ` 200 EMA in the way: ${emaNote}.` : ''}`;
    return {
      side, at: now, ltp, zone: side === 'SHORT' ? [r2(edge), r2(high)] : [r2(low), r2(edge)], dayHigh: high, dayLow: low,
      wall, pushes, breakLevel, flowSincePush: { buy: f.buy, sell: f.sell }, plan, niftyNote, emaNote, stretchPct, why,
    };
  }
  return undefined;
}
