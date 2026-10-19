/**
 * Dhan binary feeds (little endian), parsed in the browser.
 *  - 20-level depth (wss://depth-api-feed.dhan.co/twentydepth): header 12 bytes [len int16, code u8, segment u8,
 *    securityId int32, seq u32] then 20 x 16-byte levels [price f64, qty u32, orders u32]. Code 41 = bids, 51 = asks.
 *    One websocket message can carry several of these back to back.
 *  - Live market feed (wss://api-feed.dhan.co?version=2): header 8 bytes [code u8, len int16, segment u8,
 *    securityId int32]. Quote packet (code 4): LTP f32, LTQ i16, LTT i32, ATP f32, volume i32, total sell i32,
 *    total buy i32, open, close, high, low f32.
 */

export interface DepthLevel { price: number; qty: number; orders: number }
export interface DepthMsg { securityId: string; side: 'BID' | 'ASK'; levels: DepthLevel[] }
export interface QuoteMsg { securityId: string; ltp: number; ltq: number; ltt: number; volume: number; totalBuy: number; totalSell: number; dayHigh: number; dayLow: number }

export const DEPTH_URL = 'wss://depth-api-feed.dhan.co/twentydepth';
export const FEED_URL = 'wss://api-feed.dhan.co';
export const SEGMENT = { NSE_EQ: 1, NSE_FNO: 2 } as const;

export function parseDepth(buf: ArrayBuffer): DepthMsg[] {
  const dv = new DataView(buf);
  const out: DepthMsg[] = [];
  let off = 0;
  while (off + 12 <= buf.byteLength) {
    const len = dv.getInt16(off, true);
    const code = dv.getUint8(off + 2);
    const securityId = String(dv.getInt32(off + 4, true));
    // a full depth message is 12 + 20 x 16 = 332 bytes; fall back to that when the length field disagrees
    const size = len >= 12 && off + len <= buf.byteLength ? len : 332;
    if (code === 41 || code === 51) {
      const levels: DepthLevel[] = [];
      for (let p = off + 12; p + 16 <= Math.min(off + size, buf.byteLength); p += 16) {
        const price = dv.getFloat64(p, true), qty = dv.getUint32(p + 8, true), orders = dv.getUint32(p + 12, true);
        if (price > 0 && qty > 0) levels.push({ price, qty, orders });
      }
      out.push({ securityId, side: code === 41 ? 'BID' : 'ASK', levels });
    }
    off += size;
  }
  return out;
}

export function parseFeed(buf: ArrayBuffer): QuoteMsg[] {
  const dv = new DataView(buf);
  const out: QuoteMsg[] = [];
  let off = 0;
  while (off + 8 <= buf.byteLength) {
    const code = dv.getUint8(off);
    const len = dv.getInt16(off + 1, true);
    const securityId = String(dv.getInt32(off + 4, true));
    if ((code === 4 && off + 50 <= buf.byteLength) || (code === 8 && off + 62 <= buf.byteLength)) {
      const q: QuoteMsg = {
        securityId, ltp: dv.getFloat32(off + 8, true), ltq: dv.getInt16(off + 12, true), ltt: dv.getInt32(off + 14, true),
        volume: dv.getInt32(off + 22, true), totalSell: dv.getInt32(off + 26, true), totalBuy: dv.getInt32(off + 30, true),
        dayHigh: dv.getFloat32(off + (code === 4 ? 42 : 54), true), dayLow: dv.getFloat32(off + (code === 4 ? 46 : 58), true),
      };
      out.push(q);
    }
    const fallback = code === 4 ? 50 : code === 8 ? 162 : code === 2 ? 16 : code === 6 ? 16 : code === 5 ? 12 : 8;
    off += len >= 8 ? len : fallback;
  }
  return out;
}

export const subscribeDepth = (securityId: string, segment = 'NSE_EQ') =>
  JSON.stringify({ RequestCode: 23, InstrumentCount: 1, InstrumentList: [{ ExchangeSegment: segment, SecurityId: securityId }] });
export const subscribeQuote = (securityId: string, segment = 'NSE_EQ') =>
  JSON.stringify({ RequestCode: 17, InstrumentCount: 1, InstrumentList: [{ ExchangeSegment: segment, SecurityId: securityId }] });

/**
 * Dhan's "you are disconnected" packet (feed response code 50): the reason code sits right after the header
 * (8-byte header on the live market feed, 12-byte header on the depth feed). Undefined if this is not one.
 */
export function disconnectCode(buf: ArrayBuffer, kind: 'feed' | 'depth'): number | undefined {
  const dv = new DataView(buf);
  const hdr = kind === 'feed' ? 8 : 12;
  const codeAt = kind === 'feed' ? 0 : 2;
  if (buf.byteLength < hdr + 2 || dv.getUint8(codeAt) !== 50) return undefined;
  return dv.getInt16(hdr, true);
}

/** Dhan's disconnect reasons in plain words (Annexure of the DhanHQ docs). */
export function disconnectReason(code: number): string {
  switch (code) {
    case 805: return 'too many Dhan data connections (Dhan allows 5 per account; it drops the oldest). Close other apps or tabs using the Dhan API';
    case 806: return 'the Dhan Data API plan is not active on this account';
    case 807: return 'the Dhan access token has expired: generate a new one';
    case 808: return 'invalid client ID';
    case 809: return 'Dhan authentication failed: check the token';
    default: return `Dhan disconnected it (code ${code})`;
  }
}

