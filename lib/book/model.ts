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
export interface Flow { sec: number; buy: number; sell: number; moveTicks: number; absorption?: 'BUYING_ABSORBED' | 'SELLING_ABSORBED' }
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
  private tradeLog: { t: number; buy: number; sell: number; ltp: number }[] = [];
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
    for (const [p, lv] of this.levels) if (lv.side === m.side && p >= lo && p <= hi && !present.has(p) && lv.qty > 0) this.set(p, m.side, 0, now);
    if (m.side === 'BID') this.bestBid = hi / 100; else this.bestAsk = lo / 100;
    this.pushQuote(now);
  }

  onQuote(q: QuoteMsg, now: number) {
    this.touch(now);
    this.ltp = q.ltp;
    if (this.lastVolume > 0 && q.volume > this.lastVolume) {
      const dv = q.volume - this.lastVolume;
      // who was aggressive: a trade at the ask was a buyer lifting it, at the bid a seller hitting it
      const atAsk = this.bestAsk !== undefined && q.ltp >= this.bestAsk - 1e-9;
      const atBid = this.bestBid !== undefined && q.ltp <= this.bestBid + 1e-9;
      const buy = atAsk ? dv : atBid ? 0 : dv / 2, sell = dv - buy;
      const lv = this.levels.get(key(q.ltp));
      if (lv) lv.traded += dv;
      const sec = Math.floor(now / 1000);
      const last = this.trades[this.trades.length - 1];
      if (last && last.t === sec) { last.buy += buy; last.sell += sell; last.price = q.ltp; } else this.trades.push({ t: sec, buy, sell, price: q.ltp });
      this.tradeLog.push({ t: now, buy, sell, ltp: q.ltp });
      if (this.tradeLog.length > 20000) this.tradeLog.splice(0, 5000);
    }
    if (q.volume > 0) this.lastVolume = q.volume;
    this.pushQuote(now);
  }

  private touch(now: number) {
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
      if (lv && lv.qty > 0) {
        // the price changed sides: price traded through it. Real only if shares actually traded there.
        this.endWall(p, lv, now, lv.traded >= lv.maxQty * 0.5 ? 'EATEN' : 'PULLED');
        lv.seg.t1 = now;
      } else if (lv) lv.seg.t1 = lv.seg.t1 ?? now;
      const seg: Segment = { p, side, qty, t0: now, seenTill: now };
      if (qty > 0) this.segments.push(seg);
      this.levels.set(p, { side, qty, seenAt: now, firstAt: now, maxQty: qty, traded: 0, refills: 0, lastDrop: 0, seg });
      return;
    }
    if (qty === lv.qty) { lv.seenAt = now; lv.seg.seenTill = now; return; }
    if (qty < lv.qty) lv.lastDrop = now;
    else if (lv.lastDrop && now - lv.lastDrop < 120_000 && lv.traded > 0) lv.refills++;
    if (qty === 0 && lv.qty > 0) this.endWall(p, lv, now, lv.traded >= lv.maxQty * 0.5 ? 'EATEN' : 'PULLED');
    // close the old segment, open a new one
    lv.seg.t1 = now;
    const seg: Segment = { p, side, qty, t0: now, seenTill: now };
    if (qty > 0) this.segments.push(seg);
    lv.seg = seg;
    lv.qty = qty; lv.seenAt = now; lv.maxQty = Math.max(lv.maxQty, qty);
    if (qty === 0) { lv.firstAt = now; lv.maxQty = 0; lv.traded = 0; lv.refills = 0; }
  }

  private endWall(p: number, lv: Level, now: number, status: WallStatus) {
    const med = this.median(lv.side, now);
    if (!med || lv.maxQty < WALL_X * med) return;
    this.ended.push({ at: now, w: { price: p / 100, side: lv.side, qty: 0, maxQty: lv.maxQty, times: Math.round((lv.maxQty / med) * 10) / 10, ageMin: Math.round((now - lv.firstAt) / 60000), traded: Math.round(lv.traded), refills: lv.refills, status, seenAgoSec: 0, endedAt: now } });
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
    const moveTicks = recent.length ? Math.round(((recent[recent.length - 1].ltp - recent[0].ltp) * 100) / this.tick) : 0;
    const f: Flow = { sec, buy, sell, moveTicks };
    // heavy one-sided aggression and price not moving that way = someone is absorbing it (the fakeout tell)
    // over longer windows a smaller imbalance already means something (it had to persist for minutes)
    const ratio = sec >= 300 ? 1.6 : 2;
    if (buy + sell > 0 && recent.length >= 5) {
      if (buy >= ratio * sell && moveTicks <= 1) f.absorption = 'BUYING_ABSORBED';
      else if (sell >= ratio * buy && moveTicks >= -1) f.absorption = 'SELLING_ABSORBED';
    }
    return f;
  }

  /**
   * The bias line on top of the chart. Absorption wins (the fakeout tell): heavy buying with price not rising means
   * sellers are defending, and the reverse. Otherwise a score from the last 10 minutes of aggressive buying vs
   * selling (60%) and the resting book near price, 10 ticks each side (40%), nudged by a wall that is holding right
   * next to price (support below / resistance above). 10 minutes, not 1: steadier, less noise (his choice).
   */
  bias(now: number): Bias {
    const f1 = this.flow(now, 600), f5 = f1;
    const fmtQ = (q: number) => (q >= 1000 ? `${(q / 1000).toFixed(1)}k` : String(Math.round(q)));
    if (f1.absorption === 'BUYING_ABSORBED') return { side: 'DOWN', label: 'Buying absorbed', why: `buyers ${fmtQ(f1.buy)} vs sellers ${fmtQ(f1.sell)} in 10 min, price ${f1.moveTicks >= 0 ? '+' : ''}${f1.moveTicks} ticks: sellers are soaking it up`, score: -0.6 };
    if (f1.absorption === 'SELLING_ABSORBED') return { side: 'UP', label: 'Selling absorbed', why: `sellers ${fmtQ(f1.sell)} vs buyers ${fmtQ(f1.buy)} in 10 min, price ${f1.moveTicks >= 0 ? '+' : ''}${f1.moveTicks} ticks: buyers are soaking it up`, score: 0.6 };
    const tape = f5.buy + f5.sell > 0 ? (f5.buy - f5.sell) / (f5.buy + f5.sell) : 0;
    const ref = this.ltp ?? this.bestBid ?? this.bestAsk;
    let bidQ = 0, askQ = 0;
    if (ref !== undefined) {
      const span = 10 * this.tick;
      for (const [p, l] of this.levels) {
        if (l.qty <= 0 || now - l.seenAt > 15_000 || Math.abs(p - ref * 100) > span) continue;
        if (l.side === 'BID') bidQ += l.qty; else askQ += l.qty;
      }
    }
    const book = bidQ + askQ > 0 ? (bidQ - askQ) / (bidQ + askQ) : 0;
    let score = 0.6 * tape + 0.4 * book;
    const near = this.walls(now, 1).filter((w) => w.status === 'HOLDING' && ref !== undefined && Math.abs(w.price - ref) <= 3 * this.tick / 100);
    let wallNote = '';
    for (const w of near) { score += w.side === 'BID' ? 0.2 : -0.2; wallNote = `, ${w.side === 'BID' ? 'buy' : 'sell'} wall holding at ${w.price.toFixed(2)}`; }
    score = Math.max(-1, Math.min(1, score));
    const why = `10 min: buyers ${fmtQ(f5.buy)} vs sellers ${fmtQ(f5.sell)}; book near price: ${fmtQ(bidQ)} to buy vs ${fmtQ(askQ)} to sell${wallNote}`;
    if (!f5.buy && !f5.sell && !bidQ && !askQ) return { side: 'NEUTRAL', label: 'No data yet', why: 'waiting for trades and the book', score: 0 };
    if (score >= 0.25) return { side: 'UP', label: score >= 0.5 ? 'Buyers in control' : 'Buyers leaning', why, score };
    if (score <= -0.25) return { side: 'DOWN', label: score <= -0.5 ? 'Sellers in control' : 'Sellers leaning', why, score };
    return { side: 'NEUTRAL', label: 'Balanced', why, score };
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
    return [
      `ORDER_BOOK live (20 levels a side${r.below !== undefined ? `, reaching ${r.below} below and ${r.above ?? '?'} above` : ''}), last ${this.ltp?.toFixed(2)}, bid ${this.bestBid?.toFixed(2)} / ask ${this.bestAsk?.toFixed(2)}`,
      ...(w.length ? w.map(line) : ['no walls (no level 4x the normal size)']),
      ...this.endedWalls(now).slice(-4).map((x) => `${x.side === 'ASK' ? 'sell' : 'buy'} wall ${x.price.toFixed(2)} (max ${fmtQ(x.maxQty)}) was ${x.status} ${Math.round((x.endedAgoSec ?? 0) / 60)} min ago`),
      fl(this.flow(now, 60)), fl(this.flow(now, 600)),
    ].join('\n');
  }
}
