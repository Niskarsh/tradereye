/**
 * Feed probe: what Dhan actually sends, kept small, so a stock that shows trades but no order book can be
 * diagnosed from evidence instead of guesses.
 *
 * It keeps, for the session:
 *  - per stock: depth packets (bid / ask) and quote packets received, first and last time
 *  - every packet header seen on the depth feed, summarised: [code, segment, securityId] -> count. A stock whose
 *    depth arrives under another id or segment shows up here as an unknown id.
 *  - the subscription messages sent, socket opens / closes (with close code and reason), Dhan disconnect codes
 *  - the last 20 raw depth messages and last 5 raw quote messages, plus the first 20 raw depth messages that
 *    contained an unknown packet code or an id not on the list. RAW = Dhan's exact bytes, whole and unmodified
 *    (one depth message carries every listed stock, ~33 KB for 25), base64 only because JSON cannot hold binary.
 *    `bytes` is the original length, so a decode can be checked against it.
 *
 * When a stock has traded 5+ times over 60 s with not one depth packet, a snapshot for that stock is taken once a
 * day: saved to S3 (order-book/diagnostics/<date>/<SYMBOL>_<HHMMSS>.json.gz) and downloadable from its chart.
 */

export interface StockStats { depthBid: number; depthAsk: number; quotes: number; firstQuoteAt?: number; firstDepthAt?: number; lastDepthAt?: number }
export interface ProbeEvent { t: number; feed: 'depth' | 'feed'; what: string }
export interface Snapshot {
  v: 1; reason: string; takenAt: number; symbol: string; securityId: string;
  stock: StockStats;
  list: { symbol: string; securityId: string }[];
  headers: Record<string, number>;          // "code:segment:securityId" -> packets, depth feed
  unknownIds: Record<string, number>;       // depth packets for ids not on the list
  events: ProbeEvent[];                     // subscriptions, opens, closes, disconnects
  rawDepth: { t: number; bytes: number; b64: string; packets: string[] }[];
  rawFeed: { t: number; bytes: number; b64: string }[];
  oddDepth: { t: number; bytes: number; b64: string; packets: string[] }[];
  /** every listed stock's packet counts this session (depth bid / ask, quotes), by symbol */
  allStocks?: Record<string, StockStats>;
  /** when each connection last delivered anything */
  lastMsg?: { depth: number; feed: number };
}

/** The whole message, byte for byte (no cap: a cut copy could drop exactly the packets being looked for). */
const b64 = (buf: ArrayBuffer) => {
  const u = new Uint8Array(buf);
  let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
};

/** Packet headers in one depth message, walked the same way parseDepth walks them. */
export function depthHeaders(buf: ArrayBuffer): { code: number; segment: number; securityId: string; len: number; off: number; size: number }[] {
  const dv = new DataView(buf); const out = [];
  let off = 0;
  while (off + 12 <= buf.byteLength) {
    const len = dv.getInt16(off, true);
    const size = len >= 12 && off + len <= buf.byteLength ? len : Math.min(332, buf.byteLength - off);
    out.push({ code: dv.getUint8(off + 2), segment: dv.getUint8(off + 3), securityId: String(dv.getInt32(off + 4, true)), len, off, size });
    off += size;
  }
  return out;
}

/** Packets in one live-market-feed message (8-byte header: code, length, segment, security id). */
export function feedHeaders(buf: ArrayBuffer): { code: number; securityId: string; len: number; off: number; size: number }[] {
  const dv = new DataView(buf); const out = [];
  let off = 0;
  while (off + 8 <= buf.byteLength) {
    const code = dv.getUint8(off), len = dv.getInt16(off + 1, true);
    const fallback = code === 4 ? 50 : code === 8 ? 162 : code === 2 ? 16 : code === 6 ? 16 : code === 5 ? 12 : 8;
    const size = Math.min(len >= 8 ? len : fallback, buf.byteLength - off);
    out.push({ code, securityId: String(dv.getInt32(off + 4, true)), len, off, size });
    off += size;
  }
  return out;
}

/** One packet as Dhan sent it (its bytes cut out of the message, unchanged), with when it arrived. */
export interface RawPacket { t: number; feed: 'depth' | 'feed'; code: number; bytes: Uint8Array }
export const KEEP_PACKETS_MS = 10 * 60_000;

export class FeedProbe {
  stats = new Map<string, StockStats>();
  headers: Record<string, number> = {};
  unknownIds: Record<string, number> = {};
  events: ProbeEvent[] = [];
  rawDepth: Snapshot['rawDepth'] = [];
  rawFeed: Snapshot['rawFeed'] = [];
  oddDepth: Snapshot['oddDepth'] = [];
  snapshots = new Map<string, Snapshot>(); // by securityId, today's
  /** per stock, the last 10 minutes of its packets exactly as received (for the chart's Copy / Check feed) */
  packets = new Map<string, RawPacket[]>();
  private keep(id: string, p: RawPacket) {
    let a = this.packets.get(id);
    if (!a) { a = []; this.packets.set(id, a); }
    a.push(p);
    if (a.length > 6000 || (a.length % 200 === 0 && p.t - a[0].t > KEEP_PACKETS_MS)) {
      const cut = p.t - KEEP_PACKETS_MS;
      let i = 0; while (i < a.length && a[i].t < cut) i++;
      a.splice(0, Math.max(i, a.length - 6000));
    }
  }
  private taken = new Set<string>();
  onSnapshot?: (s: Snapshot) => void;

  private st(id: string) { let s = this.stats.get(id); if (!s) { s = { depthBid: 0, depthAsk: 0, quotes: 0 }; this.stats.set(id, s); } return s; }
  event(feed: 'depth' | 'feed', what: string, t = Date.now()) { this.events.push({ t, feed, what }); if (this.events.length > 200) this.events.splice(0, 50); }

  depthMessage(buf: ArrayBuffer, listed: Set<string>, t = Date.now()) {
    const hs = depthHeaders(buf);
    const packets = hs.map((h) => `${h.code}:${h.segment}:${h.securityId}:${h.len}`);
    let odd = false;
    for (const h of hs) {
      const k = `${h.code}:${h.segment}:${h.securityId}`;
      this.headers[k] = (this.headers[k] ?? 0) + 1;
      if (h.code === 41 || h.code === 51) {
        if (!listed.has(h.securityId)) { this.unknownIds[h.securityId] = (this.unknownIds[h.securityId] ?? 0) + 1; odd = true; continue; }
        this.keep(h.securityId, { t, feed: 'depth', code: h.code, bytes: new Uint8Array(buf.slice(h.off, h.off + h.size)) });
        const s = this.st(h.securityId);
        if (h.code === 41) s.depthBid++; else s.depthAsk++;
        s.firstDepthAt ??= t; s.lastDepthAt = t;
      } else odd = true;
    }
    this.rawDepth.push({ t, bytes: buf.byteLength, b64: b64(buf), packets });
    if (this.rawDepth.length > 20) this.rawDepth.shift();
    if (odd && this.oddDepth.length < 20) this.oddDepth.push({ t, bytes: buf.byteLength, b64: b64(buf), packets });
  }

  feedMessage(buf: ArrayBuffer, t = Date.now()) {
    for (const h of feedHeaders(buf)) if (h.code !== 50) this.keep(h.securityId, { t, feed: 'feed', code: h.code, bytes: new Uint8Array(buf.slice(h.off, h.off + h.size)) });
    this.rawFeed.push({ t, bytes: buf.byteLength, b64: b64(buf) });
    if (this.rawFeed.length > 5) this.rawFeed.shift();
  }

  quote(securityId: string, t = Date.now()) { const s = this.st(securityId); s.quotes++; s.firstQuoteAt ??= t; }

  /** Trades for a minute and not a single depth packet: take the snapshot (once per stock per day). */
  check(securityId: string, symbol: string, list: { symbol: string; securityId: string }[], t = Date.now()) {
    const s = this.stats.get(securityId);
    if (!s || this.taken.has(securityId) || s.depthBid + s.depthAsk > 0 || s.quotes < 5 || !s.firstQuoteAt || t - s.firstQuoteAt < 60_000) return;
    this.taken.add(securityId);
    const snap: Snapshot = {
      v: 1, reason: 'trades arrived but no order book (depth) packet for this stock', takenAt: t, symbol, securityId,
      stock: { ...s }, list: list.map((w) => ({ symbol: w.symbol, securityId: w.securityId })),
      headers: { ...this.headers }, unknownIds: { ...this.unknownIds }, events: [...this.events],
      rawDepth: [...this.rawDepth], rawFeed: [...this.rawFeed], oddDepth: [...this.oddDepth],
    };
    this.snapshots.set(securityId, snap);
    this.onSnapshot?.(snap);
  }

  /**
   * A snapshot of the whole session, not one stock: on demand (the Feed log button), or when the trade feed has
   * been silent while the depth feed kept flowing (the reverse of the no-book case).
   */
  snapshotAll(reason: string, list: { symbol: string; securityId: string }[], lastMsg: { depth: number; feed: number }, t = Date.now()): Snapshot {
    const allStocks: Record<string, StockStats> = {};
    for (const w of list) allStocks[w.symbol] = { ...(this.stats.get(w.securityId) ?? { depthBid: 0, depthAsk: 0, quotes: 0 }) };
    return {
      v: 1, reason, takenAt: t, symbol: 'ALL', securityId: '', stock: { depthBid: 0, depthAsk: 0, quotes: 0 },
      list: list.map((w) => ({ symbol: w.symbol, securityId: w.securityId })),
      headers: { ...this.headers }, unknownIds: { ...this.unknownIds }, events: [...this.events],
      rawDepth: [...this.rawDepth], rawFeed: [...this.rawFeed], oddDepth: [...this.oddDepth], allStocks, lastMsg: { ...lastMsg },
    };
  }

  /** Per stock: has the depth feed sent anything for it this session? (undefined = not enough trades to tell) */
  noDepth(securityId: string): boolean { return this.snapshots.has(securityId); }
}

export const diagKey = (symbol: string, t: number) => {
  const d = new Date(t + 19800_000).toISOString();
  return `order-book/diagnostics/${d.slice(0, 10)}/${symbol.toUpperCase()}_${d.slice(11, 19).replace(/:/g, '')}.json.gz`;
};
export const DIAG_RE = /^order-book\/diagnostics\/\d{4}-\d{2}-\d{2}\/[A-Z0-9&-]{1,30}_\d{6}\.json\.gz$/;
