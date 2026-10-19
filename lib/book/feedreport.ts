import type { FeedProbe, ProbeEvent, RawPacket } from './probe';

/**
 * One stock's feed over a window (default: the last 5 minutes), for the chart's Copy and Check feed buttons.
 *
 *  raw      every packet for that stock exactly as Dhan sent it (base64 of the original bytes) with its arrival time
 *  decoded  the same packets read field by field, only the fields Dhan documents
 *  facts    numbers computed in code from the packets (counts, gaps, duplicates, unchanged stretches, trades printed
 *           outside the book), so a reader never has to estimate them
 *  events   connection events in the window (opens, closes, Dhan disconnects, subscriptions sent, restarts)
 *
 * Packet layouts (DhanHQ v2 docs): 20-level depth = 12-byte header [int16 length, u8 code 41 bid / 51 ask, u8
 * segment, int32 security id, u32 sequence] + 20 x [float64 price, uint32 qty, uint32 orders]. Quote packet (feed
 * code 4, subscribed with RequestCode 17) = 8-byte header [u8 code, int16 length, u8 segment, int32 security id] +
 * float32 LTP, int16 LTQ, int32 LTT, float32 ATP, int32 volume, int32 total sell qty, int32 total buy qty,
 * float32 open, close, high, low.
 */

export interface DepthRow { t: number; side: 'BID' | 'ASK'; best?: number; bestQty?: number; levels: number; totalQty: number; dupOfPrev: boolean }
export interface QuoteRow { t: number; ltp: number; ltq: number; ltt: number; volume: number; dayHigh: number; dayLow: number }
export interface Gap { from: number; to: number; sec: number }
export interface FeedReport {
  v: 1; symbol: string; securityId: string; from: number; to: number; builtAt: number;
  subscribed: { depth: boolean; quotes: boolean };
  facts: {
    depthPackets: { bid: number; ask: number; distinct: number; duplicates: number };
    quotePackets: number;
    volumeRiseInWindow?: number; quotesWithVolumeRise: number;
    lastDepthAt?: number; lastQuoteAt?: number;
    /** the longest stretches with no packet at all, per feed (inside the window) */
    depthGaps: Gap[]; quoteGaps: Gap[];
    /** longest stretch where the book's packets kept arriving identical while quotes showed the day volume rising */
    longestUnchangedBookWhileTrading?: { from: number; to: number; sec: number; volumeRise: number };
    /** quotes whose price was 2+ ticks outside the latest book received before them */
    tradesOutsideBook: { count: number; examples: { t: number; ltp: number; bid?: number; ask?: number }[] };
    /** exchange trade time (LTT) moved vs arrival time: a stalled LTT while packets keep arriving */
    lttAdvancedSec?: number; arrivalSpanSec?: number;
  };
  /** 10-second buckets: what arrived when (for spotting on / off patterns) */
  timeline: { t: number; depth: number; quotes: number; volumeRise: number }[];
  events: ProbeEvent[];
  decoded: { depth: DepthRow[]; quotes: QuoteRow[] };
  raw: { t: number; feed: 'depth' | 'feed'; code: number; b64: string }[];
}

const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64'); };
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export function decodeDepth(p: RawPacket): Omit<DepthRow, 'dupOfPrev'> {
  const dv = new DataView(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength);
  let levels = 0, totalQty = 0, best: number | undefined, bestQty: number | undefined;
  for (let o = 12; o + 16 <= p.bytes.byteLength; o += 16) {
    const price = dv.getFloat64(o, true), qty = dv.getUint32(o + 8, true);
    if (!(price > 0) || !(qty > 0)) continue;
    levels++; totalQty += qty;
    if (best === undefined) { best = Math.round(price * 100) / 100; bestQty = qty; }
  }
  return { t: p.t, side: p.code === 41 ? 'BID' : 'ASK', best, bestQty, levels, totalQty };
}

export function decodeQuote(p: RawPacket): QuoteRow | undefined {
  if (p.code !== 4 || p.bytes.byteLength < 50) return undefined;
  const dv = new DataView(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength);
  const r = (x: number) => Math.round(x * 100) / 100;
  return { t: p.t, ltp: r(dv.getFloat32(8, true)), ltq: dv.getInt16(12, true), ltt: dv.getInt32(14, true), volume: dv.getInt32(22, true), dayHigh: r(dv.getFloat32(42, true)), dayLow: r(dv.getFloat32(46, true)) };
}

function gaps(times: number[], from: number, to: number): Gap[] {
  const pts = [from, ...times, to];
  const out: Gap[] = [];
  for (let i = 1; i < pts.length; i++) out.push({ from: pts[i - 1], to: pts[i], sec: Math.round((pts[i] - pts[i - 1]) / 100) / 10 });
  return out.sort((a, b) => b.sec - a.sec).slice(0, 5);
}

export function buildFeedReport(probe: FeedProbe, symbol: string, securityId: string, now = Date.now(), windowMs = 5 * 60_000, tick = 0.05): FeedReport {
  const from = now - windowMs, to = now;
  const pk = (probe.packets.get(securityId) ?? []).filter((p) => p.t >= from && p.t <= to);
  const dp = pk.filter((p) => p.feed === 'depth'), qp = pk.filter((p) => p.feed === 'feed');

  // depth rows, with "identical to the previous packet of the same side"
  const lastBytes: Record<string, Uint8Array> = {};
  let duplicates = 0;
  const depth: DepthRow[] = dp.map((p) => {
    const side = p.code === 41 ? 'B' : 'A';
    // compare without the 4-byte sequence number (bytes 8-11), which Dhan says to ignore
    const body = new Uint8Array([...p.bytes.slice(0, 8), ...p.bytes.slice(12)]);
    const dup = !!lastBytes[side] && same(lastBytes[side], body);
    if (dup) duplicates++;
    lastBytes[side] = body;
    return { ...decodeDepth(p), dupOfPrev: dup };
  });
  const quotes = qp.map(decodeQuote).filter((q): q is QuoteRow => !!q);

  // quotes vs the book: price 2+ ticks outside the latest bid / ask received before the quote
  let bid: number | undefined, ask: number | undefined, di = 0;
  const outside: FeedReport['facts']['tradesOutsideBook']['examples'] = [];
  let outsideCount = 0;
  for (const q of quotes) {
    while (di < depth.length && depth[di].t <= q.t) { if (depth[di].side === 'BID') bid = depth[di].best; else ask = depth[di].best; di++; }
    if ((bid !== undefined && q.ltp < bid - 2 * tick - 1e-9) || (ask !== undefined && q.ltp > ask + 2 * tick + 1e-9)) {
      outsideCount++;
      if (outside.length < 5) outside.push({ t: q.t, ltp: q.ltp, bid, ask });
    }
  }

  // longest stretch of identical book packets while the day volume (from quotes) kept rising
  let longest: FeedReport['facts']['longestUnchangedBookWhileTrading'];
  let runStart: number | undefined;
  const closeRun = (end: number) => {
    if (runStart === undefined) return;
    const vIn = quotes.filter((q) => q.t >= runStart! && q.t <= end);
    const rise = vIn.length > 1 ? vIn[vIn.length - 1].volume - vIn[0].volume : 0;
    const sec = Math.round((end - runStart) / 1000);
    if (rise > 0 && (!longest || sec > longest.sec)) longest = { from: runStart, to: end, sec, volumeRise: rise };
    runStart = undefined;
  };
  for (let i = 0; i < depth.length; i++) {
    if (depth[i].dupOfPrev) { runStart ??= depth[i - 1]?.t ?? depth[i].t; continue; }
    closeRun(depth[i - 1]?.t ?? depth[i].t);
  }
  // a stretch still going at the end of the window (the frozen case) runs to the window's end
  closeRun(to);

  let quotesWithVolumeRise = 0;
  for (let i = 1; i < quotes.length; i++) if (quotes[i].volume > quotes[i - 1].volume) quotesWithVolumeRise++;

  const timeline: FeedReport['timeline'] = [];
  for (let b = from; b < to; b += 10_000) {
    const qs = quotes.filter((q) => q.t >= b && q.t < b + 10_000);
    const prev = quotes.filter((q) => q.t < b).at(-1);
    timeline.push({
      t: b, depth: depth.filter((d) => d.t >= b && d.t < b + 10_000).length, quotes: qs.length,
      volumeRise: qs.length && prev ? qs[qs.length - 1].volume - prev.volume : qs.length > 1 ? qs[qs.length - 1].volume - qs[0].volume : 0,
    });
  }

  const subs = probe.events.filter((e) => e.what.startsWith('subscribe '));
  const lastSub = (feed: 'depth' | 'feed') => subs.filter((e) => e.feed === feed).at(-1)?.what ?? '';
  return {
    v: 1, symbol, securityId, from, to, builtAt: Date.now(),
    subscribed: { depth: lastSub('depth').includes(`"${securityId}"`), quotes: lastSub('feed').includes(`"${securityId}"`) },
    facts: {
      depthPackets: { bid: depth.filter((d) => d.side === 'BID').length, ask: depth.filter((d) => d.side === 'ASK').length, distinct: depth.length - duplicates, duplicates },
      quotePackets: quotes.length,
      volumeRiseInWindow: quotes.length > 1 ? quotes[quotes.length - 1].volume - quotes[0].volume : undefined,
      quotesWithVolumeRise,
      lastDepthAt: depth.at(-1)?.t, lastQuoteAt: quotes.at(-1)?.t,
      depthGaps: gaps(depth.map((d) => d.t), from, to), quoteGaps: gaps(quotes.map((q) => q.t), from, to),
      longestUnchangedBookWhileTrading: longest,
      tradesOutsideBook: { count: outsideCount, examples: outside },
      lttAdvancedSec: quotes.length > 1 ? quotes[quotes.length - 1].ltt - quotes[0].ltt : undefined,
      arrivalSpanSec: quotes.length > 1 ? Math.round((quotes[quotes.length - 1].t - quotes[0].t) / 1000) : undefined,
    },
    timeline,
    events: probe.events.filter((e) => e.t >= from - 60_000 && e.t <= to),
    decoded: { depth, quotes },
    raw: pk.map((p) => ({ t: p.t, feed: p.feed, code: p.code, b64: b64(p.bytes) })),
  };
}

/** What goes to Claude: the facts, the timeline and the events. No raw bytes (cost), no per-packet rows. */
export function reportForClaude(r: FeedReport): string {
  const ist = (t?: number) => (t ? new Date(t + 19800_000).toISOString().slice(11, 19) : '-');
  const f = r.facts;
  const lines = [
    `STOCK ${r.symbol} (security id ${r.securityId}), window ${ist(r.from)} to ${ist(r.to)} IST (${Math.round((r.to - r.from) / 60000)} min). Report built in the app from the raw packets.`,
    `SUBSCRIBED: 20-level depth ${r.subscribed.depth ? 'yes' : 'NO (not in the last depth subscription sent)'}; quotes ${r.subscribed.quotes ? 'yes' : 'NO (not in the last quote subscription sent)'}`,
    `DEPTH PACKETS: ${f.depthPackets.bid} bid + ${f.depthPackets.ask} ask; ${f.depthPackets.distinct} distinct, ${f.depthPackets.duplicates} identical to the previous packet of the same side (sequence number ignored). Last at ${ist(f.lastDepthAt)}.`,
    `QUOTE PACKETS: ${f.quotePackets}; ${f.quotesWithVolumeRise} of them with the day volume higher than the previous quote; day volume rose by ${f.volumeRiseInWindow ?? 'n/a'} across the window. Last at ${ist(f.lastQuoteAt)}.`,
    `LTT (exchange last-trade time field) advanced ${f.lttAdvancedSec ?? 'n/a'} s while quote arrivals spanned ${f.arrivalSpanSec ?? 'n/a'} s.`,
    `LONGEST GAPS, depth: ${f.depthGaps.map((g) => `${g.sec}s (${ist(g.from)}-${ist(g.to)})`).join(', ') || 'none'}`,
    `LONGEST GAPS, quotes: ${f.quoteGaps.map((g) => `${g.sec}s (${ist(g.from)}-${ist(g.to)})`).join(', ') || 'none'}`,
    `IDENTICAL BOOK WHILE TRADING: ${f.longestUnchangedBookWhileTrading ? `${f.longestUnchangedBookWhileTrading.sec}s (${ist(f.longestUnchangedBookWhileTrading.from)}-${ist(f.longestUnchangedBookWhileTrading.to)}), day volume rose ${f.longestUnchangedBookWhileTrading.volumeRise} meanwhile` : 'none'}`,
    `TRADES 2+ TICKS OUTSIDE THE LATEST BOOK: ${f.tradesOutsideBook.count}${f.tradesOutsideBook.examples.length ? `, e.g. ${f.tradesOutsideBook.examples.map((e) => `${ist(e.t)} ltp ${e.ltp} vs bid ${e.bid ?? '-'} / ask ${e.ask ?? '-'}`).join('; ')}` : ''}`,
    `TIMELINE (10 s buckets: depth packets / quote packets / volume rise): ${r.timeline.map((b) => `${ist(b.t).slice(0, 8)} ${b.depth}/${b.quotes}/${b.volumeRise}`).join(' | ')}`,
    `CONNECTION EVENTS: ${r.events.map((e) => `${ist(e.t)} ${e.feed} ${e.what.startsWith('subscribe') ? `subscribe (${(e.what.match(/SecurityId/g) ?? []).length} instruments)` : e.what}`).join(' | ') || 'none in the window'}`,
  ];
  return lines.join('\n');
}
