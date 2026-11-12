'use client';
import type { ChartState, Drawing } from '@/packages/candle-chart/src';

/**
 * What the Charts page saves (S3 through /api/chart/store, with this browser's copy as a fast first answer):
 * the layout and each symbol's drawings. Drawings belong to the symbol, so every chart showing it shares them.
 */

export interface PaneCfg { id: string; symbol: string; interval: string; state?: Partial<ChartState> }
export interface Col { w: number; rows: { h: number; pane: string }[] }
export interface Layout { v: 1; preset: string; cols: Col[]; panes: PaneCfg[]; syncSymbol: boolean; syncCrosshair: boolean; compareNifty: boolean; showAlgo: boolean; magnet: 'off' | 'weak' | 'strong' }

const LS = 'tradereye-chart-';
const lsGet = <T,>(k: string): T | undefined => { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) as T : undefined; } catch { return undefined; } };
const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* full or private */ } };

async function remoteGet<T>(what: string, symbol?: string): Promise<T | null> {
  const r = await fetch(`/api/chart/store?what=${what}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ''}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { data: T | null }).data;
}
async function remotePut(what: string, data: unknown, symbol?: string) {
  await fetch('/api/chart/store', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ what, symbol, data }) });
}

/* ---------------- layout ---------------- */

let layoutTimer: ReturnType<typeof setTimeout> | null = null;
export function saveLayout(l: Layout) {
  lsSet('layout', l);
  if (layoutTimer) clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => { void remotePut('layout', l).catch(() => undefined); }, 1500);
}
/** this browser's copy at once, then S3's (the newer source of truth, e.g. changed on the phone) */
export async function loadLayout(onLocal: (l: Layout) => void): Promise<Layout | null> {
  const local = lsGet<Layout>('layout');
  if (local?.v === 1) onLocal(local);
  const remote = await remoteGet<Layout>('layout').catch(() => null);
  return remote?.v === 1 ? remote : null;
}

/* ---------------- drawings ---------------- */

type Listener = (list: Drawing[], from: string) => void;
const drawings = new Map<string, Drawing[]>();
const loaded = new Map<string, Promise<Drawing[]>>();
const listeners = new Map<string, Set<Listener>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function getDrawings(symbol: string): Promise<Drawing[]> {
  const k = symbol.toUpperCase();
  if (drawings.has(k)) return Promise.resolve(drawings.get(k)!);
  let p = loaded.get(k);
  if (!p) {
    p = (async () => {
      const local = lsGet<Drawing[]>(`drawings-${k}`) ?? [];
      const remote = await remoteGet<Drawing[]>('drawings', k).catch(() => null);
      const list = Array.isArray(remote) ? remote : local;
      drawings.set(k, list);
      return list;
    })();
    loaded.set(k, p);
  }
  return p;
}

export function setDrawings(symbol: string, list: Drawing[], from: string) {
  const k = symbol.toUpperCase();
  drawings.set(k, list);
  lsSet(`drawings-${k}`, list);
  for (const f of listeners.get(k) ?? []) f(list, from);
  const t = timers.get(k);
  if (t) clearTimeout(t);
  timers.set(k, setTimeout(() => { void remotePut('drawings', list, k).catch(() => undefined); }, 1200));
}

export function onDrawings(symbol: string, fn: Listener): () => void {
  const k = symbol.toUpperCase();
  const s = listeners.get(k) ?? new Set();
  s.add(fn);
  listeners.set(k, s);
  return () => { s.delete(fn); };
}

/* ---------------- layouts ---------------- */

let n = 0;
export const paneId = () => `c${Date.now().toString(36)}${(n++).toString(36)}`;

/** Layout presets (TradingView's "Select layout"). */
export const PRESETS: { id: string; label: string; count: number }[] = [
  { id: '1', label: '1 chart', count: 1 },
  { id: '2v', label: '2 side by side', count: 2 },
  { id: '2h', label: '2 stacked', count: 2 },
  { id: '3L', label: '2 left + 1 big right', count: 3 },
  { id: '3R', label: '1 big left + 2 right', count: 3 },
  { id: '3c', label: '3 columns', count: 3 },
  { id: '4', label: '2 × 2', count: 4 },
];

export function colsFor(preset: string, ids: string[]): Col[] {
  const r = (pane: string, h: number) => ({ pane, h });
  switch (preset) {
    case '1': return [{ w: 1, rows: [r(ids[0], 1)] }];
    case '2v': return [{ w: 0.5, rows: [r(ids[0], 1)] }, { w: 0.5, rows: [r(ids[1], 1)] }];
    case '2h': return [{ w: 1, rows: [r(ids[0], 0.5), r(ids[1], 0.5)] }];
    case '3R': return [{ w: 0.62, rows: [r(ids[0], 1)] }, { w: 0.38, rows: [r(ids[1], 0.5), r(ids[2], 0.5)] }];
    case '3c': return [{ w: 1 / 3, rows: [r(ids[0], 1)] }, { w: 1 / 3, rows: [r(ids[1], 1)] }, { w: 1 / 3, rows: [r(ids[2], 1)] }];
    case '4': return [{ w: 0.5, rows: [r(ids[0], 0.5), r(ids[1], 0.5)] }, { w: 0.5, rows: [r(ids[2], 0.5), r(ids[3], 0.5)] }];
    default: return [{ w: 0.38, rows: [r(ids[0], 0.5), r(ids[1], 0.5)] }, { w: 0.62, rows: [r(ids[2], 1)] }]; // 3L
  }
}

/** His default: left top 5m, left bottom 1D, right (big) 10m; volume and VWAP on the intraday charts. */
export function defaultLayout(symbol = 'NIFTY500'): Layout {
  const vwap = { id: 'dvw', defId: 'vwap', inputs: { source: 'hlc3', bands: 0 }, plots: {}, visible: true, pane: 'main' };
  const panes: PaneCfg[] = [
    { id: paneId(), symbol, interval: '5', state: { indicators: [{ ...vwap, id: 'dvw5' }] as never } },
    { id: paneId(), symbol, interval: 'D', state: { indicators: [{ id: 'de200', defId: 'ema', inputs: { length: 200, source: 'close' }, plots: {}, visible: true, pane: 'main' }] as never } },
    { id: paneId(), symbol, interval: '10', state: { indicators: [{ ...vwap, id: 'dvw10' }] as never } },
  ];
  return { v: 1, preset: '3L', cols: colsFor('3L', panes.map((p) => p.id)), panes, syncSymbol: true, syncCrosshair: true, compareNifty: false, showAlgo: true, magnet: 'weak' };
}
