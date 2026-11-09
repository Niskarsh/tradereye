import type { DepthMsg, QuoteMsg } from './feed';

/**
 * The order book over time for one stock, Bookmap style.
 *
 * Built only from timestamped events (depth updates and quotes), so the same events always give the same picture:
 * live, after a refresh (replayed from S3), or in the journal. Nothing depends on timers, so a background tab
 * (where browsers slow timers down) leaves no gaps.
 *
 * Each price keeps its LAST SEEN size and side, even after it leaves the 20-level window: it stays drawn (fading
 * once it has not been seen for a minute) until price comes back and shows fresh numbers. Drawing uses SEGMENTS:
 * one per stretch of time a price held the same size on the same side.
 *
 * Walls (4x a normal level) are tracked through their life: RESTING (not touched), HOLDING (traded into and still
 * there: absorption), PULLED (gone without much trading: never real), EATEN (traded through: really taken out).
 */

export type Side = 'BID' | 'ASK';
export type WallStatus = 'RESTING' | 'HOLDING' | 'PULLED' | 'EATEN';

export interface Level { side: Side; qty: number; seenAt: number; firstAt: number; maxQty: number; traded: number; refills: number; lastDrop: number; seg: Segment }
export interface Segment { p: number; side: Side; qty: number; t0: number; t1?: number; seenTill: number }
export interface TradeBucket { t: number; buy: number; sell: number; price: number } // per second
export interface Quote { t: number; bid?: number; ask?: number; ltp?: number }
export interface Wall { price: number; side: Side; qty: number; maxQty: number; times: number; ageMin: number; traded: number; refills: number; status: WallStatus; endedAgoSec?: number; endedAt?: number; seenAgoSec: number }
export interface Flow { sec: number; buy: number; sell: number; moveTicks: number; move: number; recordedSec: number; absorption?: 'BUYING_ABSORBED' | 'SELLING_ABSORBED' }
/** How the best bid and ask moved over a window (rupees), and the spread at its end. */
export interface PriceRead { bid: number; ask: number; mid: number; spread: number; spanSec: number; totalBuy?: number; totalSell?: number; atp?: number }
/** Who looks in control right now, from the book and the tape (a hint for the eye, never a certainty). */
export interface Bias {
  side: 'UP' | 'DOWN' | 'NEUTRAL';
  label: string;               // e.g. "Buyers in control", "Buying absorbed"
  why: string;                 // one plain line with the numbers behind it
  score: number;               // -1 (sellers) .. +1 (buyers)
}
export interface Candle { t0: number; o: number; h: number; l: number; c: number }
export interface Gap { from: number; to: number }

const key = (price: number) => Math.round(price * 100); // paise
const WALL_X = 4;
/** "Book near price" compares the same number of quoted levels on each side, each counted from its own best price. */
const NEAR_LEVELS = 5;
/** No quote for this long = the feed was away: the volume that piled up is not one burst of trades. */
const QUOTE_SILENCE_MS = 60_000;
/** Depth and quotes arrive on separate sockets: a wall's disappearance and its trades can land this far apart. */
const PRINT_MATCH_MS = 3_000;
/** "Price did not move" is judged in money (0.03% of price), never in ticks: a tick is 1 paisa on some stocks, 5 on others. */
const FLAT_SHARE = 0.0003;

export class BookModel {
  levels = new Map<number, Level>();
  segments: Segment[] = [];
  trades: TradeBucket[] = [];
  quotes: Quote[] = [];
  gaps: Gap[] = [];
  tick = 5; // paise, learned from the book
  bestBid?: number; bestAsk?: number; ltp?: number;
  lastEventAt = 0;
  lastVolume = 0;
  /**
   * Frozen-feed check. Dhan sometimes keeps sending one stock's book as the SAME snapshot (it looks alive, but
   * nothing moves) while its trades keep coming. Two tells: price trades well outside the book (2+ ticks beyond
   * the best bid / ask for 15 s), or 90 s of no change at all in the book while trades keep printing.
   */
  bookChangedAt = 0;
  private tradesSinceChange = 0;
  private outsideSince?: number;
  private tradeLog: { t: number; buy: number; sell: number; ltp: number; mid: number }[] = [];
  private prints: { t: number; lo: number; hi: number; at: number; dv: number; aggressed?: Side }[] = [];
  private lastDir?: 'BUY' | 'SELL';
  /** when the first event of this model arrived, and the last quote (keyframes set it too) */
  firstEventAt = 0;
  lastQuoteAt = 0;
  /** straight from Dhan's quote packet: all pending quantity on each side (not just 20 levels), and the day's VWAP */
  totalBuy?: number; totalSell?: number; atp?: number;
  private ended: { w: Wall; at: number }[] = [];

  /** History before this moment was dropped to save memory (stocks recorded but not on screen). */
  trimmedBefore = 0;
  trim(before: number) {
    this.segments = this.segments.filter((s) => s.t1 === undefined || s.t1 >= before);
    this.trades = this.trades.filter((x) => x.t * 1000 >= before);
    this.quotes = this.quotes.filter((x) => x.t >= before);
    this.gaps = this.gaps.filter((g) => g.to >= before);
    this.trimmedBefore = Math.max(this.trimmedBefore, before);
  }

  /** Time with no data at all (tab closed, laptop asleep, disconnected): drawn as a shaded gap. */
  markGap(from: number, to: number) { if (to - from > 5_000) this.gaps.push({ from, to }); }

  onDepth(m: DepthMsg, now: number) {
    if (!m.levels.length) return;
    this.touch(now);
    const ks = m.levels.map((l) => key(l.price));
    const present = new Set(ks);
    const lo = Math.min(...ks), hi = Math.max(...ks);
    const sorted = [...ks].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) { const g = sorted[i] - sorted[i - 1]; if (g > 0 && g < this.tick) this.tick = g; }
    for (const l of m.levels) this.set(key(l.price), m.side, l.qty, now);
    // prices inside the window that are no longer quoted on this side: those orders are gone
    // anything BETTER than the far end of this side's 20 levels must be in the message if it still exists (that
    // includes prices beyond the best bid / ask: when the best bid drops, the old best bid is gone, not "resting")
    for (const [p, lv] of this.levels) if (lv.side === m.side && lv.qty > 0 && !present.has(p) && (m.side === 'BID' ? p > lo : p < hi)) this.set(p, m.side, 0, now);
    if (m.side === 'BID') this.bestBid = hi / 100; else this.bestAsk = lo / 100;
    this.pushQuote(now);
  }

  onQuote(q: QuoteMsg, now: number) {
    this.touch(now);
    const prevLtp = this.ltp;
    this.ltp = q.ltp;
    if (q.totalBuy > 0 || q.totalSell > 0) { this.totalBuy = q.totalBuy; this.totalSell = q.totalSell; }
    if (q.atp && q.atp > 0) this.atp = q.atp;
    // after a silence (tab asleep, socket dropped, app started late) the volume jump is everything that was missed:
    // it must not be booked as one giant buy or sell at this moment
    const afterSilence = this.lastQuoteAt > 0 && now - this.lastQuoteAt > QUOTE_SILENCE_MS;
    this.lastQuoteAt = now;
    if (this.lastVolume > 0 && q.volume > this.lastVolume && !afterSilence) {
      const dv = q.volume - this.lastVolume;
      const dir = this.aggressor(q.ltp, prevLtp);
      const buy = dir === 'BUY' ? dv : dir === 'SELL' ? 0 : dv / 2, sell = dv - buy;
      const lv = this.levels.get(key(q.ltp));
      if (lv) lv.traded += dv;
      this.notePrint(q.ltp, prevLtp, dv, dir, now);
      const sec = Math.floor(now / 1000);
      const last = this.trades[this.trades.length - 1];
      if (last && last.t === sec) { last.buy += buy; last.sell += sell; last.price = q.ltp; } else this.trades.push({ t: sec, buy, sell, price: q.ltp });
      const mid = this.bestBid !== undefined && this.bestAsk !== undefined && this.bestAsk > this.bestBid ? (this.bestBid + this.bestAsk) / 2 : q.ltp;
      this.tradeLog.push({ t: now, buy, sell, ltp: q.ltp, mid });
      if (this.tradeLog.length > 20000) this.tradeLog.splice(0, 5000);
    }
    if (this.lastVolume > 0 && q.volume > this.lastVolume) {
      this.tradesSinceChange++;
      const tk = this.tick / 100;
      const outside = (this.bestBid !== undefined && q.ltp < this.bestBid - 2 * tk - 1e-9) || (this.bestAsk !== undefined && q.ltp > this.bestAsk + 2 * tk + 1e-9);
      if (!outside) this.outsideSince = undefined; else this.outsideSince ??= now;
    }
    if (q.volume > 0) this.lastVolume = q.volume;
    this.pushQuote(now);
  }

  /**
   * Who started a trade: above the middle of the spread a buyer lifted the offer, below it a seller hit the bid. Exactly
   * on the middle (or the book is crossed / missing): the direction of the price change, else the last known direction.
   */
  private aggressor(ltp: number, prev: number | undefined): 'BUY' | 'SELL' | undefined {
    const b = this.bestBid, a = this.bestAsk, eps = 1e-3; // float32 prices
    let dir: 'BUY' | 'SELL' | undefined;
    if (b !== undefined && a !== undefined && a > b) { const mid = (a + b) / 2; if (ltp > mid + eps) dir = 'BUY'; else if (ltp < mid - eps) dir = 'SELL'; }
    if (!dir && prev !== undefined) dir = ltp > prev + eps ? 'BUY' : ltp < prev - eps ? 'SELL' : this.lastDir;
    if (dir) this.lastDir = dir;
    return dir;
  }

  /**
   * A trade print can sweep several prices between two quotes, and the depth feed can report a level gone BEFORE the
   * quote feed reports the trades that took it (separate sockets). So prints are remembered for a few seconds, and
   * the two are matched in whichever order they arrive; otherwise a level that was traded away reads as "pulled".
   */
  private notePrint(ltp: number, prev: number | undefined, dv: number, dir: 'BUY' | 'SELL' | undefined, now: number) {
    const at = key(ltp), from = prev === undefined ? at : key(prev);
    const lo = Math.min(at, from), hi = Math.max(at, from);
    const aggressed: Side | undefined = dir === 'BUY' ? 'ASK' : dir === 'SELL' ? 'BID' : undefined;
    this.prints = this.prints.filter((x) => now - x.t <= PRINT_MATCH_MS);
    this.prints.push({ t: now, lo, hi, at, dv, aggressed });
    for (let i = this.ended.length - 1; i >= 0; i--) {
      const e = this.ended[i];
      if (now - e.at > PRINT_MATCH_MS) break;
      const p = key(e.w.price);
      if (p < lo || p > hi || (aggressed && e.w.side !== aggressed)) continue;
      e.w.traded = Math.min(e.w.maxQty, e.w.traded + Math.round(dv));
      e.w.status = e.w.traded >= e.w.maxQty * 0.5 ? 'EATEN' : 'PULLED';
    }
  }

  private touch(now: number) {
    if (!this.firstEventAt) this.firstEventAt = now;
    if (this.lastEventAt && now - this.lastEventAt > 60_000) this.markGap(this.lastEventAt, now);
    this.lastEventAt = now;
  }

  private pushQuote(now: number) {
    const last = this.quotes[this.quotes.length - 1];
    if (last && last.bid === this.bestBid && last.ask === this.bestAsk && last.ltp === this.ltp) return;
    if (last && now - last.t < 250) { last.bid = this.bestBid; last.ask = this.bestAsk; last.ltp = this.ltp; return; }
    this.quotes.push({ t: now, bid: this.bestBid, ask: this.bestAsk, ltp: this.ltp });
  }

  private set(p: number, side: Side, qty: number, now: number) {
    const lv = this.levels.get(p);
    if (!lv || lv.side !== side) {
      if (qty > 0 || lv) this.bookChanged(now);
      if (lv && lv.qty > 0) {
        // the price changed sides: price traded through it. Real only if shares actually traded there.
        this.endWall(p, lv, now);
        lv.seg.t1 = now;
      } else if (lv) lv.seg.t1 = lv.seg.t1 ?? now;
      const seg: Segment = { p, side, qty, t0: now, seenTill: now };
      if (qty > 0) this.segments.push(seg);
      this.levels.set(p, { side, qty, seenAt: now, firstAt: now, maxQty: qty, traded: 0, refills: 0, lastDrop: 0, seg });
      return;
    }
    if (qty === lv.qty) { lv.seenAt = now; lv.seg.seenTill = now; return; }
    this.bookChanged(now);
    if (qty < lv.qty) lv.lastDrop = now;
    else if (lv.lastDrop && now - lv.lastDrop < 120_000 && lv.traded > 0) lv.refills++;
    if (qty === 0 && lv.qty > 0) this.endWall(p, lv, now);
    // close the old segment, open a new one
    lv.seg.t1 = now;
    const seg: Segment = { p, side, qty, t0: now, seenTill: now };
    if (qty > 0) this.segments.push(seg);
    lv.seg = seg;
    lv.qty = qty; lv.seenAt = now; lv.maxQty = Math.max(lv.maxQty, qty);
    if (qty === 0) { lv.firstAt = now; lv.maxQty = 0; lv.traded = 0; lv.refills = 0; }
  }

  private bookChanged(now: number) { this.bookChangedAt = now; this.tradesSinceChange = 0; this.outsideSince = undefined; }

  /** Since when the book has looked frozen (undefined = it is live). */
  staleSince(now: number): number | undefined {
    return this.staleKind(now) ? this.bookChangedAt : undefined;
  }

  /**
   * Which tell fired. OUTSIDE (price trading 2+ ticks beyond the book for 15 s) is proof the book is stale.
   * UNCHANGED (no change in 90 s while trades print) can also be Dhan's depth stream just being sparse, which it
   * sometimes is (19 Oct: 4 of 20 stocks updated in a minute): enough to distrust the book, not to reconnect for.
   */
  staleKind(now: number): 'OUTSIDE' | 'UNCHANGED' | undefined {
    if (!this.bookChangedAt) return undefined; // no book at all is a different problem
    if (this.outsideSince !== undefined && now - this.outsideSince >= 15_000) return 'OUTSIDE';
    if (now - this.bookChangedAt >= 90_000 && this.tradesSinceChange >= 5) return 'UNCHANGED';
    return undefined;
  }

  /** A wall has gone. EATEN = at least half of it really traded (counting prints that swept its price just before); else PULLED. */
  private endWall(p: number, lv: Level, now: number) {
    const med = this.median(lv.side, now);
    if (!med || lv.maxQty < WALL_X * med) return;
    let traded = lv.traded;
    // prints that ended exactly here were already added to the level; the others swept past it
    for (const x of this.prints) if (now - x.t <= PRINT_MATCH_MS && p >= x.lo && p <= x.hi && p !== x.at && (!x.aggressed || x.aggressed === lv.side)) traded += x.dv;
    traded = Math.min(lv.maxQty, Math.round(traded));
    const status: WallStatus = traded >= lv.maxQty * 0.5 ? 'EATEN' : 'PULLED';
    this.ended.push({ at: now, w: { price: p / 100, side: lv.side, qty: 0, maxQty: lv.maxQty, times: Math.round((lv.maxQty / med) * 10) / 10, ageMin: Math.round((now - lv.firstAt) / 60000), traded, refills: lv.refills, status, seenAgoSec: 0, endedAt: now } });
    if (this.ended.length > 400) this.ended.splice(0, 100);
  }

  /** Median size of the levels currently quoted on a side (what a "normal" level looks like right now). */
  median(side: Side, now: number): number {
    const q: number[] = [];
    for (const l of this.levels.values()) if (l.side === side && l.qty > 0 && now - l.seenAt < 30_000) q.push(l.qty);
    q.sort((a, b) => a - b);
    return q.length ? q[Math.floor(q.length / 2)] : 0;
  }

  /** Live walls: up to `max` nearest the price on each side (a wall = 4x the median level on its side). */
  walls(now: number, max = 3): Wall[] {
    const out: Wall[] = [];
    for (const side of ['ASK', 'BID'] as Side[]) {
      const med = this.median(side, now);
      if (!med) continue;
      for (const [p, lv] of this.levels) {
        if (lv.side !== side || lv.qty < WALL_X * med) continue;
        out.push({
          price: p / 100, side, qty: lv.qty, maxQty: lv.maxQty, times: Math.round((lv.qty / med) * 10) / 10,
          ageMin: Math.round((now - lv.firstAt) / 60000), traded: Math.round(lv.traded), refills: lv.refills,
          status: lv.traded >= lv.maxQty * 0.25 ? 'HOLDING' : 'RESTING', seenAgoSec: Math.round((now - lv.seenAt) / 1000),
        });
      }
    }
    const ref = this.ltp ?? this.bestBid ?? 0;
    const byDist = (a: Wall, b: Wall) => Math.abs(a.price - ref) - Math.abs(b.price - ref);
    return [...out.filter((w) => w.price >= ref).sort(byDist).slice(0, max), ...out.filter((w) => w.price < ref).sort(byDist).slice(0, max)];
  }

  /** Walls that ended (pulled or eaten) between two times (default: the last 15 minutes). */
  endedWalls(now: number, from = now - 15 * 60_000): Wall[] {
    return this.ended.filter((e) => e.at >= from && e.at <= now).map((e) => ({ ...e.w, endedAgoSec: Math.round((now - e.at) / 1000) }));
  }

  /** Aggressive buying vs selling over the last `sec` seconds, and how far price moved for it. */
  flow(now: number, sec: number): Flow {
    const from = now - sec * 1000;
    const recent = this.tradeLog.filter((x) => x.t >= from && x.t <= now);
    const buy = Math.round(recent.reduce((s, x) => s + x.buy, 0)), sell = Math.round(recent.reduce((s, x) => s + x.sell, 0));
    const first = recent[0], last = recent[recent.length - 1];
    const move = recent.length ? Math.round((last.ltp - first.ltp) * 100) / 100 : 0;
    const f: Flow = { sec, buy, sell, moveTicks: Math.round((move * 100) / this.tick), move, recordedSec: this.recordedSec(now, sec) };
    // heavy one-sided aggression and price not moving that way = someone is absorbing it (the fakeout tell)
    // over longer windows a smaller imbalance already means something (it had to persist for minutes)
    // price here is the middle of the spread: the last trade just bounces between bid and ask when the spread is wide
    const ratio = sec >= 300 ? 1.6 : 2;
    if (buy + sell > 0 && recent.length >= 5) {
      const midMove = last.mid - first.mid, flat = this.flatMove();
      if (buy >= ratio * sell && midMove <= flat) f.absorption = 'BUYING_ABSORBED';
      else if (sell >= ratio * buy && midMove >= -flat) f.absorption = 'SELLING_ABSORBED';
    }
    return f;
  }

  /** The biggest move that still counts as "price did not go anywhere", in rupees. */
  private flatMove(): number { return Math.max(this.tick / 100, (this.ltp ?? this.bestBid ?? 0) * FLAT_SHARE); }

  /** How much of the last `sec` seconds this model actually has data for. */
  recordedSec(now: number, sec: number): number {
    const from = Math.max(now - sec * 1000, this.firstEventAt || now);
    let ms = Math.max(0, now - from);
    for (const g of this.gaps) ms -= Math.max(0, Math.min(g.to, now) - Math.max(g.from, from));
    return Math.max(0, Math.round(ms / 1000));
  }

  /** How far the best bid and ask moved over the last `sec` seconds, and the spread at the end. */
  priceRead(now: number, sec: number): PriceRead | undefined {
    const from = now - sec * 1000;
    let first: Quote | undefined, last: Quote | undefined;
    for (let i = this.quotes.length - 1; i >= 0; i--) {
      const q = this.quotes[i];
      if (q.t > now) continue;
      if (q.t < from) break;
      if (q.bid === undefined || q.ask === undefined) continue;
      last ??= q; first = q;
    }
    if (!first || !last) return undefined;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const live = now >= this.lastEventAt - 1000; // the totals are only known as of the latest quote
    return {
      bid: r2(last.bid! - first.bid!), ask: r2(last.ask! - first.ask!), mid: r2((last.bid! + last.ask! - first.bid! - first.ask!) / 2),
      spread: r2(last.ask! - last.bid!), spanSec: Math.round((last.t - first.t) / 1000),
      ...(live ? { totalBuy: this.totalBuy, totalSell: this.totalSell, atp: this.atp } : {}),
    };
  }

  /** The resting book at a moment: shares on the nearest quoted levels of each side, from each side's own best price. */
  nearBook(now: number): { bidQ: number; askQ: number } {
    const bids: [number, number][] = [], asks: [number, number][] = [];
    const add = (p: number, side: Side, qty: number) => (side === 'BID' ? bids : asks).push([p, qty]);
    if (now >= this.lastEventAt - 1000) {
      for (const [p, l] of this.levels) if (l.qty > 0 && now - l.seenAt <= 15_000) add(p, l.side, l.qty);
    } else {
      // looking back in time: the book as it stood then, not as it stands now
      for (const s of this.segments) if (s.t0 <= now && (s.t1 === undefined ? now - s.seenTill <= 15_000 : s.t1 > now)) add(s.p, s.side, s.qty);
    }
    bids.sort((a, b) => b[0] - a[0]); asks.sort((a, b) => a[0] - b[0]);
    const sum = (xs: [number, number][]) => xs.slice(0, NEAR_LEVELS).reduce((s, x) => s + x[1], 0);
    return { bidQ: sum(bids), askQ: sum(asks) };
  }

  /**
   * The bias line on top of the chart: who has been in control over the last 10 minutes (his choice: steadier than 1).
   * Absorption wins (the fakeout tell): heavy buying with price not rising means sellers are defending, and the reverse.
   * Otherwise a score from aggressive buying vs selling (60%) and the resting book near price, 5 quoted levels a side
   * (40%), nudged by a wall holding right next to price. The score is then checked against what price actually did:
   *  - it moved the other way over the 10 minutes: Mixed, whatever the volume says;
   *  - the side's quote has stopped advancing for 3 minutes (bid flat for buyers, ask flat for sellers): only "leaning".
   * A frozen book counts for nothing.
   */
  bias(now: number): Bias {
    const f = this.flow(now, 600);
    const fmtQ = (q: number) => (q >= 1000 ? `${(q / 1000).toFixed(1)}k` : String(Math.round(q)));
    const rs = (x: number) => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(2)}`;
    const span = f.recordedSec < 570 ? `${Math.round(f.recordedSec / 60)} of the last 10 min recorded` : '10 min';
    if (f.absorption === 'BUYING_ABSORBED') return { side: 'DOWN', label: 'Buying absorbed', why: `${span}: buyers ${fmtQ(f.buy)} vs sellers ${fmtQ(f.sell)}, price ${rs(f.move)}: sellers are soaking it up`, score: -0.6 };
    if (f.absorption === 'SELLING_ABSORBED') return { side: 'UP', label: 'Selling absorbed', why: `${span}: sellers ${fmtQ(f.sell)} vs buyers ${fmtQ(f.buy)}, price ${rs(f.move)}: buyers are soaking it up`, score: 0.6 };
    const tape = f.buy + f.sell > 0 ? (f.buy - f.sell) / (f.buy + f.sell) : 0;
    const frozen = this.staleSince(now) !== undefined;
    const { bidQ, askQ } = this.nearBook(now);
    const book = !frozen && bidQ + askQ > 0 ? (bidQ - askQ) / (bidQ + askQ) : 0;
    let score = 0.6 * tape + 0.4 * book;
    const ref = this.ltp ?? this.bestBid ?? this.bestAsk;
    const flat = this.flatMove();
    let wallNote = '';
    if (!frozen && ref !== undefined && now >= this.lastEventAt - 1000) {
      const reach = Math.max(3 * this.tick / 100, flat);
      for (const w of this.walls(now, 1)) {
        if (w.status !== 'HOLDING' || w.seenAgoSec > 15 || Math.abs(w.price - ref) > reach) continue;
        score += w.side === 'BID' ? 0.2 : -0.2;
        wallNote = `, ${w.side === 'BID' ? 'buy' : 'sell'} wall holding at ${w.price.toFixed(2)}`;
      }
    }
    score = Math.max(-1, Math.min(1, score));
    if (!f.buy && !f.sell && !bidQ && !askQ) return { side: 'NEUTRAL', label: 'No data yet', why: 'waiting for trades and the book', score: 0 };
    const bookText = frozen ? 'book frozen, ignored' : `book near price (${NEAR_LEVELS} levels a side): ${fmtQ(bidQ)} to buy vs ${fmtQ(askQ)} to sell`;
    const why = `${span}: buyers ${fmtQ(f.buy)} vs sellers ${fmtQ(f.sell)}; ${bookText}${wallNote}`;
    if (Math.abs(score) < 0.25) return { side: 'NEUTRAL', label: 'Balanced', why, score };
    const up = score > 0, who = up ? 'Buyers' : 'Sellers';
    const ten = this.priceRead(now, 600), three = this.priceRead(now, 180);
    if (ten && (up ? ten.mid < -flat : ten.mid > flat)) return { side: 'NEUTRAL', label: 'Mixed', why: `${why}; but price went the other way (${rs(ten.mid)})`, score };
    const stalled = !!three && three.spanSec >= 120 && (up ? three.bid <= flat : three.ask >= -flat);
    const strong = Math.abs(score) >= 0.5 && !stalled;
    return { side: up ? 'UP' : 'DOWN', label: `${who} ${strong ? 'in control' : 'leaning'}`, why: stalled ? `${why}; ${up ? 'bid' : 'ask'} has not advanced in 3 min` : why, score };
  }

  /** 10-minute candles from the traded price, on the same clock as his chart (09:15, 09:25, ...). */
  candles(from: number, to: number, sec = 600): Candle[] {
    const out = new Map<number, Candle>();
    for (const q of this.quotes) {
      if (q.ltp === undefined || q.t < from - sec * 1000 || q.t > to) continue;
      const t = Math.floor(q.t / 1000);
      const day = Math.floor((t + 19800) / 86400) * 86400 - 19800;
      const open = day + 9 * 3600 + 15 * 60;
      const t0 = open + Math.floor((t - open) / sec) * sec;
      const c = out.get(t0);
      if (!c) out.set(t0, { t0, o: q.ltp, h: q.ltp, l: q.ltp, c: q.ltp });
      else { c.h = Math.max(c.h, q.ltp); c.l = Math.min(c.l, q.ltp); c.c = q.ltp; }
    }
    return [...out.values()].sort((a, b) => a.t0 - b.t0);
  }

  /** How far the live 20-level window reaches each side, in rupees (to judge whether 200 levels would add anything). */
  reach(now: number): { below?: number; above?: number } {
    let minBid = Infinity, maxAsk = -Infinity;
    for (const [p, l] of this.levels) {
      if (l.qty <= 0 || now - l.seenAt > 5_000) continue;
      if (l.side === 'BID') minBid = Math.min(minBid, p); else maxAsk = Math.max(maxAsk, p);
    }
    return {
      below: Number.isFinite(minBid) && this.bestBid ? Math.round(this.bestBid * 100 - minBid) / 100 : undefined,
      above: Number.isFinite(maxAsk) && this.bestAsk ? Math.round(maxAsk - this.bestAsk * 100) / 100 : undefined,
    };
  }

  /** Size resting at a price at a moment (for the crosshair). */
  sizeAt(p: number, t: number): { qty: number; side: Side } | undefined {
    const k = key(p);
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const s = this.segments[i];
      if (s.p === k && s.t0 <= t && (s.t1 === undefined || s.t1 > t)) return { qty: s.qty, side: s.side };
    }
    return undefined;
  }

  /** Plain text for Claude: walls with their behaviour, recent pulled/eaten walls, and push vs absorption. */
  summary(now: number): string {
    if (!this.ltp && !this.bestBid) return '';
    const fmtQ = (q: number) => (q >= 1000 ? `${(q / 1000).toFixed(1)}k` : String(Math.round(q)));
    const line = (x: Wall) => `${x.side === 'ASK' ? 'sell' : 'buy'} wall ${x.price.toFixed(2)}: ${fmtQ(x.qty)} (${x.times}x a normal level, max ${fmtQ(x.maxQty)}), there ${x.ageMin} min, traded into it ${fmtQ(x.traded)}, refilled ${x.refills}x, ${x.status}${x.seenAgoSec > 60 ? ` (last seen ${Math.round(x.seenAgoSec / 60)} min ago, outside the 20-level window)` : ''}`;
    const fl = (f: Flow) => `last ${f.sec / 60} min: aggressive buying ${fmtQ(f.buy)} vs selling ${fmtQ(f.sell)}, price ${f.moveTicks >= 0 ? '+' : ''}${f.moveTicks} ticks${f.absorption ? `, ${f.absorption === 'BUYING_ABSORBED' ? 'BUYING ABSORBED (heavy buying, price not rising)' : 'SELLING ABSORBED (heavy selling, price not falling)'}` : ''}`;
    const r = this.reach(now);
    const w = this.walls(now);
    const control = this.bias(now);
    return [
      `ORDER_BOOK live (20 levels a side${r.below !== undefined ? `, reaching ${r.below} below and ${r.above ?? '?'} above` : ''}), last ${this.ltp?.toFixed(2)}, bid ${this.bestBid?.toFixed(2)} / ask ${this.bestAsk?.toFixed(2)}`,
      ...(w.length ? w.map(line) : ['no walls (no level 4x the normal size)']),
      ...this.endedWalls(now).slice(-4).map((x) => `${x.side === 'ASK' ? 'sell' : 'buy'} wall ${x.price.toFixed(2)} (max ${fmtQ(x.maxQty)}) was ${x.status} ${Math.round((x.endedAgoSec ?? 0) / 60)} min ago`),
      fl(this.flow(now, 60)), fl(this.flow(now, 600)),
      `control over 10 min: ${control.label} (${control.why})`,
      ...(this.totalBuy || this.totalSell ? [`whole book pending: ${fmtQ(this.totalBuy ?? 0)} to buy vs ${fmtQ(this.totalSell ?? 0)} to sell`] : []),
      ...(this.atp && this.ltp ? [`price is ${this.ltp >= this.atp ? 'above' : 'below'} the day's VWAP ${this.atp.toFixed(2)}`] : []),
    ].join('\n');
  }
}
