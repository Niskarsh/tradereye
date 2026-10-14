/* eslint-disable @typescript-eslint/no-explicit-any */
import { decodeJwt } from './live/time';

/**
 * Minimal server-side Dhan REST client. The token is always passed in per request (the app never
 * stores it server-side) and is never logged.
 */

export const DHAN_API = 'https://api.dhan.co/v2';
export const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

export class DhanError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'DhanError';
  }
  /** Token missing/expired/invalid. */
  get isAuth() { return !this.isNoDataPlan && (this.status === 401 || this.code === 'DH-901' || /invalid_authentication|token.*expired/i.test(this.message)); }
  /** Data APIs are not active on the account (the paid plan lapsed or was never taken). */
  get isNoDataPlan() { return this.code === 'DH-902' || /not subscribed|data api/i.test(this.message); }
  get isRateLimited() { return this.status === 429 || this.code === 'DH-904' || this.code === '805'; }
}

export interface DhanClientOptions { token: string; fetchImpl?: typeof fetch; base?: string; sleep?: (ms: number) => Promise<void> }

export interface Candles { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }

export interface Profile {
  dhanClientId: string;
  tokenValidity?: string;
  dataPlan?: string;
  dataValidity?: string;
  activeSegment?: string;
}

export class DhanClient {
  private f: typeof fetch;
  private base: string;
  private sleep: (ms: number) => Promise<void>;
  constructor(private o: DhanClientOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.base = o.base ?? DHAN_API;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async req<T>(method: 'GET' | 'POST', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    let last: DhanError | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.f(this.base + path, {
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'access-token': this.o.token, ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
      if (res.ok) return json as T;
      const code = String(json?.errorCode ?? json?.data?.['810'] ?? json?.errorType ?? '');
      const msg = String(json?.errorMessage ?? json?.message ?? text.slice(0, 200) ?? res.statusText);
      last = new DhanError(res.status, code, msg || `HTTP ${res.status}`);
      if (last.isRateLimited && attempt < 2) { await this.sleep(1200 * (attempt + 1)); continue; }
      break;
    }
    throw last ?? new DhanError(0, '', 'Dhan request failed');
  }

  orders() { return this.req<any[]>('GET', '/orders').then((r) => (Array.isArray(r) ? r : [])); }
  trades() { return this.req<any[]>('GET', '/trades').then((r) => (Array.isArray(r) ? r : [])); }
  positions() { return this.req<any[]>('GET', '/positions').then((r) => (Array.isArray(r) ? r : [])); }
  profile() { return this.req<Profile>('GET', '/profile'); }

  /** Renews a still-valid web-generated token for another 24h. The OLD token stops working. */
  async renewToken(dhanClientId: string) {
    type R = { accessToken?: string; token?: string; expiryTime?: string };
    try {
      return await this.req<R>('GET', '/RenewToken', undefined, { dhanClientId });
    } catch (e) {
      // The docs only name the path; be tolerant if the method differs.
      if (e instanceof DhanError && (e.status === 405 || e.status === 404)) return this.req<R>('POST', '/RenewToken', undefined, { dhanClientId });
      throw e;
    }
  }

  /**
   * Intraday candles for IST date keys `from`..`to` (inclusive of the whole `to` session).
   * The window starts at 09:00 on purpose: Dhan leaves out a candle stamped exactly at `fromDate`, so a
   * 09:15 start silently dropped the 09:15 candle of the first day (which broke the Nifty first-5-min move).
   */
  async intraday(p: { securityId: string; segment: string; instrument: string; from: string; to: string; interval?: number }): Promise<Candles> {
    const raw = await this.req<any>('POST', '/charts/intraday', {
      securityId: String(p.securityId), exchangeSegment: p.segment, instrument: p.instrument,
      interval: String(p.interval ?? 1), fromDate: `${p.from} 09:00:00`, toDate: `${p.to} 15:35:00`,
    });
    return parseCandles(raw);
  }

  /**
   * Last traded price for one instrument (Market Quote API, part of the Data API plan). Dhan wants the client id
   * in a header for this one. Returns undefined when the price is not in the answer.
   */
  async ltp(clientId: string, segment: string, securityId: string): Promise<number | undefined> {
    const raw = await this.req<any>('POST', '/marketfeed/ltp', { [segment]: [Number(securityId)] }, { 'client-id': clientId });
    const node = raw?.data?.[segment]?.[String(securityId)] ?? raw?.data?.[segment]?.[Number(securityId)];
    const p = Number(node?.last_price ?? node?.lastPrice ?? node?.LTP);
    return Number.isFinite(p) && p > 0 ? p : undefined;
  }

  /** Daily candles for [from, to) -- Dhan treats toDate as exclusive. Used for the official previous close. */
  async daily(p: { securityId: string; segment: string; instrument: string; from: string; to: string }): Promise<Candles> {
    const raw = await this.req<any>('POST', '/charts/historical', {
      securityId: String(p.securityId), exchangeSegment: p.segment, instrument: p.instrument,
      expiryCode: 0, oi: false, fromDate: p.from, toDate: p.to,
    });
    return parseCandles(raw);
  }
}

/** Last daily close strictly before `date` (IST date key), or undefined. */
export function previousClose(daily: Candles, date: string): number | undefined {
  let best: { key: string; c: number } | undefined;
  for (let i = 0; i < daily.t.length; i++) {
    const d = new Date(daily.t[i] * 1000 + 330 * 60_000).toISOString().slice(0, 10);
    if (d < date && (!best || d > best.key)) best = { key: d, c: daily.c[i] };
  }
  return best?.c;
}

const EPOCH_1980 = 315532800;

/** Picks the epoch (Unix, or 1980-based) that lands within the last ~6 years, which is what Dhan serves. */
export function epochOffset(firstTs: number, nowMs: number = Date.now()): number {
  const lo = nowMs - 6 * 365 * 86400_000, hi = nowMs + 3 * 86400_000;
  const ok = (off: number) => { const ms = (firstTs + off) * 1000; return ms >= lo && ms <= hi; };
  if (ok(0)) return 0;
  if (ok(EPOCH_1980)) return EPOCH_1980;
  return 0;
}

/** Dhan returns parallel arrays; the timestamp epoch has appeared in both Unix and 1980-based form. */
export function parseCandles(raw: any, nowMs: number = Date.now()): Candles {
  const d = raw?.data?.open ? raw.data : raw;
  const out: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  if (!d || !Array.isArray(d.timestamp) || d.timestamp.length === 0) return out;
  const offset = epochOffset(Number(d.timestamp[0]), nowMs);
  for (let i = 0; i < d.timestamp.length; i++) {
    out.t.push(Number(d.timestamp[i]) + offset);
    out.o.push(Number(d.open[i])); out.h.push(Number(d.high[i]));
    out.l.push(Number(d.low[i])); out.c.push(Number(d.close[i])); out.v.push(Number(d.volume?.[i] ?? 0));
  }
  return out;
}

/* ---- instrument master (symbol -> securityId) for rows logged before SecurityId existed ------ */

let masterCache: Map<string, string> | null = null;

export function parseScripMaster(csv: string): Map<string, string> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return new Map();
  const split = (line: string) => {
    const out: string[] = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
      else if (ch === '"') inQ = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur); return out;
  };
  const head = split(lines[0]).map((h) => h.trim().replace(/^﻿/, ''));
  const pick = (...names: string[]) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const iExch = pick('SEM_EXM_EXCH_ID', 'EXCH_ID'), iSeg = pick('SEM_SEGMENT', 'SEGMENT');
  const iId = pick('SEM_SMST_SECURITY_ID', 'SECURITY_ID'), iSym = pick('SEM_TRADING_SYMBOL', 'UNDERLYING_SYMBOL', 'SYMBOL_NAME');
  const iInst = pick('SEM_INSTRUMENT_NAME', 'INSTRUMENT'), iSeries = pick('SEM_SERIES', 'SERIES');
  const map = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const f = split(line);
    if (iExch >= 0 && f[iExch] !== 'NSE') continue;
    if (iSeg >= 0 && f[iSeg] !== 'E') continue;
    if (iInst >= 0 && f[iInst] !== 'EQUITY') continue;
    if (iSeries >= 0 && f[iSeries] && f[iSeries] !== 'EQ') continue;
    map.set((f[iSym] ?? '').trim().toUpperCase(), (f[iId] ?? '').trim());
  }
  return map;
}

export async function lookupSecurityId(symbol: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  if (!masterCache) {
    const res = await fetchImpl(SCRIP_MASTER_URL);
    if (!res.ok) throw new Error(`Could not download the Dhan instrument list (HTTP ${res.status})`);
    masterCache = parseScripMaster(await res.text());
  }
  return masterCache.get(symbol.toUpperCase());
}

export function clientIdFromToken(token: string): string | undefined {
  return decodeJwt(token)?.dhanClientId;
}

/** NSE equity symbols starting with `prefix` (for the co-pilot's symbol box), shortest first. */
export async function symbolsMatching(prefix: string, limit = 8, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const p = prefix.trim().toUpperCase();
  if (!p) return [];
  await lookupSecurityId(p, fetchImpl); // loads the instrument list once
  const out: string[] = [];
  for (const s of masterCache?.keys() ?? []) if (s.startsWith(p)) out.push(s);
  return out.sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
}
