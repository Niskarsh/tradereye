import type { DepthMsg, QuoteMsg } from './feed';
import { BookModel, type Level, type Side } from './model';

/**
 * Order-book recording: 10-minute chunk files in S3, one folder per stock per day.
 *
 *   order-book/2026/october/TARIL_2026-10-16/0915.gz   (09:15:00 - 09:24:59 IST)
 *
 * A chunk is gzip'd JSON lines:
 *   line 1  {"v":1,"symbol","securityId","date","slot"}                 header
 *   line 2  ["K", t, tick, lastVolume, bid, ask, ltp, [[paise, side, qty, seenAt, firstAt, maxQty, traded, refills], ...]]
 *           the book at the start of the chunk (keyframe), so any chunk can be drawn on its own
 *   then    ["D", t, "B"|"A", [[price, qty], ...]]   a depth update (the 20 levels of one side)
 *           ["Q", t, ltp, volume]                     a quote (trade print)
 *           ["S", t, "B"|"A"]                         same side as last time, still there (keeps levels "seen")
 * Replaying the events through BookModel gives exactly the picture that was drawn live.
 */

export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const IST = 19800_000;

export function istDate(ms: number): string { return new Date(ms + IST).toISOString().slice(0, 10); }

/** The 10-minute slot (aligned to 09:15) an instant belongs to, as "HHMM" IST. */
export function slotOf(ms: number): string {
  const d = new Date(ms + IST);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  const start = 9 * 60 + 15 + Math.floor((min - (9 * 60 + 15)) / 10) * 10;
  return `${String(Math.floor(start / 60)).padStart(2, '0')}${String(start % 60).padStart(2, '0')}`;
}

/** Start of a slot in ms. */
export function slotStart(date: string, slot: string): number {
  return Date.parse(`${date}T${slot.slice(0, 2)}:${slot.slice(2)}:00Z`) - IST;
}

/** All slots of a session from 09:15 up to (and including) the one containing `until`. */
export function slotsUpTo(date: string, until: number): string[] {
  const out: string[] = [];
  for (let m = 9 * 60 + 15; m < 15 * 60 + 30; m += 10) {
    const s = `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
    if (slotStart(date, s) > until) break;
    out.push(s);
  }
  return out;
}

export function dayFolder(symbol: string, date: string): string {
  const [y, m] = date.split('-');
  return `order-book/${y}/${MONTHS[Number(m) - 1]}/${symbol.toUpperCase()}_${date}`;
}
export const chunkKey = (symbol: string, date: string, slot: string) => `${dayFolder(symbol, date)}/${slot}.gz`;
export const KEY_RE = /^order-book\/\d{4}\/[a-z]+\/[A-Z0-9&-]{1,30}_\d{4}-\d{2}-\d{2}\/\d{4}\.gz$/;

/* ---- events ---------------------------------------------------------------------------------------------- */

export type Event = ['D', number, 'B' | 'A', [number, number][]] | ['Q', number, number, number] | ['S', number, 'B' | 'A'];
type Key = ['K', number, number, number, number | null, number | null, number | null, [number, Side, number, number, number, number, number, number][]];

export function depthEvent(m: DepthMsg, t: number): Event {
  return ['D', t, m.side === 'BID' ? 'B' : 'A', m.levels.map((l) => [l.price, l.qty] as [number, number])];
}
export function quoteEvent(q: QuoteMsg, t: number): Event { return ['Q', t, q.ltp, q.volume]; }

const lastSide = new WeakMap<BookModel, Record<string, [number, number][]>>();
export function applyEvent(model: BookModel, e: Event, securityId = '') {
  if (e[0] === 'D' || e[0] === 'S') {
    const memo = lastSide.get(model) ?? {};
    const levels = e[0] === 'D' ? e[3] : memo[e[2]];
    if (e[0] === 'D') { memo[e[2]] = e[3]; lastSide.set(model, memo); }
    if (levels) model.onDepth({ securityId, side: e[2] === 'B' ? 'BID' : 'ASK', levels: levels.map(([price, qty]) => ({ price, qty, orders: 0 })) }, e[1]);
  } else model.onQuote({ securityId, ltp: e[2], ltq: 0, ltt: 0, volume: e[3], totalBuy: 0, totalSell: 0, dayHigh: 0, dayLow: 0 }, e[1]);
}

/** The book right now, for the start of a new chunk. */
export function keyframe(model: BookModel, t: number): Key {
  const lv: Key[7] = [];
  for (const [p, l] of model.levels) if (l.qty > 0) lv.push([p, l.side, l.qty, l.seenAt, l.firstAt, l.maxQty, Math.round(l.traded), l.refills]);
  return ['K', t, model.tick, model.lastVolume, model.bestBid ?? null, model.bestAsk ?? null, model.ltp ?? null, lv];
}

/** Restore a keyframe into a model that has no data for this time (fresh, or after a gap). */
export function applyKeyframe(model: BookModel, k: Key) {
  const [, t, tick, lastVolume, bid, ask, ltp, lv] = k;
  if (model.lastEventAt && t - model.lastEventAt > 60_000) model.markGap(model.lastEventAt, t);
  model.tick = tick || model.tick;
  model.lastVolume = lastVolume;
  model.bestBid = bid ?? undefined; model.bestAsk = ask ?? undefined; model.ltp = ltp ?? undefined;
  for (const [p, side, qty, seenAt, firstAt, maxQty, traded, refills] of lv) {
    const old = model.levels.get(p);
    if (old?.seg && old.seg.t1 === undefined) old.seg.t1 = t;
    const seg = { p, side, qty, t0: t, seenTill: Math.min(seenAt, t) };
    model.segments.push(seg);
    const level: Level = { side, qty, seenAt, firstAt, maxQty, traded, refills, lastDrop: 0, seg };
    model.levels.set(p, level);
  }
  model.lastEventAt = t;
}

/* ---- chunk files ------------------------------------------------------------------------------------------- */

export interface ChunkHeader { v: 1; symbol: string; securityId: string; date: string; slot: string }

export function encodeLines(header: ChunkHeader, key: Key, events: Event[]): string {
  return [JSON.stringify(header), JSON.stringify(key), ...events.map((e) => JSON.stringify(e))].join('\n');
}

export function decodeLines(text: string): { header: ChunkHeader; key?: Key; events: Event[] } {
  const lines = text.split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]) as ChunkHeader;
  let key: Key | undefined;
  const events: Event[] = [];
  for (const l of lines.slice(1)) {
    const x = JSON.parse(l);
    if (x[0] === 'K') key = x; else if (x[0] === 'D' || x[0] === 'Q' || x[0] === 'S') events.push(x);
  }
  return { header, key, events };
}

export async function gzip(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const out = new Response(new Blob([text]).stream().pipeThrough(cs));
  return new Uint8Array(await out.arrayBuffer());
}
export async function gunzip(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const ds = new DecompressionStream('gzip');
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(ds));
  return out.text();
}

/** Replay one decoded chunk into a model (keyframe only when the model has nothing at that time). */
export function replayChunk(model: BookModel, c: { key?: Key; events: Event[] }, securityId = '') {
  if (c.key && (!model.lastEventAt || c.key[1] - model.lastEventAt > 60_000)) applyKeyframe(model, c.key);
  for (const e of c.events) applyEvent(model, e, securityId);
}
