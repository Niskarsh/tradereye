import { BookModel } from './model';
import { DEPTH_URL, FEED_URL, parseDepth, parseFeed } from './feed';
import {
  applyEvent, chunkKey, dayFolder, decodeLines, depthEvent, encodeLines, gunzip, gzip, istDate, keyframe, quoteEvent, replayChunk,
  slotOf, slotStart, slotsUpTo, type Event,
} from './record';
import type { WatchItem } from './sheet';
import { ReversalWatch, type ReversalAlert } from './reversal';

/**
 * Records the order book of every stock on the list while the Order Book tab is open (browser only: the Dhan feed
 * needs an open page). One depth connection and one quote connection carry up to 50 stocks.
 *
 * Storage: each stock's events go into the current 10-minute chunk; the chunk is saved to S3 every 2 minutes (so a
 * closed tab loses at most ~2 minutes) and once more when the 10 minutes end. Failed saves are retried. On start it
 * first loads today's chunks from S3, so the morning is back after a refresh, and keeps appending to the current one.
 * Only one tab records at a time (a lock in localStorage); other tabs just view.
 */

export type RecStatus = 'idle' | 'loading' | 'recording' | 'stopping' | 'other-tab' | 'stopped';
/** What a long step is doing right now (shown as a progress bar): done / total, total 0 = size not known yet. */
export interface RecProgress { label: string; done: number; total: number }
export interface RecInfo { status: RecStatus; stocks: number; lastSave?: number; pending: number; error?: string; bytesToday: number; progress?: RecProgress }

interface Buf { symbol: string; securityId: string; date: string; slot: string; key: ReturnType<typeof keyframe>; events: Event[]; dirty: boolean; lastDepth: Record<string, string>; lastSeen: Record<string, number> }

const SAVE_EVERY_MS = 120_000;
const LOCK = 'tradereye-orderbook-recorder';
const tabId = Math.random().toString(36).slice(2);

export class Recorder {
  models = new Map<string, BookModel>(); // by securityId
  list: WatchItem[] = [];
  info: RecInfo = { status: 'idle', stocks: 0, pending: 0, bytesToday: 0 };
  onChange?: () => void;
  /** a reversal setup on a recorded stock (live events only, never the morning replayed from S3) */
  onAlert?: (a: ReversalAlert) => void;
  private watch = new ReversalWatch((a) => this.onAlert?.(a));
  private bufs = new Map<string, Buf>();
  private queue = new Map<string, Uint8Array>(); // failed saves, by key
  private sockets: WebSocket[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private running = false;
  private token = ''; private clientId = '';

  constructor(private api: (path: string, init?: RequestInit) => Promise<Response>) {}

  /** Model for a stock (created on demand, so a chart can show it before recording starts). */
  model(securityId: string) { let m = this.models.get(securityId); if (!m) { m = new BookModel(); this.models.set(securityId, m); } return m; }

  private set(p: Partial<RecInfo>) { this.info = { ...this.info, ...p, stocks: this.list.length, pending: this.queue.size }; this.onChange?.(); }

  /* ---- the single-tab lock ---- */
  private lockHeld(): boolean {
    try {
      const v = JSON.parse(localStorage.getItem(LOCK) ?? 'null') as { id: string; at: number } | null;
      return !!v && v.id !== tabId && Date.now() - v.at < 15_000;
    } catch { return false; }
  }
  private beat() { try { localStorage.setItem(LOCK, JSON.stringify({ id: tabId, at: Date.now() })); } catch { /* private mode */ } }
  private release() { try { const v = JSON.parse(localStorage.getItem(LOCK) ?? 'null'); if (v?.id === tabId) localStorage.removeItem(LOCK); } catch { /* ignore */ } }

  async start(list: WatchItem[], token: string, clientId: string) {
    if (this.running) return;
    if (this.lockHeld()) { this.set({ status: 'other-tab' }); return; }
    this.running = true; this.token = token; this.clientId = clientId; this.list = list.slice(0, 50);
    this.beat();
    this.timers.push(setInterval(() => this.beat(), 5_000));
    // progress: each stock counts equally; within a stock, by the share of its saved chunks loaded
    const share = new Map<string, number>();
    const report = () => this.set({ progress: { label: "Loading today's saved data", done: [...share.values()].reduce((a, b) => a + b, 0), total: this.list.length } });
    this.set({ status: 'loading', error: undefined, progress: { label: "Loading today's saved data", done: 0, total: this.list.length } });
    await Promise.all(this.list.map((w) => this.restore(w, (d, t) => { share.set(w.securityId, t ? d / t : 1); report(); }).catch(() => {}).finally(() => { share.set(w.securityId, 1); report(); })));
    if (!this.running) return;
    this.set({ progress: { label: 'Connecting to Dhan', done: 0, total: 0 } });
    this.connect();
    this.timers.push(setInterval(() => { void this.saveAll(false); }, SAVE_EVERY_MS));
    window.addEventListener('pagehide', this.onHide);
    this.set({ status: 'recording', progress: undefined });
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const ws of this.sockets) { try { ws.send(JSON.stringify({ RequestCode: 12 })); } catch { /* closing */ } ws.close(); }
    this.sockets = [];
    window.removeEventListener('pagehide', this.onHide);
    this.set({ status: 'stopping', progress: { label: 'Saving to S3', done: 0, total: this.queue.size + this.bufs.size } });
    await this.saveAll(true, (d, t) => this.set({ progress: { label: 'Saving to S3', done: d, total: t } }));
    this.set({ progress: { label: 'Updating the index', done: 0, total: 0 } });
    await this.saveIndex();
    this.release();
    this.set({ status: 'stopped', progress: undefined });
  }

  /** Add stocks while recording (they start immediately). */
  async add(items: WatchItem[]) {
    const fresh = items.filter((w) => !this.list.some((x) => x.securityId === w.securityId));
    if (!fresh.length) return;
    this.list = [...this.list, ...fresh].slice(0, 50);
    this.set({});
    if (!this.running) return;
    await Promise.all(fresh.map((w) => this.restore(w).catch(() => {})));
    this.subscribe(fresh);
  }

  async remove(securityId: string) {
    const buf = this.bufs.get(securityId);
    if (buf && this.running) await this.save(buf, true);
    this.list = this.list.filter((w) => w.securityId !== securityId);
    this.bufs.delete(securityId);
    this.set({});
    // the feeds have no per-stock unsubscribe we rely on; reconnecting with the new list is simplest
    if (this.running) { for (const ws of this.sockets) ws.close(); this.sockets = []; this.connect(); }
  }

  /* ---- S3 restore: today's chunks, so a refresh or another device picks up the morning ---- */
  private async restore(w: WatchItem, onProgress?: Progress) {
    const now = Date.now(), date = istDate(now);
    const m = this.model(w.securityId);
    if (m.lastEventAt) return; // already in memory
    const slots = await savedSlots(this.api, w.symbol, date, now);
    const err = await loadChunks(this.api, w.symbol, date, slots, (slot, c) => {
      replayChunk(m, c, w.securityId);
      // the current slot keeps growing: continue appending to what is already saved
      if (slot === slotOf(now) && c.key) this.bufs.set(w.securityId, { symbol: w.symbol, securityId: w.securityId, date, slot, key: c.key, events: c.events, dirty: false, lastDepth: {}, lastSeen: {} });
    }, onProgress);
    if (err) this.set({ error: err });
    if (m.lastEventAt && now - m.lastEventAt > 60_000) m.markGap(m.lastEventAt, now);
  }

  /* ---- Dhan feeds ---- */
  private connect() {
    const qs = `token=${encodeURIComponent(this.token)}&clientId=${encodeURIComponent(this.clientId)}&authType=2`;
    const open = (url: string, code: 17 | 23, onMsg: (b: ArrayBuffer) => void, attempt = 0) => {
      if (!this.running) return;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { attempt = 0; this.sendSubs(ws, code, this.list); };
      ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) onMsg(e.data); };
      ws.onclose = () => {
        this.sockets = this.sockets.filter((s) => s !== ws);
        if (this.running) setTimeout(() => open(url, code, onMsg, attempt + 1), Math.min(30_000, 1000 * 2 ** attempt));
      };
      ws.onerror = () => this.set({ error: 'Dhan feed connection dropped (reconnecting).' });
      this.sockets.push(ws);
    };
    open(`${DEPTH_URL}?${qs}`, 23, (b) => { const t = Date.now(); for (const d of parseDepth(b)) this.onEvent(d.securityId, depthEvent(d, t)); });
    open(`${FEED_URL}?version=2&${qs}`, 17, (b) => { const t = Date.now(); for (const q of parseFeed(b)) this.onEvent(q.securityId, quoteEvent(q, t)); });
  }

  private sendSubs(ws: WebSocket, code: 17 | 23, items: WatchItem[]) {
    for (let i = 0; i < items.length; i += 50) {
      const part = items.slice(i, i + 50);
      ws.send(JSON.stringify({ RequestCode: code, InstrumentCount: part.length, InstrumentList: part.map((w) => ({ ExchangeSegment: 'NSE_EQ', SecurityId: w.securityId })) }));
    }
  }
  private subscribe(items: WatchItem[]) {
    for (const ws of this.sockets) if (ws.readyState === WebSocket.OPEN) this.sendSubs(ws, ws.url.includes('twentydepth') ? 23 : 17, items);
  }

  private onEvent(securityId: string, e: Event) {
    const w = this.list.find((x) => x.securityId === securityId);
    if (!w) return;
    const m = this.model(securityId);
    const t = e[1];
    let buf = this.bufs.get(securityId);
    const slot = slotOf(t), date = istDate(t);
    if (!buf || buf.slot !== slot || buf.date !== date) {
      const rolled = !!buf;
      if (buf) void this.save(buf, true); // the 10 minutes are over: final save of that chunk
      buf = { symbol: w.symbol, securityId, date, slot, key: keyframe(m, t), events: [], dirty: true, lastDepth: {}, lastSeen: {} };
      this.bufs.set(securityId, buf);
      if (rolled) void this.saveIndex();
    }
    if (e[0] === 'D') {
      const sig = JSON.stringify(e[3]);
      if (buf.lastDepth[e[2]] === sig) {
        // unchanged side: store a tiny "still there" marker at most every 5 s (keeps levels "seen" on replay)
        if (t - (buf.lastSeen[e[2]] ?? 0) < 5_000) { applyEvent(m, ['S', t, e[2]], securityId); this.watch.check(securityId, w.symbol, m, t); return; }
        buf.lastSeen[e[2]] = t;
        const s: Event = ['S', t, e[2]];
        applyEvent(m, s, securityId);
        buf.events.push(s); buf.dirty = true;
        this.watch.check(securityId, w.symbol, m, t);
        return;
      }
      buf.lastDepth[e[2]] = sig; buf.lastSeen[e[2]] = t;
    }
    applyEvent(m, e, securityId);
    buf.events.push(e);
    buf.dirty = true;
    this.watch.check(securityId, w.symbol, m, t);
  }

  /** Stocks not on screen keep only their last 15 minutes in memory (the rest is in S3). */
  trimHidden(viewed: Set<string>) {
    const cut = Date.now() - 15 * 60_000;
    for (const [id, m] of this.models) if (!viewed.has(id)) m.trim(cut);
  }

  /** A stock's full day for a chart: rebuilt from S3 (earlier chunks) plus the chunk being recorded now. */
  async fullModel(w: WatchItem, onProgress?: Progress): Promise<BookModel> {
    const live = this.models.get(w.securityId);
    if (live && !live.trimmedBefore) return live;
    const date = istDate(Date.now());
    const m = new BookModel();
    const cur = this.bufs.get(w.securityId);
    const slots = (await savedSlots(this.api, w.symbol, date, Date.now())).filter((s) => !cur || s < cur.slot);
    await loadChunks(this.api, w.symbol, date, slots, (_, c) => replayChunk(m, c, w.securityId), onProgress);
    if (cur) replayChunk(m, { key: cur.key, events: cur.events }, w.securityId);
    this.models.set(w.securityId, m);
    return m;
  }

  /* ---- saving ---- */
  private async save(buf: Buf, final: boolean) {
    if (!buf.dirty && !final) return;
    const key = chunkKey(buf.symbol, buf.date, buf.slot);
    const bytes = await gzip(encodeLines({ v: 1, symbol: buf.symbol, securityId: buf.securityId, date: buf.date, slot: buf.slot }, buf.key, buf.events));
    buf.dirty = false;
    await this.upload(key, bytes);
  }

  private async upload(key: string, bytes: Uint8Array) {
    try {
      const r = await this.api(`/api/book/chunk?key=${encodeURIComponent(key)}`, { method: 'POST', body: bytes as BodyInit, headers: { 'Content-Type': 'application/gzip' } });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`); }
      this.queue.delete(key);
      this.set({ lastSave: Date.now(), error: undefined, bytesToday: this.info.bytesToday + bytes.length });
    } catch (e) {
      this.queue.set(key, bytes); // newest version of that chunk wins; retried on the next save round
      this.set({ error: `Save to S3 failed: ${(e as Error).message} (will retry)` });
    }
  }

  async saveAll(final: boolean, onProgress?: Progress) {
    const jobs = [...[...this.queue].map(([key, bytes]) => () => this.upload(key, bytes)), ...[...this.bufs.values()].map((buf) => () => this.save(buf, final))];
    let done = 0;
    onProgress?.(0, jobs.length);
    await Promise.all(jobs.map((j) => limited(j).finally(() => onProgress?.(++done, jobs.length))));
  }

  /** One row per stock per day in the sheet index (batched, every 10 minutes and on stop). */
  private async saveIndex() {
    const rows = this.list.map((w) => {
      const m = this.models.get(w.securityId);
      const date = istDate(Date.now());
      const firstSeg = m?.segments.find((s) => istDate(s.t0) === date);
      if (!m || !m.lastEventAt || !firstSeg) return undefined;
      const hhmm = (t: number) => new Date(t + 19800_000).toISOString().slice(11, 16);
      const slots = slotsUpTo(date, m.lastEventAt).filter((s) => slotStart(date, s) >= firstSeg.t0 - 600_000);
      const walls = m.walls(m.lastEventAt).map((x) => `${x.side === 'ASK' ? 'S' : 'B'} ${x.price} ${x.qty} ${x.status}`).join('; ');
      return { date, symbol: w.symbol, securityId: w.securityId, folder: dayFolder(w.symbol, date), from: hhmm(firstSeg.t0), to: hhmm(m.lastEventAt), slots, walls };
    }).filter(Boolean);
    if (!rows.length) return;
    try { await this.api('/api/book/index', { method: 'POST', body: JSON.stringify({ rows }), headers: { 'Content-Type': 'application/json' } }); } catch { /* next round */ }
  }

  /** Tab closing: a last save attempt (small chunks fit in a keepalive request). */
  private onHide = () => {
    for (const buf of this.bufs.values()) {
      if (!buf.dirty) continue;
      void gzip(encodeLines({ v: 1, symbol: buf.symbol, securityId: buf.securityId, date: buf.date, slot: buf.slot }, buf.key, buf.events)).then((bytes) => {
        if (bytes.length > 60_000) return;
        void this.api(`/api/book/chunk?key=${encodeURIComponent(chunkKey(buf.symbol, buf.date, buf.slot))}`, { method: 'POST', body: bytes as BodyInit, keepalive: true, headers: { 'Content-Type': 'application/gzip' } });
      });
    }
    this.release();
  };
}

type Api = (path: string, init?: RequestInit) => Promise<Response>;
/** done / total chunks (total 0 = still finding out which chunks exist). */
export type Progress = (done: number, total: number) => void;

/* At most 8 S3 downloads / uploads at once across the whole tab (fast, without flooding the browser). */
const MAX_PARALLEL = 8;
let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  while (running >= MAX_PARALLEL) await new Promise<void>((ok) => waiting.push(ok));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

/**
 * Download a stock-day's chunks in parallel and hand them over strictly in time order (the replay needs order).
 * Returns an error message if any chunk could not be read (missing chunks are fine).
 */
export async function loadChunks(api: Api, symbol: string, date: string, slots: string[], onChunk: (slot: string, c: ReturnType<typeof decodeLines>) => void, onProgress?: Progress): Promise<string | undefined> {
  const got: (ReturnType<typeof decodeLines> | null | undefined)[] = slots.map(() => undefined);
  let next = 0, done = 0, error: string | undefined;
  const flush = () => {
    while (next < slots.length && got[next] !== undefined) {
      const c = got[next]; got[next] = null;
      if (c) onChunk(slots[next], c);
      next++;
    }
  };
  onProgress?.(0, slots.length);
  await Promise.all(slots.map((slot, i) => limited(async () => {
    let c: ReturnType<typeof decodeLines> | null = null;
    try {
      const r = await api(`/api/book/chunk?key=${encodeURIComponent(chunkKey(symbol, date, slot))}`);
      if (r.ok) c = decodeLines(await gunzip(await r.arrayBuffer()));
      else if (r.status !== 404) { const j = await r.json().catch(() => ({})); error = j.message ?? `S3 read failed (HTTP ${r.status})`; }
    } catch (e) { error = (e as Error).message; }
    got[i] = c;
    flush();
    onProgress?.(++done, slots.length);
  })));
  return error;
}

/** Load a whole past (or today's, view-only) day for one stock from S3 into a fresh model. */
export async function loadDay(api: Api, w: WatchItem, date: string, onProgress?: Progress): Promise<BookModel> {
  const m = new BookModel();
  onProgress?.(0, 0);
  const slots = await savedSlots(api, w.symbol, date, Math.min(Date.now(), slotStart(date, '1525') + 600_000));
  await loadChunks(api, w.symbol, date, slots, (_, c) => replayChunk(m, c, w.securityId), onProgress);
  return m;
}

/**
 * The slots that were actually saved for a stock-day (one S3 listing), so only real files are fetched: no stream
 * of "404 not found" for times that were never recorded. Without list permission, falls back to trying each slot.
 */
export async function savedSlots(api: Api, symbol: string, date: string, until: number): Promise<string[]> {
  const all = slotsUpTo(date, until);
  try {
    const r = await api(`/api/book/list?folder=${encodeURIComponent(dayFolder(symbol, date))}`);
    if (r.ok) { const j = await r.json(); if (Array.isArray(j.slots)) { const have = new Set<string>(j.slots); return all.filter((s) => have.has(s)); } }
  } catch { /* fall back */ }
  return all;
}
