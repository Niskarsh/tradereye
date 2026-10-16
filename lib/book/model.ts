import type { DepthMsg, QuoteMsg } from './feed';

/**
 * The order book over time, Bookmap style, for one stock.
 *
 * Every price keeps its LAST SEEN size and side, even after it leaves the 20-level window: when price moves away,
 * the old orders are still drawn (fading with age) until price comes back and shows fresh numbers.
 * Big resting orders (walls) are tracked through their life: RESTING (not touched), HOLDING (being hit and still
 * there: absorption), PULLED (gone without being traded: they were never real), EATEN (traded through).
 */

export type Side = 'BID' | 'ASK';
export type WallStatus = 'RESTING' | 'HOLDING' | 'PULLED' | 'EATEN';

interface Level { side: Side; qty: number; seenAt: number; firstAt: number; maxQty: number; traded: number; lastDrop: number; refills: number }
export interface Cell { p: number; qty: number; side: Side; age: number }
export interface Column { t: number; bid?: number; ask?: number; ltp?: number; buy: number; sell: number; cells: Cell[] }
export interface Wall { price: number; side: Side; qty: number; maxQty: number; times: number; ageMin: number; traded: number; refills: number; status: WallStatus; seenAgoSec: number }
export interface Flow { sec: number; buy: number; sell: number; moveTicks: number; absorption?: 'BUYING_ABSORBED' | 'SELLING_ABSORBED' }

const key = (price: number) => Math.round(price * 100); // paise
const HISTORY_SEC = 3600;

export class BookModel {
  levels = new Map<number, Level>();
  columns: Column[] = [];
  tick = 5; // paise, learned from the book
  bestBid?: number; bestAsk?: number; ltp?: number;
  private lastVolume = 0;
  private bucket = { buy: 0, sell: 0 };
  private tradeLog: { t: number; buy: number; sell: number; ltp: number }[] = [];
  private ended: { w: Wall; at: number }[] = []; // walls that were pulled or eaten (kept 15 min as history)

  onDepth(m: DepthMsg, now: number) {
    if (!m.levels.length) return;
    const ks = m.levels.map((l) => key(l.price));
    const present = new Set(ks);
    const lo = Math.min(...ks), hi = Math.max(...ks);
    // learn the tick from the smallest gap
    const sorted = [...ks].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) { const g = sorted[i] - sorted[i - 1]; if (g > 0 && g < this.tick) this.tick = g; }
    for (const l of m.levels) this.set(key(l.price), m.side, l.qty, now);
    // prices inside the window that are no longer quoted on this side: their orders are gone
    for (const [p, lv] of this.levels) if (lv.side === m.side && p >= lo && p <= hi && !present.has(p) && lv.qty > 0) this.set(p, m.side, 0, now);
    if (m.side === 'BID') this.bestBid = hi / 100; else this.bestAsk = lo / 100;
  }

  private set(p: number, side: Side, qty: number, now: number) {
    const lv = this.levels.get(p);
    if (!lv || lv.side !== side) {
      if (lv && lv.qty > 0) this.endWall(p, lv, now, 'EATEN'); // price traded through: the level flipped sides
      this.levels.set(p, { side, qty, seenAt: now, firstAt: now, maxQty: qty, traded: 0, lastDrop: 0, refills: 0 });
      return;
    }
    if (qty < lv.qty) lv.lastDrop = now;
    else if (qty > lv.qty && lv.lastDrop && now - lv.lastDrop < 120_000 && lv.traded > 0) lv.refills++;
    if (qty === 0 && lv.qty > 0) this.endWall(p, lv, now, lv.traded >= lv.maxQty * 0.5 ? 'EATEN' : 'PULLED');
    lv.qty = qty; lv.seenAt = now; lv.maxQty = Math.max(lv.maxQty, qty);
    if (qty === 0) { lv.firstAt = now; lv.maxQty = 0; lv.traded = 0; lv.refills = 0; }
  }

  private endWall(p: number, lv: Level, now: number, status: WallStatus) {
    const med = this.median(lv.side, now);
    if (!med || lv.maxQty < 4 * med) return;
    this.ended.push({ at: now, w: { price: p / 100, side: lv.side, qty: 0, maxQty: lv.maxQty, times: Math.round((lv.maxQty / med) * 10) / 10, ageMin: Math.round((now - lv.firstAt) / 60000), traded: Math.round(lv.traded), refills: lv.refills, status, seenAgoSec: 0 } });
    this.ended = this.ended.filter((e) => now - e.at < 15 * 60_000).slice(-20);
  }

  onQuote(q: QuoteMsg, now: number) {
    this.ltp = q.ltp;
    if (this.lastVolume > 0 && q.volume > this.lastVolume) {
      const dv = q.volume - this.lastVolume;
      // who was aggressive: a trade at the ask was a buyer lifting it, at the bid a seller hitting it
      const atAsk = this.bestAsk !== undefined && q.ltp >= this.bestAsk - 1e-9;
      const atBid = this.bestBid !== undefined && q.ltp <= this.bestBid + 1e-9;
      const buy = atAsk ? dv : atBid ? 0 : dv / 2, sell = dv - buy;
      this.bucket.buy += buy; this.bucket.sell += sell;
      const lv = this.levels.get(key(q.ltp));
      if (lv) lv.traded += dv;
      this.tradeLog.push({ t: now, buy, sell, ltp: q.ltp });
      if (this.tradeLog.length > 20000) this.tradeLog.splice(0, 5000);
    }
    if (q.volume > 0) this.lastVolume = q.volume;
  }

  /** One column per second for the heatmap. Only prices within 3% of the last price are kept. */
  snapshot(now: number) {
    const ref = this.ltp ?? this.bestBid ?? this.bestAsk;
    const cells: Cell[] = [];
    if (ref) {
      const lo = key(ref * 0.97), hi = key(ref * 1.03);
      for (const [p, lv] of this.levels) if (lv.qty > 0 && p >= lo && p <= hi) cells.push({ p, qty: lv.qty, side: lv.side, age: now - lv.seenAt });
    }
    this.columns.push({ t: Math.floor(now / 1000), bid: this.bestBid, ask: this.bestAsk, ltp: this.ltp, buy: this.bucket.buy, sell: this.bucket.sell, cells });
    this.bucket = { buy: 0, sell: 0 };
    if (this.columns.length > HISTORY_SEC) this.columns.splice(0, this.columns.length - HISTORY_SEC);
  }

  /** Median size of the levels currently quoted on a side (what a "normal" level looks like right now). */
  median(side: Side, now = Date.now()): number {
    const q = [...this.levels.values()].filter((l) => l.side === side && l.qty > 0 && now - l.seenAt < 30_000).map((l) => l.qty).sort((a, b) => a - b);
    return q.length ? q[Math.floor(q.length / 2)] : 0;
  }

  /** Walls: a level at least 4x the median level on its side. */
  walls(now: number, max = 4): Wall[] {
    const out: Wall[] = [];
    for (const side of ['ASK', 'BID'] as Side[]) {
      const med = this.median(side, now);
      if (!med) continue;
      for (const [p, lv] of this.levels) {
        if (lv.side !== side || lv.qty < 4 * med) continue;
        const status: WallStatus = lv.traded >= lv.maxQty * 0.25 ? 'HOLDING' : 'RESTING';
        out.push({ price: p / 100, side, qty: lv.qty, maxQty: lv.maxQty, times: Math.round((lv.qty / med) * 10) / 10, ageMin: Math.round((now - lv.firstAt) / 60000), traded: Math.round(lv.traded), refills: lv.refills, status, seenAgoSec: Math.round((now - lv.seenAt) / 1000) });
      }
    }
    const ref = this.ltp ?? 0;
    const byDist = (a: Wall, b: Wall) => Math.abs(a.price - ref) - Math.abs(b.price - ref);
    const above = out.filter((w) => w.price >= ref).sort(byDist).slice(0, max);
    const below = out.filter((w) => w.price < ref).sort(byDist).slice(0, max);
    return [...above, ...below];
  }

  /** Walls that ended in the last 15 minutes (pulled or eaten), newest last. */
  endedWalls(now: number): Wall[] { return this.ended.filter((e) => now - e.at < 15 * 60_000).map((e) => ({ ...e.w, seenAgoSec: Math.round((now - e.at) / 1000) })); }

  /** Aggressive buying vs selling over the last `sec` seconds, and how far price moved for it. */
  flow(now: number, sec: number): Flow {
    const from = now - sec * 1000;
    const recent = this.tradeLog.filter((x) => x.t >= from);
    const buy = Math.round(recent.reduce((s, x) => s + x.buy, 0)), sell = Math.round(recent.reduce((s, x) => s + x.sell, 0));
    const moveTicks = recent.length ? Math.round(((recent[recent.length - 1].ltp - recent[0].ltp) * 100) / this.tick) : 0;
    const f: Flow = { sec, buy, sell, moveTicks };
    // lots of one-sided aggression and price not moving that way = someone is absorbing it (a classic fakeout tell)
    const total = buy + sell;
    if (total > 0 && recent.length >= 5) {
      if (buy >= 2 * sell && moveTicks <= 1) f.absorption = 'BUYING_ABSORBED';
      else if (sell >= 2 * buy && moveTicks >= -1) f.absorption = 'SELLING_ABSORBED';
    }
    return f;
  }

  /** How far the live 20-level window reaches each side, in rupees (to judge whether 200 levels would add anything). */
  reach(now = Date.now()): { below?: number; above?: number } {
    const live = [...this.levels.entries()].filter(([, l]) => l.qty > 0 && now - l.seenAt < 5_000);
    const bids = live.filter(([, l]) => l.side === 'BID').map(([p]) => p), asks = live.filter(([, l]) => l.side === 'ASK').map(([p]) => p);
    return {
      below: bids.length && this.bestBid ? Math.round((this.bestBid * 100 - Math.min(...bids))) / 100 : undefined,
      above: asks.length && this.bestAsk ? Math.round((Math.max(...asks) - this.bestAsk * 100)) / 100 : undefined,
    };
  }

  /** Plain text for Claude: walls with their behaviour, recent pulled/eaten walls, and push vs absorption. */
  summary(now: number): string {
    if (!this.ltp && !this.bestBid) return '';
    const w = this.walls(now);
    const fmtQ = (q: number) => (q >= 1000 ? `${(q / 1000).toFixed(1)}k` : String(Math.round(q)));
    const line = (x: Wall) => `${x.side === 'ASK' ? 'sell' : 'buy'} wall ${x.price.toFixed(2)}: ${fmtQ(x.qty)} (${x.times}x a normal level, max ${fmtQ(x.maxQty)}), there ${x.ageMin} min, traded into it ${fmtQ(x.traded)}, refilled ${x.refills}x, ${x.status}${x.seenAgoSec > 60 ? ` (last seen ${Math.round(x.seenAgoSec / 60)} min ago, outside the 20-level window)` : ''}`;
    const f1 = this.flow(now, 60), f5 = this.flow(now, 300);
    const fl = (f: Flow) => `last ${f.sec / 60} min: aggressive buying ${fmtQ(f.buy)} vs selling ${fmtQ(f.sell)}, price ${f.moveTicks >= 0 ? '+' : ''}${f.moveTicks} ticks${f.absorption ? `, ${f.absorption === 'BUYING_ABSORBED' ? 'BUYING ABSORBED (heavy buying, price not rising)' : 'SELLING ABSORBED (heavy selling, price not falling)'}` : ''}`;
    const r = this.reach(now);
    return [
      `ORDER_BOOK live (20 levels a side${r.below !== undefined ? `, reaching ${r.below} below and ${r.above ?? '?'} above` : ''}), last ${this.ltp?.toFixed(2)}, bid ${this.bestBid?.toFixed(2)} / ask ${this.bestAsk?.toFixed(2)}`,
      ...(w.length ? w.map(line) : ['no walls (no level 4x the normal size)']),
      ...this.endedWalls(now).slice(-4).map((x) => `${x.side === 'ASK' ? 'sell' : 'buy'} wall ${x.price.toFixed(2)} (max ${fmtQ(x.maxQty)}) was ${x.status} ${Math.round(x.seenAgoSec / 60)} min ago`),
      fl(f1), fl(f5),
    ].join('\n');
  }
}
