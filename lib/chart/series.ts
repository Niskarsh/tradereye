'use client';
import type { Bar } from '@/packages/candle-chart/src';
import { sharedFeed, type Quote } from './feed';
import { algoQuietMs } from './quiet';
import { fetchT } from './fetchTimeout';

/**
 * One symbol's candles in this tab, shared by every chart showing it: 1-minute candles (from which every intraday
 * interval is built) and daily candles (for D / W / M). Older history is loaded in pieces as a chart scrolls left;
 * today's candles are kept moving by the live feed and checked against Dhan once a minute.
 */

interface Candles { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }
interface BarsAnswer { symbol: string; securityId?: string; segment?: string; c: Candles; partial?: boolean; retryInMs?: number; needsDhan?: boolean }

const IST_MS = 330 * 60_000;
const DAY = 86400_000;
export const istToday = (ms = Date.now()) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const istMinute = (ms: number) => { const t = new Date(ms + IST_MS); return t.getUTCHours() * 60 + t.getUTCMinutes(); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let queue: Promise<unknown> = Promise.resolve();
/** 1-minute candles (every intraday interval) and daily candles load (and fail) separately */
export type Kind = 'm1' | 'd';
export interface Status { state: 'idle' | 'loading' | 'waiting' | 'ok' | 'error'; message?: string }
const SID_KEY = (s: string) => `tradereye-chart-sid-${s}`;

const toBars = (c: Candles): Bar[] => c.t.map((t, i) => ({ t, o: c.o[i], h: c.h[i], l: c.l[i], c: c.c[i], v: c.v[i] }));
function merge(a: Bar[], b: Bar[]): Bar[] {
  const m = new Map<number, Bar>();
  for (const x of a) m.set(x.t, x);
  for (const x of b) m.set(x.t, x);
  return [...m.values()].sort((x, y) => x.t - y.t);
}

/** calendar days of 1-minute history fetched at a time, by chart interval (minutes) */
export function chunkDays(intervalMin: number): number {
  if (intervalMin <= 1) return 4;
  if (intervalMin <= 3) return 7;
  if (intervalMin <= 5) return 14;
  if (intervalMin <= 10) return 21;
  if (intervalMin <= 15) return 30;
  if (intervalMin <= 30) return 45;
  return 84;
}

export class SymbolSeries {
  securityId?: string;
  segment = 'NSE_EQ';
  m1: Bar[] = [];
  daily: Bar[] = [];
  /** earliest date asked for (1-minute / daily); undefined = nothing loaded */
  m1From?: string;
  dailyFrom?: string;
  m1Done = false;
  dailyDone = false;
  error = '';
  /** what the charts show while there are no candles: loading / waiting / error */
  status: Record<Kind, Status> = { m1: { state: 'idle' }, d: { state: 'idle' } };
  private listeners = new Set<() => void>();
  private loading = new Map<string, Promise<void>>();
  private unsubFeed: (() => void) | null = null;
  private lastVol: number | undefined;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private users = 0;

  constructor(readonly symbol: string, private token: () => string) {
    try { const v = localStorage.getItem(SID_KEY(symbol)); if (v && /^\d{1,10}$/.test(v)) this.securityId = v; } catch { /* private mode */ }
    if (symbol === 'NIFTY500') { this.securityId = '19'; this.segment = 'IDX_I'; }
  }

  setSid(id: string) {
    if (!/^\d{1,10}$/.test(id) || this.securityId === id) return;
    this.securityId = id;
    try { localStorage.setItem(SID_KEY(this.symbol), id); } catch { /* private mode */ }
  }

  private setStatus(kind: Kind, state: Status['state'], message?: string) { this.status[kind] = { state, message }; this.notify(true); }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private notify(now = false) {
    if (now) { if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; } for (const f of this.listeners) f(); return; }
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => { this.notifyTimer = null; for (const f of this.listeners) f(); }, 200);
  }

  private async fetchBars(kind: '1m' | '1d', from: string, to: string): Promise<BarsAnswer> {
    // one chart request at a time per tab: several charts (and tabs) opening together must not burst Dhan
    const turn = queue.then(() => this.fetchBarsNow(kind, from, to));
    queue = turn.then(() => sleep(250), () => sleep(250));
    return turn;
  }

  private async fetchBarsNow(kind: '1m' | '1d', from: string, to: string): Promise<BarsAnswer> {
    let last = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      // never compete with Algo Live for Dhan right after its closes (lib/chart/quiet.ts)
      const quiet = algoQuietMs();
      if (quiet) { this.setStatus(kind === '1d' ? 'd' : 'm1', 'waiting', 'Waiting for Algo Live’s close to pass (charts stay off Dhan for 2 min)'); await sleep(quiet + 500); }
      let r: Response, j: Record<string, unknown> = {};
      try {
        r = await fetchT('/api/chart/bars', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-dhan-token': this.token() },
          body: JSON.stringify({ symbol: this.symbol, kind, from, to, securityId: this.securityId }),
        }, 30_000);
        j = await r.json().catch(() => ({}));
      } catch (e) { last = `network: ${(e as Error).message}`; await sleep(1500 * (attempt + 1)); continue; }
      // busy / timed out / server hiccup: try again, slower each time
      if (r.status === 429 || r.status >= 500) { last = String(j?.message ?? `HTTP ${r.status}`); await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(String(j?.message ?? `HTTP ${r.status}`));
      const a = j as unknown as BarsAnswer;
      if (a.securityId) this.setSid(a.securityId);
      if (a.segment) this.segment = a.segment;
      if (a.partial && a.retryInMs && attempt < 5) { await sleep(a.retryInMs + 500); continue; }
      if (a.partial && a.needsDhan) this.error = 'Some candles are not saved yet: log in on the Dhan login tab to fetch them.';
      return a;
    }
    throw new Error(`Dhan did not answer after 6 tries (${last || 'busy'}). Retrying shortly.`);
  }

  private once(key: string, kind: Kind, job: () => Promise<void>): Promise<void> {
    const cur = this.loading.get(key);
    if (cur) return cur;
    if (this.status[kind].state !== 'ok') this.setStatus(kind, 'loading');
    const p = job()
      .then(() => { if (this.status[kind].state !== 'ok') this.setStatus(kind, 'ok'); })
      .catch((e) => { this.error = (e as Error).message; this.setStatus(kind, 'error', this.error); })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, p);
    return p;
  }

  /** the latest `days` calendar days of 1-minute candles (first load) */
  loadIntraday(days: number): Promise<void> {
    if (this.m1From) return Promise.resolve();
    return this.once('m1-first', 'm1', async () => {
      const to = istToday(), from = addDays(to, -days);
      const a = await this.fetchBars('1m', from, to);
      this.m1 = merge(this.m1, toBars(a.c));
      this.m1From = from;
      this.error = a.needsDhan ? this.error : '';
      this.notify(true);
    });
  }

  /** `days` more calendar days of 1-minute candles before what is loaded; resolves with how many bars came */
  loadIntradayBefore(days: number): Promise<void> {
    if (!this.m1From || this.m1Done) return Promise.resolve();
    return this.once('m1-more', 'm1', async () => {
      const to = addDays(this.m1From!, -1), from = addDays(to, -days);
      const a = await this.fetchBars('1m', from, to);
      const add = toBars(a.c);
      this.m1From = from;
      // about 5 years of 1-minute candles exist at Dhan; three empty pieces in a row = the start
      if (!add.length) this.emptyRuns++; else this.emptyRuns = 0;
      if (this.emptyRuns >= 3) this.m1Done = true;
      this.m1 = merge(add, this.m1);
      this.notify(true);
    });
  }
  private emptyRuns = 0;

  loadDaily(years: number): Promise<void> {
    if (this.dailyFrom) return Promise.resolve();
    return this.once('d-first', 'd', async () => {
      const to = istToday(), from = addDays(to, -Math.round(years * 365));
      const a = await this.fetchBars('1d', from, to);
      this.daily = merge(this.daily, toBars(a.c));
      this.dailyFrom = from;
      this.notify(true);
    });
  }
  loadDailyBefore(years: number): Promise<void> {
    if (!this.dailyFrom || this.dailyDone) return Promise.resolve();
    return this.once('d-more', 'd', async () => {
      const to = addDays(this.dailyFrom!, -1), from = addDays(to, -Math.round(years * 365));
      const a = await this.fetchBars('1d', from, to);
      const add = toBars(a.c);
      this.dailyFrom = from;
      if (!add.length) this.dailyDone = true;
      this.daily = merge(add, this.daily);
      this.notify(true);
    });
  }

  /** start / stop following live prices (counted: several charts can use one symbol) */
  retain() {
    this.users++;
    if (this.users > 1) return;
    const start = () => {
      if (!this.securityId) { setTimeout(() => { if (this.users) start(); }, 1000); return; }
      this.unsubFeed = sharedFeed.subscribe({ securityId: this.securityId, segment: this.segment }, (q) => this.onQuote(q));
    };
    start();
    this.reconcileTimer = setInterval(() => void this.reconcile(), 60_000);
  }
  release() {
    this.users = Math.max(0, this.users - 1);
    if (this.users) return;
    this.unsubFeed?.(); this.unsubFeed = null;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  /** best bid / ask from the live feed (stocks), with when they came */
  bidAsk: { bid?: number; ask?: number; at: number } = { at: 0 };

  private onQuote(q: Quote) {
    if (!(q.ltp > 0)) return;
    if (q.bid !== undefined || q.ask !== undefined) this.bidAsk = { bid: q.bid, ask: q.ask, at: q.at };
    const min = istMinute(q.at);
    if (min < 555 || min >= 930) return;
    const t = Math.floor(q.at / 60_000) * 60;
    const dv = q.volume !== undefined && this.lastVol !== undefined ? Math.max(0, q.volume - this.lastVol) : 0;
    if (q.volume !== undefined) this.lastVol = q.volume;
    if (this.m1From) {
      const last = this.m1[this.m1.length - 1];
      if (last && last.t === t) { last.h = Math.max(last.h, q.ltp); last.l = Math.min(last.l, q.ltp); last.c = q.ltp; last.v += dv; }
      else if (!last || t > last.t) this.m1.push({ t, o: q.ltp, h: q.ltp, l: q.ltp, c: q.ltp, v: dv });
    }
    if (this.dailyFrom) {
      const dayT = Math.floor((q.at + IST_MS) / DAY) * 86400 - IST_MS / 1000;
      const last = this.daily[this.daily.length - 1];
      if (last && istToday(last.t * 1000) === istToday(q.at)) { last.h = Math.max(last.h, q.ltp); last.l = Math.min(last.l, q.ltp); last.c = q.ltp; if (q.volume !== undefined) last.v = q.volume; }
      else this.daily.push({ t: dayT, o: q.ltp, h: q.ltp, l: q.ltp, c: q.ltp, v: q.volume ?? 0 });
    }
    this.notify();
  }

  /** once a minute in market hours: today's finished minutes as Dhan has them (fixes anything the feed missed) */
  private async reconcile() {
    const now = Date.now(), min = istMinute(now);
    if (!this.m1From || min < 556 || min > 935 || document.hidden || algoQuietMs(now)) return;
    try {
      const today = istToday(now);
      const a = await this.fetchBars('1m', today, today);
      const fresh = toBars(a.c);
      if (!fresh.length) return;
      const cur = this.m1[this.m1.length - 1];
      // keep the minute still forming from the feed if Dhan does not have it yet
      this.m1 = merge(this.m1, fresh);
      if (cur && cur.t > fresh[fresh.length - 1].t) this.m1 = merge(this.m1, [cur]);
      this.notify(true);
    } catch { /* the next minute tries again */ }
  }
}

const cache = new Map<string, SymbolSeries>();
export function seriesFor(symbol: string, token: () => string): SymbolSeries {
  const k = symbol.toUpperCase();
  let s = cache.get(k);
  if (!s) { s = new SymbolSeries(k, token); cache.set(k, s); }
  return s;
}
