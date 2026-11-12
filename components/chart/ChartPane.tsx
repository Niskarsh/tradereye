'use client';
import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { aggregate, Chart, intervalMinutes, isIntraday, NSE, type Annotations, type Bar, type Level, type Marker, type OrderLine } from '@/packages/candle-chart/src';
import { chunkDays, seriesFor, type SymbolSeries } from '@/lib/chart/series';
import type { AlgoView } from '@/lib/chart/algo';
import { ALGO_PARTS_DEFAULT, getDrawings, onDrawings, setDrawings, type AlgoParts, type PaneCfg } from './stores';

export interface PaneProps {
  cfg: PaneCfg;
  active: boolean;
  token: string;
  extCross: number | null;
  compareNifty: boolean;
  magnet: 'off' | 'weak' | 'strong';
  tool: string | null;
  drawingsHidden: boolean;
  algo: AlgoView | null;
  showAlgo: boolean;
  algoSlot: number | null;
  algoParts?: AlgoParts;
  maximized: boolean;
  /** live orders / position of this chart's stock (drag to move, ✕ to cancel); `linesRev` redraws them (a declined drag) */
  orderLines?: OrderLine[];
  /** net position of this chart's stock (the quote box shows it between SELL and BUY) */
  positionQty?: number;
  linesRev?: number;
  onOrderMove?(id: string, price: number, from: number): void;
  onOrderCancel?(id: string): void;
  /** phone: no maximise button (one chart shows at a time) */
  compact?: boolean;
  onActivate(): void;
  onCfg(patch: Partial<PaneCfg>): void;
  onCrosshair(t: number | null): void;
  onToolDone(): void;
  onAlgoSlot(slot: number): void;
  onToggleMax(): void;
  register(chart: Chart | null): void;
}

const IST_SEC = 19800;
const NIFTY = 'NIFTY500';
const closeT = (date: string, slot: number) => Date.parse(`${date}T09:15:00Z`) / 1000 - IST_SEC + slot * 60;
const fmtR = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(4)}R`);
const LEVEL_COLORS: Record<string, string> = {
  vwap: '#2962FF', dayHi: '#E8873A', dayLo: '#E8873A', pdh: '#8FA8C2', pdl: '#8FA8C2', vah: '#DFB15B', val: '#DFB15B', poc: '#DFB15B',
  ema10: '#E8EAF0', ema5: '#A9B4C2', ema1d: '#7C8899',
};

/** the bars for an interval, built from the symbol's 1-minute or daily candles */
function barsFor(s: SymbolSeries, iv: string): Bar[] {
  if (isIntraday(iv)) return iv === '1' ? s.m1 : aggregate(s.m1, iv, NSE);
  return iv === 'D' ? s.daily : aggregate(s.daily, iv, NSE);
}
const dailyYears = (iv: string) => (iv === 'D' ? 3 : /W$/.test(iv) ? 8 : 15);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const today = () => new Date(Date.now() + IST_SEC * 1000).toISOString().slice(0, 10);

/** make sure at least `days` calendar days of 1-minute candles are loaded (another chart may have loaded fewer) */
async function ensureIntraday(s: SymbolSeries, days: number) {
  await s.loadIntraday(days);
  const want = addDays(today(), -days);
  for (let k = 0; k < 4 && s.m1From && s.m1From > want && !s.m1Done; k++) await s.loadIntradayBefore(Math.max(3, Math.round((Date.parse(s.m1From) - Date.parse(want)) / 86400_000)));
}

/** Algo Live on the chart: a dot at each close (score / bar / rank in its tooltip), the levels it read, its order. */
export function algoAnnotations(v: AlgoView, slot: number | null, intraday = true, parts: AlgoParts = ALGO_PARTS_DEFAULT): Annotations {
  if (!intraday) {
    if (!parts.orders) return {};
    // a day / week bar holds every close at once: only the trade itself, as one marker
    return { markers: v.orders.map((o) => ({ t: Math.floor(o.sentAt / 1000), position: o.side === 'short' ? 'above' : 'below', color: '#E03F53', shape: o.side === 'short' ? 'arrowDown' : 'arrowUp', text: `Algo ${o.side}`, tooltip: `Algo Live ${o.side} ${o.qty} at ${o.price} (${o.time})\nStop ${o.stop} · target ${o.target}\n${o.status}` })) };
  }
  const markers: Marker[] = !parts.dots ? [] : v.closes.map((c) => {
    const tip = [
      `${c.time} close${c.slot === 10 ? ' (shortlist)' : ''}`,
      `Score ${fmtR(c.scoreR)}${v.bar !== null ? ` · bar ${fmtR(v.bar)}` : ''}`,
      c.rank ? `#${c.rank} of ${c.of} on the list` : c.note ?? 'not scored',
      c.picked ? 'PICKED: Algo Live traded it here' : c.above ? 'Cleared the bar' : 'Below the bar',
      c.hasFacts ? 'Click: the levels and reasons at this close' : '',
    ].filter(Boolean).join('\n');
    return {
      id: String(c.slot), t: closeT(v.date, c.slot) - 60, position: 'above',
      color: c.picked ? '#E03F53' : c.above ? '#DFB15B' : '#4E5B6B', shape: c.picked ? 'arrowDown' : 'circle',
      text: c.picked || c.above || c.slot === slot ? (c.scoreR === null ? '' : `${c.scoreR >= 0 ? '+' : ''}${c.scoreR.toFixed(3)}`) : undefined,
      tooltip: tip,
    };
  });
  const levels: Level[] = [];
  const sel = v.closes.find((c) => c.slot === slot) ?? null;
  if (parts.levels && sel?.levels) for (const l of sel.levels) levels.push({ price: l.price, color: LEVEL_COLORS[l.key] ?? '#8FA8C2', label: `${l.label} @${sel.time}`, dash: l.key.startsWith('ema') ? 'dotted' : 'dashed', from: closeT(v.date, sel.slot) - 60 });
  for (const o of parts.orders ? v.orders : []) {
    const from = Math.floor(o.sentAt / 1000);
    levels.push({ price: o.avgPrice || o.price, color: '#E8EAF0', label: `Algo ${o.side} ${o.qty}`, dash: 'solid', width: 2, from });
    levels.push({ price: o.stop, color: '#E03F53', label: 'Algo stop', dash: 'solid', from });
    levels.push({ price: o.target, color: '#1DC995', label: 'Algo target', dash: 'solid', from });
    markers.push({ t: from, position: o.side === 'short' ? 'above' : 'below', color: '#E03F53', shape: o.side === 'short' ? 'arrowDown' : 'arrowUp', text: `${o.side.toUpperCase()} ${o.status}`, tooltip: `Algo Live ${o.side} ${o.qty} at ${o.price}\nStop ${o.stop} · target ${o.target}\n${o.status}` });
  }
  return { markers, levels };
}

export function ChartPane(p: PaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const props = useRef(p);
  props.current = p;
  const tokenRef = useRef(p.token);
  tokenRef.current = p.token;
  const { symbol, interval } = p.cfg;
  // what to say while the chart has no candles (loading, waiting for an Algo close, or why it failed)
  const [info, setInfo] = useState<{ state: string; message?: string; empty: boolean }>({ state: 'loading', empty: true });
  const [retry, setRetry] = useState(0);
  // how long the chart has been loading (a phone can freeze a request; the box offers Retry and says how long)
  const [since, setSince] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => { setSince(Date.now()); }, [symbol, interval, retry]);
  const loading = info.empty && (info.state === 'loading' || info.state === 'waiting');
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    // back to this tab after the phone froze it: a load stuck for 20 s starts again
    const vis = () => { if (!document.hidden && Date.now() - since > 20_000) setRetry((r) => r + 1); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [loading, since]);
  const waited = Math.round((Date.now() - since) / 1000);

  // the chart itself: made once per pane
  useEffect(() => {
    const c = new Chart(host.current!, { symbol, interval, state: p.cfg.state, description: symbol === NIFTY ? 'Index' : 'NSE' });
    chart.current = c;
    props.current.register(c);
    const off = c.on((e) => {
      const q = props.current;
      if (e.type === 'focus') q.onActivate();
      else if (e.type === 'crosshair') q.onCrosshair(e.t);
      else if (e.type === 'stateChange') q.onCfg({ state: c.getState() });
      else if (e.type === 'drawingsChange') setDrawings(q.cfg.symbol, c.getDrawings(), q.cfg.id);
      else if (e.type === 'toolDone') q.onToolDone();
      else if (e.type === 'markerClick' && e.marker.id) q.onAlgoSlot(Number(e.marker.id));
      else if (e.type === 'orderMove') q.onOrderMove?.(e.id, e.price, e.from);
      else if (e.type === 'orderCancel') q.onOrderCancel?.(e.id);
    });
    return () => { off(); props.current.register(null); c.destroy(); chart.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // data: symbol + interval
  useEffect(() => {
    const c = chart.current!;
    const s = seriesFor(symbol, () => tokenRef.current);
    let alive = true;
    c.setSymbol(symbol, symbol === NIFTY ? 'Index' : 'NSE');
    c.setInterval(interval);
    c.setBars([]);
    const intraday = isIntraday(interval), chunk = chunkDays(intervalMinutes(interval) || 1);
    const kind = intraday ? 'm1' : 'd';
    const show = () => { if (alive) setInfo({ state: s.status[kind].state, message: s.status[kind].message, empty: !c.getBars().length }); };
    const render = () => {
      if (!alive) return;
      show();
      // dashed bid / ask lines while quotes are fresh (they go away a minute after the last one)
      const ba = s.bidAsk;
      if (Date.now() - ba.at < 60_000) c.setBidAsk(ba.bid, ba.ask); else c.setBidAsk(undefined, undefined);
      const bars = barsFor(s, interval);
      const cur = c.getBars();
      if (!cur.length) c.setBars(bars);
      else if (bars.length && bars[0].t < cur[0].t) { c.prependBars(bars.filter((b) => b.t < cur[0].t)); c.updateBars(bars); }
      else c.updateBars(bars);
    };
    const off = s.onChange(render);
    let retained = false;
    let loadingMore = false;
    const first = intraday ? ensureIntraday(s, chunk) : s.loadDaily(dailyYears(interval));
    void first.then(() => { if (alive) { c.setBars(barsFor(s, interval)); show(); s.retain(); retained = true; } });
    const offHist = c.on(async (e) => {
      if (e.type !== 'needHistory' || loadingMore) return;
      loadingMore = true;
      try {
        const before = c.getBars()[0]?.t;
        for (let k = 0; k < 4; k++) {
          if (intraday) { if (s.m1Done) break; await s.loadIntradayBefore(chunk); }
          else { if (s.dailyDone) break; await s.loadDailyBefore(dailyYears(interval)); }
          if (!alive || c.getBars()[0]?.t !== before) break;
        }
        if (alive && c.getBars()[0]?.t === before) c.prependBars([]); // nothing older: stop asking
      } finally { loadingMore = false; }
    });
    // drawings belong to the symbol
    void getDrawings(symbol).then((list) => { if (alive) c.setDrawings(list); });
    const offDraw = onDrawings(symbol, (list, from) => { if (from !== props.current.cfg.id) c.setDrawings(list); });
    return () => { alive = false; off(); offHist(); offDraw(); if (retained) s.release(); };
  }, [symbol, interval, retry]);

  // a failed first load tries again by itself every 20 s (and on the Retry button)
  useEffect(() => {
    if (!(info.empty && info.state === 'error')) return;
    const t = setTimeout(() => setRetry((r) => r + 1), 20_000);
    return () => clearTimeout(t);
  }, [info]);

  // Nifty 500 compare line
  useEffect(() => {
    const c = chart.current!;
    if (!p.compareNifty || symbol === NIFTY) { c.setCompare([]); return; }
    const s = seriesFor(NIFTY, () => tokenRef.current);
    let alive = true;
    const push = () => { if (alive) c.setCompare([{ id: 'nifty', label: 'NIFTY 500', bars: barsFor(s, interval), color: '#8FA8C2' }]); };
    const off = s.onChange(push);
    const intraday = isIntraday(interval);
    void (intraday ? ensureIntraday(s, chunkDays(intervalMinutes(interval) || 1)) : s.loadDaily(dailyYears(interval))).then(() => { push(); if (alive) s.retain(); });
    return () => { alive = false; off(); s.release(); c.setCompare([]); };
  }, [p.compareNifty, symbol, interval]);

  useEffect(() => { chart.current?.setCrosshairTime(p.extCross); }, [p.extCross]);
  useEffect(() => { chart.current?.setOrderLines(p.orderLines ?? []); }, [p.orderLines, p.linesRev]);
  useEffect(() => { chart.current?.setPositionQty(p.positionQty); }, [p.positionQty]);
  useEffect(() => { chart.current?.setMagnet(p.magnet); }, [p.magnet]);
  useEffect(() => { chart.current?.setDrawingsHidden(p.drawingsHidden); }, [p.drawingsHidden]);
  useEffect(() => { if (p.active) chart.current?.setTool(p.tool); else chart.current?.setTool(null); }, [p.tool, p.active]);
  useEffect(() => {
    const c = chart.current!;
    c.setAnnotations('algo', p.algo && p.algo.symbol === symbol ? algoAnnotations(p.algo, p.algoSlot, isIntraday(interval), p.algoParts) : null);
    c.setLayerVisible('algo', p.showAlgo);
  }, [p.algo, p.algoSlot, p.algoParts, p.showAlgo, symbol, interval]);

  return (
    <div className={`group relative h-full w-full ${p.active ? 'ring-1 ring-inset ring-brand-accent/70' : ''}`} onPointerDownCapture={() => p.onActivate()}>
      <div ref={host} className="absolute inset-0" />
      {info.empty && info.state !== 'ok' && info.state !== 'idle' && (
        <div className="absolute left-1/2 top-1/2 z-10 max-w-[80%] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-strong bg-brand-section/95 px-4 py-3 text-center text-xs text-ink-2 shadow-xl">
          {info.state === 'error' ? (
            <>
              <p className="font-semibold text-data-red-text">Couldn&apos;t load {symbol} candles</p>
              <p className="mt-1 text-ink-3">{info.message}</p>
              <button onClick={() => setRetry((r) => r + 1)} className="mt-2 rounded-md border border-line-strong px-3 py-1 text-white hover:border-brand-accent">Retry now</button>
              <p className="mt-1 text-[10px] text-ink-4">Retries by itself every 20 s</p>
            </>
          ) : (
            <>
              <p>{info.state === 'waiting' ? info.message : `Loading ${symbol}…`}{waited >= 3 ? ` ${waited} s` : ''}</p>
              {waited >= 15 && <button onClick={() => setRetry((r) => r + 1)} className="mt-2 rounded-md border border-line-strong px-3 py-1 text-white hover:border-brand-accent">Retry now</button>}
            </>
          )}
        </div>
      )}
      {!p.compact && <button onClick={p.onToggleMax} title={p.maximized ? 'Restore layout (Alt+Enter)' : 'Maximise this chart (Alt+Enter)'}
        className="absolute right-[76px] top-1.5 z-10 rounded-md border border-line-strong bg-brand-section/90 p-1 text-ink-2 opacity-0 transition-opacity hover:text-white group-hover:opacity-100">
        {p.maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </button>}
    </div>
  );
}
