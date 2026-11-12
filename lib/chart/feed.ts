'use client';
import { disconnectCode, disconnectReason, FEED_URL } from '../book/feed';

/**
 * Live prices for the Charts page, shared by every tradereye tab in this browser.
 *
 * Dhan allows 5 data websockets per account and the Order Book recorder already uses two, so the charts must not open
 * one per chart or per tab. One tab (whichever holds the Web Lock) opens a single feed socket and passes the prices to
 * the other tabs over a BroadcastChannel; when that tab closes, the lock moves to another chart tab, which takes over.
 * The socket is only open on weekdays 09:00-15:35 IST.
 */

export interface Quote { securityId: string; ltp: number; /** the day's traded volume so far (stocks only) */ volume?: number; /** when it arrived (ms) */ at: number }
export interface FeedItem { securityId: string; segment: string }
export type FeedStatus = { state: 'off' | 'connecting' | 'live' | 'closed' | 'error'; message?: string; leader: boolean };

const LOCK = 'tradereye-chart-feed';
const CHANNEL = 'tradereye-chart-feed';
const tabId = Math.random().toString(36).slice(2);

type Msg =
  | { k: 'want'; tab: string; items: FeedItem[] }
  | { k: 'hello' }
  | { k: 'q'; q: Quote }
  | { k: 'status'; s: FeedStatus };

/** Dhan's binary packets we use: ticker (2: LTP, LTT), quote (4) and full (8) (LTP + day volume). */
export function parseQuotes(buf: ArrayBuffer, at: number): Quote[] {
  const dv = new DataView(buf);
  const out: Quote[] = [];
  let off = 0;
  while (off + 8 <= buf.byteLength) {
    const code = dv.getUint8(off), len = dv.getInt16(off + 1, true), securityId = String(dv.getInt32(off + 4, true));
    if (code === 2 && off + 16 <= buf.byteLength) out.push({ securityId, ltp: dv.getFloat32(off + 8, true), at });
    else if ((code === 4 && off + 50 <= buf.byteLength) || (code === 8 && off + 62 <= buf.byteLength)) out.push({ securityId, ltp: dv.getFloat32(off + 8, true), volume: dv.getInt32(off + 22, true), at });
    const fallback = code === 4 ? 50 : code === 8 ? 162 : code === 2 ? 16 : code === 6 ? 16 : code === 5 ? 12 : 8;
    off += len >= 8 ? len : fallback;
  }
  return out;
}

const istMin = (ms: number) => { const t = new Date(ms + 330 * 60_000); return { wd: t.getUTCDay(), min: t.getUTCHours() * 60 + t.getUTCMinutes() }; };
export const feedHours = (ms = Date.now()) => { const { wd, min } = istMin(ms); return wd > 0 && wd < 6 && min >= 9 * 60 && min < 15 * 60 + 35; };

class SharedFeed {
  private ch: BroadcastChannel | null = null;
  private subs = new Map<string, { item: FeedItem; fns: Set<(q: Quote) => void> }>();
  private statusFns = new Set<(s: FeedStatus) => void>();
  private status: FeedStatus = { state: 'off', leader: false };
  private started = false;
  private leader = false;
  private token = '';
  private clientId = '';
  // leader only
  private wants = new Map<string, { items: FeedItem[]; at: number }>();
  private ws: WebSocket | null = null;
  private subscribed = new Set<string>();
  private attempt = 0;

  setToken(token: string, clientId: string | undefined) {
    const changed = token !== this.token;
    this.token = token; this.clientId = clientId ?? '';
    if (changed && this.leader) this.reconnect();
  }

  onStatus(fn: (s: FeedStatus) => void): () => void { this.statusFns.add(fn); fn(this.status); return () => { this.statusFns.delete(fn); }; }

  subscribe(item: FeedItem, fn: (q: Quote) => void): () => void {
    this.start();
    const key = `${item.segment}:${item.securityId}`;
    const s = this.subs.get(key) ?? { item, fns: new Set() };
    s.fns.add(fn);
    this.subs.set(key, s);
    this.announce();
    return () => { s.fns.delete(fn); if (!s.fns.size) this.subs.delete(key); this.announce(); };
  }

  private setStatus(s: Omit<FeedStatus, 'leader'>) {
    this.status = { ...s, leader: this.leader };
    for (const f of this.statusFns) f(this.status);
    if (this.leader) this.post({ k: 'status', s: this.status });
  }

  private post(m: Msg) { try { this.ch?.postMessage(m); } catch { /* channel closed */ } }

  private deliver(q: Quote) {
    for (const s of this.subs.values()) if (s.item.securityId === q.securityId) for (const f of s.fns) f(q);
  }

  private myItems(): FeedItem[] { return [...this.subs.values()].map((s) => s.item); }

  private announce() {
    if (this.leader) { this.wants.set(tabId, { items: this.myItems(), at: Date.now() }); this.syncSubs(); }
    else this.post({ k: 'want', tab: tabId, items: this.myItems() });
  }

  private start() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    if (typeof BroadcastChannel !== 'undefined') {
      this.ch = new BroadcastChannel(CHANNEL);
      this.ch.onmessage = (e: MessageEvent<Msg>) => {
        const m = e.data;
        if (m.k === 'q') this.deliver(m.q);
        else if (m.k === 'hello') this.announce();
        else if (m.k === 'status' && !this.leader) { this.status = { ...m.s, leader: false }; for (const f of this.statusFns) f(this.status); }
        else if (m.k === 'want' && this.leader) { this.wants.set(m.tab, { items: m.items, at: Date.now() }); this.syncSubs(); }
      };
    }
    // followers repeat what they want, so a new leader learns it and a dead tab's wants expire
    setInterval(() => { if (!this.leader) this.announce(); }, 15_000);
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) { this.becomeLeader(); return; }
    void locks.request(LOCK, () => new Promise<void>(() => { this.becomeLeader(); }));
  }

  private becomeLeader() {
    this.leader = true;
    this.wants.set(tabId, { items: this.myItems(), at: Date.now() });
    this.post({ k: 'hello' });
    setInterval(() => this.tick(), 10_000);
    this.tick();
  }

  /** leader: open / close the socket for market hours, drop wants of tabs that went away */
  private tick() {
    const now = Date.now();
    for (const [t, w] of this.wants) if (t !== tabId && now - w.at > 45_000) this.wants.delete(t);
    const need = this.union().length > 0 && feedHours(now) && !!this.token && !!this.clientId;
    if (need && !this.ws) { this.connect(); return; }
    if (need) return;
    if (this.ws) this.close();
    const message = !this.token ? 'Log in to Dhan for live prices' : !feedHours(now) ? 'Market closed' : undefined;
    const state = feedHours(now) ? 'off' : 'closed';
    if (this.status.state !== state || this.status.message !== message) this.setStatus({ state, message });
  }

  private union(): FeedItem[] {
    const m = new Map<string, FeedItem>();
    for (const w of this.wants.values()) for (const i of w.items) m.set(`${i.segment}:${i.securityId}`, i);
    return [...m.values()];
  }

  private syncSubs() {
    if (!this.leader) return;
    if (!this.ws) { this.tick(); return; }
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const fresh = this.union().filter((i) => !this.subscribed.has(`${i.segment}:${i.securityId}`));
    if (!fresh.length) return;
    // indices only send ticker packets; stocks get quote packets (price + day volume)
    for (const [code, list] of [[15, fresh.filter((i) => i.segment === 'IDX_I')], [17, fresh.filter((i) => i.segment !== 'IDX_I')]] as const) {
      for (let k = 0; k < list.length; k += 100) {
        const part = list.slice(k, k + 100);
        if (!part.length) continue;
        this.ws.send(JSON.stringify({ RequestCode: code, InstrumentCount: part.length, InstrumentList: part.map((i) => ({ ExchangeSegment: i.segment, SecurityId: i.securityId })) }));
      }
    }
    for (const i of fresh) this.subscribed.add(`${i.segment}:${i.securityId}`);
  }

  private connect() {
    this.setStatus({ state: 'connecting' });
    const qs = `token=${encodeURIComponent(this.token)}&clientId=${encodeURIComponent(this.clientId)}&authType=2`;
    const ws = new WebSocket(`${FEED_URL}?version=2&${qs}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.subscribed.clear();
    ws.onopen = () => { this.attempt = 0; this.setStatus({ state: 'live' }); this.syncSubs(); };
    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return;
      const dc = disconnectCode(e.data, 'feed');
      if (dc !== undefined) { this.setStatus({ state: 'error', message: `Live prices: ${disconnectReason(dc)}` }); return; }
      for (const q of parseQuotes(e.data, Date.now())) { this.deliver(q); this.post({ k: 'q', q }); }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.subscribed.clear();
      if (!feedHours() || !this.union().length) return;
      this.setStatus({ state: 'connecting', message: 'Reconnecting' });
      const wait = Math.min(30_000, 1000 * 2 ** this.attempt++);
      setTimeout(() => { if (!this.ws && this.leader) this.tick(); }, wait);
    };
    ws.onerror = () => this.setStatus({ state: 'error', message: 'Live price connection dropped (reconnecting)' });
  }

  private close() {
    const ws = this.ws;
    this.ws = null;
    this.subscribed.clear();
    if (ws) { try { ws.send(JSON.stringify({ RequestCode: 12 })); } catch { /* not open */ } ws.close(); }
  }

  private reconnect() { this.close(); this.tick(); }
}

export const sharedFeed = new SharedFeed();
