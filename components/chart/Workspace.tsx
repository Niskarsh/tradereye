'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ChevronDown, ExternalLink, Maximize2, Minimize2, Search, X } from 'lucide-react';
import { useTrading } from './useTrading';
import { intervalLabel, listIndicators, listTools, MONO_CANDLES, type Chart } from '@/packages/candle-chart/src';
import { useAuth } from '@/context/AuthContext';
import { sharedFeed, type FeedStatus } from '@/lib/chart/feed';
import { seriesFor } from '@/lib/chart/series';
import { fetchT } from '@/lib/chart/fetchTimeout';
import type { AlgoView } from '@/lib/chart/algo';
import { ChartPane } from './ChartPane';
import { AlgoPanel } from './AlgoPanel';
import { ToolIcon } from './icons';
import { ALGO_PARTS_DEFAULT, colsFor, defaultLayout, loadLayout, paneId, PRESETS, saveLayout, type Layout, type PaneCfg } from './stores';

const INTERVALS = ['1', '3', '5', '10', '15', '30', '60', '120', '240', 'D', 'W', 'M'];
const QUICK = ['1', '5', '10', '15', '60', 'D', 'W'];
const TOOL_GROUPS = ['Lines', 'Fibonacci', 'Shapes', 'Positions', 'Measure', 'Text'] as const;
const IST_MS = 330 * 60_000;
const istDate = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const f = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    window.addEventListener('pointerdown', f);
    return () => window.removeEventListener('pointerdown', f);
  }, [open, close]);
  return ref;
}

function Menu({ label, title, children, wide, align = 'left' }: { label: React.ReactNode; title: string; children: (close: () => void) => React.ReactNode; wide?: boolean; align?: 'left' | 'right' }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const close = useCallback(() => setAt(null), []);
  const ref = useOutside(!!at, close);
  const btn = useRef<HTMLButtonElement>(null);
  const width = wide ? 288 : 192;
  const open = () => {
    if (at) { close(); return; }
    const r = btn.current!.getBoundingClientRect();
    const left = align === 'right' ? r.right - width : r.left;
    setAt({ left: Math.max(6, Math.min(window.innerWidth - width - 6, left)), top: r.bottom + 4 });
  };
  return (
    <div ref={ref} className="relative shrink-0">
      <button ref={btn} title={title} onClick={open} className={`tb ${at ? 'bg-white/10 text-white' : ''}`}>{label}<ChevronDown className="size-3 opacity-60" /></button>
      {at && <div style={{ left: at.left, top: at.top, width }} className="cc-scroll fixed z-[90] max-h-[70vh] overflow-auto rounded-lg border border-line-strong bg-brand-section p-1 shadow-2xl">{children(close)}</div>}
    </div>
  );
}

function useIsMobile() {
  const [m, setM] = useState(false);
  useEffect(() => {
    const q = window.matchMedia('(max-width: 767px)');
    const f = () => setM(q.matches);
    f();
    q.addEventListener('change', f);
    return () => q.removeEventListener('change', f);
  }, []);
  return m;
}

/** symbol search: type to filter Dhan's NSE list (and NIFTY500) */
function SymbolSearch({ initial, onPick, onClose }: { initial: string; onPick: (s: string) => void; onClose: () => void }) {
  const [q, setQ] = useState(initial);
  const [list, setList] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  useEffect(() => {
    const term = q.trim().toUpperCase();
    if (!term) { setList([]); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/chart/symbols?q=${encodeURIComponent(term)}`, { signal: ctl.signal }).then((r) => r.json()).then((j) => { setList(j.symbols ?? []); setSel(0); }).catch(() => undefined);
    }, 150);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);
  const pick = (s: string) => { onPick(s); onClose(); };
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/50 pt-[12vh]" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[min(520px,92vw)] overflow-hidden rounded-xl border border-line-strong bg-brand-section shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <Search className="size-4 text-ink-3" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Symbol, e.g. HDFCBANK or NIFTY500"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(list.length - 1, s + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              else if (e.key === 'Enter') { const s = list[sel] ?? q.trim().toUpperCase(); if (s) pick(s); }
            }}
            className="flex-1 bg-transparent text-sm uppercase text-white outline-none placeholder:normal-case placeholder:text-ink-4" />
          <button onClick={onClose} className="text-ink-3 hover:text-white"><X className="size-4" /></button>
        </div>
        <div className="max-h-[50vh] overflow-auto py-1">
          {list.map((s, i) => (
            <button key={s} onClick={() => pick(s)} onMouseEnter={() => setSel(i)}
              className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${i === sel ? 'bg-white/5 text-white' : 'text-ink-2'}`}>
              <span className="font-semibold">{s}</span><span className="text-xs text-ink-3">{s === 'NIFTY500' ? 'Index' : 'NSE'}</span>
            </button>
          ))}
          {!list.length && <p className="px-4 py-3 text-xs text-ink-3">{q.trim() ? 'No match yet: keep typing.' : 'Start typing a symbol.'}</p>}
        </div>
      </div>
    </div>
  );
}

function IndicatorPicker({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const all = useMemo(() => listIndicators(), []);
  const shown = all.filter((d) => !q || `${d.name} ${d.short}`.toLowerCase().includes(q.toLowerCase()));
  const cats = [...new Set(shown.map((d) => d.category))];
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/50 pt-[10vh]" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[min(560px,92vw)] overflow-hidden rounded-xl border border-line-strong bg-brand-section shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <Search className="size-4 text-ink-3" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} placeholder="Search indicators"
            className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-ink-4" />
          <button onClick={onClose} className="text-ink-3 hover:text-white"><X className="size-4" /></button>
        </div>
        <div className="max-h-[60vh] overflow-auto py-1">
          {cats.map((c) => (
            <div key={c}>
              <p className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-ink-3">{c}</p>
              {shown.filter((d) => d.category === c).map((d) => (
                <button key={d.id} onClick={() => onPick(d.id)} className="flex w-full items-center justify-between px-4 py-1.5 text-left text-sm text-ink-2 hover:bg-white/5 hover:text-white">
                  <span>{d.name}</span>
                  <span className="text-xs text-ink-3">{d.overlay ? 'on price' : 'own pane'}{d.intradayOnly ? ' · intraday' : ''}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <p className="border-t border-line px-4 py-2 text-[11px] text-ink-3">Click to add (several times for several). Hover an indicator on the chart for Hide / Settings / ✕.</p>
      </div>
    </div>
  );
}

export function Workspace({ initialSymbol, algoDate }: { initialSymbol?: string; algoDate?: string }) {
  const { token, clientId } = useAuth();
  const [layout, setLayout] = useState<Layout | null>(null);
  const [activeId, setActiveId] = useState<string>('');
  const [maxId, setMaxId] = useState<string | null>(null);
  const [tool, setTool] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [cross, setCross] = useState<{ t: number | null; from: string }>({ t: null, from: '' });
  const [search, setSearch] = useState<{ initial: string } | null>(null);
  const [picker, setPicker] = useState(false);
  const [algo, setAlgo] = useState<AlgoView | null>(null);
  const [algoSlot, setAlgoSlot] = useState<number | null>(null);
  const [algoErr, setAlgoErr] = useState('');
  const [feed, setFeed] = useState<FeedStatus>({ state: 'off', leader: false });
  const [toolGroup, setToolGroup] = useState<string | null>(null);
  const charts = useRef(new Map<string, Chart>());
  // expanded: the charts cover the whole window, over the site's top menu (remembered in this browser)
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { try { setExpanded(localStorage.getItem('tradereye-chart-expanded') === '1'); } catch { /* private mode */ } }, []);
  // P&L on hover: the open position's P&L at the price under the crosshair (remembered in this browser)
  const [pnlHover, setPnlHover] = useState(false);
  useEffect(() => { try { setPnlHover(localStorage.getItem('tradereye-chart-pnl-hover') === '1'); } catch { /* private mode */ } }, []);
  const togglePnlHover = () => setPnlHover((v) => { try { localStorage.setItem('tradereye-chart-pnl-hover', v ? '0' : '1'); } catch { /* private mode */ } return !v; });
  const toggleExpanded = () => setExpanded((e) => { try { localStorage.setItem('tradereye-chart-expanded', e ? '0' : '1'); } catch { /* private mode */ } return !e; });
  const [, force] = useState(0);
  const date = algoDate ?? istDate();
  const mobile = useIsMobile();
  const [toolsOpen, setToolsOpen] = useState(false);
  // phone: Algo Live's panel is a sheet, opened by the Algo button (the chart gets the screen otherwise)
  const [sheet, setSheet] = useState(false);

  useEffect(() => { sharedFeed.setToken(token, clientId); }, [token, clientId]);
  useEffect(() => { const off = sharedFeed.onStatus(setFeed); return () => { off(); }; }, []);

  // the layout: this browser's copy first, then S3's; ?symbol= wins
  useEffect(() => {
    let done = false;
    const apply = (l: Layout) => {
      const lay: Layout = JSON.parse(JSON.stringify(l));
      // charts saved before candle colours existed get the white / black candles
      lay.panes = lay.panes.map((p) => (p.state?.candles ? p : { ...p, state: { ...p.state, candles: { ...MONO_CANDLES } } }));
      // once: plain candles become volume candles (a type picked after this is kept)
      if (!lay.volumeCandles) { lay.panes = lay.panes.map((p) => (!p.state?.type || p.state.type === 'candles' ? { ...p, state: { ...p.state, type: 'volume' } } : p)); lay.volumeCandles = true; saveLayout(lay); }
      if (initialSymbol) lay.panes = lay.panes.map((p) => (lay.syncSymbol || p === lay.panes[0] ? { ...p, symbol: initialSymbol } : p));
      if (initialSymbol && algoDate) lay.showAlgo = true;
      setLayout(lay);
      setActiveId((a) => (lay.panes.some((p) => p.id === a) ? a : lay.panes[lay.panes.length - 1]?.id ?? ''));
    };
    void loadLayout((l) => { done = true; apply(l); }).then((remote) => {
      if (remote) apply(remote);
      else if (!done) apply(defaultLayout(initialSymbol ?? 'NIFTY500'));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = useCallback((f: (l: Layout) => Layout) => {
    setLayout((l) => { if (!l) return l; const n = f(l); saveLayout(n); return n; });
  }, []);

  const active = layout?.panes.find((p) => p.id === activeId) ?? layout?.panes[0];
  const activeChart = active ? charts.current.get(active.id) : undefined;
  const symbol = active?.symbol ?? '';
  const trade = useTrading(symbol, token);

  const setPane = useCallback((id: string, patch: Partial<PaneCfg>) => update((l) => ({ ...l, panes: l.panes.map((p) => (p.id === id ? { ...p, ...patch } : p)) })), [update]);
  const setSymbol = useCallback((s: string) => {
    const sym = s.trim().toUpperCase();
    if (!sym) return;
    update((l) => ({ ...l, panes: l.panes.map((p) => (l.syncSymbol || p.id === activeId ? { ...p, symbol: sym } : p)) }));
    setAlgoSlot(null);
  }, [update, activeId]);

  const setPreset = (preset: string) => update((l) => {
    const count = PRESETS.find((p) => p.id === preset)?.count ?? 1;
    const panes = l.panes.slice(0, count);
    const base = l.panes.find((p) => p.id === activeId) ?? l.panes[0];
    while (panes.length < count) panes.push({ id: paneId(), symbol: base.symbol, interval: base.interval, state: base.state });
    setMaxId(null);
    if (!panes.some((p) => p.id === activeId)) setActiveId(panes[0].id);
    return { ...l, preset, panes, cols: colsFor(preset, panes.map((p) => p.id)) };
  });

  // Algo Live's view of the active symbol (S3 only: safe while it trades); refreshed each minute while it trades
  const loadAlgo = useCallback(async (slot?: number | null) => {
    if (!symbol) return;
    try {
      const r = await fetchT(`/api/chart/algo?symbol=${encodeURIComponent(symbol)}&date=${date}${slot != null ? `&slot=${slot}` : ''}`, { cache: 'no-store' }, 20_000);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.message ?? `HTTP ${r.status}`);
      setAlgo(j as AlgoView); setAlgoErr('');
      if ((j as AlgoView).securityId) seriesFor(symbol, () => token).setSid((j as AlgoView).securityId!);
      if (slot == null) setAlgoSlot((j as AlgoView).reasonsAt ?? null);
    } catch (e) { setAlgoErr((e as Error).message); }
  }, [symbol, date, token]);
  useEffect(() => { setAlgo(null); void loadAlgo(null); }, [loadAlgo]);
  useEffect(() => {
    const id = setInterval(() => {
      const t = new Date(Date.now() + IST_MS), m = t.getUTCHours() * 60 + t.getUTCMinutes();
      if (date === istDate() && m >= 9 * 60 + 25 && m <= 11 * 60 + 10 && !document.hidden) void loadAlgo(algoSlot);
    }, 60_000);
    return () => clearInterval(id);
  }, [loadAlgo, algoSlot, date]);
  const pickSlot = (slot: number) => { setAlgoSlot(slot); void loadAlgo(slot); };
  const algoRelevant = !!algo && (algo.onList || algo.closes.length > 0);

  // keyboard: typing a letter opens symbol search (as on TradingView); Alt+Enter maximises
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.altKey && e.key === 'Enter') { e.preventDefault(); setMaxId((m) => (m ? null : activeId)); return; }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[a-zA-Z0-9]$/.test(e.key) && !search && !picker) { e.preventDefault(); setSearch({ initial: e.key.toUpperCase() }); }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [activeId, search, picker]);

  // shell height: fill the window below the header
  const shell = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(600);
  useEffect(() => {
    const fit = () => { const top = expanded ? 0 : shell.current?.getBoundingClientRect().top ?? 80; setH(Math.max(360, window.innerHeight - top)); };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [layout === null, expanded]);

  // dividers
  const grid = useRef<HTMLDivElement>(null);
  const dragCol = (ci: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const box = grid.current!.getBoundingClientRect();
    const start = e.clientX, l0 = layout!;
    const a = l0.cols[ci].w, b = l0.cols[ci + 1].w;
    const move = (ev: PointerEvent) => {
      const dw = (ev.clientX - start) / box.width;
      const na = Math.max(0.12, Math.min(a + b - 0.12, a + dw));
      update((l) => ({ ...l, cols: l.cols.map((c, i) => (i === ci ? { ...c, w: na } : i === ci + 1 ? { ...c, w: a + b - na } : c)) }));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const dragRow = (ci: number, ri: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const col = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const start = e.clientY, rows = layout!.cols[ci].rows;
    const a = rows[ri].h, b = rows[ri + 1].h;
    const move = (ev: PointerEvent) => {
      const dh = (ev.clientY - start) / col.height;
      const na = Math.max(0.12, Math.min(a + b - 0.12, a + dh));
      update((l) => ({ ...l, cols: l.cols.map((c, i) => (i !== ci ? c : { ...c, rows: c.rows.map((r, j) => (j === ri ? { ...r, h: na } : j === ri + 1 ? { ...r, h: a + b - na } : r)) })) }));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  if (!layout) return <div ref={shell} className="flex h-[60vh] items-center justify-center text-sm text-ink-3">Loading charts…</div>;

  const pane = (cfg: PaneCfg) => (
    <ChartPane key={cfg.id} cfg={cfg} active={cfg.id === active?.id} token={token}
      extCross={layout.syncCrosshair && cross.from !== cfg.id ? cross.t : null}
      compareNifty={cfg.compareNifty ?? false} magnet={layout.magnet} tool={tool} drawingsHidden={hidden}
      algo={algoRelevant ? algo : null} showAlgo={layout.showAlgo} algoSlot={algoSlot} algoParts={layout.algoParts ?? ALGO_PARTS_DEFAULT}
      maximized={maxId === cfg.id} compact={mobile} highlight={!mobile && !showMax && layout.panes.length > 1}
      orderLines={cfg.symbol === symbol ? trade.lines : []} linesRev={trade.rev} positionQty={cfg.symbol === symbol ? trade.book?.position?.netQty : undefined}
      pnlPos={cfg.symbol === symbol ? trade.pnlPos : null} pnlHover={pnlHover}
      onOrderMove={trade.actions.move} onOrderCancel={trade.actions.cancel}
      onActivate={() => setActiveId(cfg.id)}
      onCfg={(patch) => setPane(cfg.id, patch)}
      onCrosshair={(t) => setCross({ t, from: cfg.id })}
      onToolDone={() => setTool(null)}
      onAlgoSlot={pickSlot}
      onToggleMax={() => setMaxId((m) => (m === cfg.id ? null : cfg.id))}
      register={(c) => { if (c) charts.current.set(cfg.id, c); else charts.current.delete(cfg.id); force((x) => x + 1); }} />
  );

  const tools = listTools();
  const shot = () => {
    if (!activeChart || !active) return;
    const a = document.createElement('a');
    a.href = activeChart.screenshot();
    a.download = `${active.symbol}_${intervalLabel(active.interval)}_${istDate()}.png`;
    a.click();
  };
  const settings = () => activeChart?.openSettings({
    allOption: layout.panes.length > 1,
    title: active ? `${active.symbol} ${intervalLabel(active.interval)}` : undefined,
    onApply: (st, all) => {
      if (active) setPane(active.id, { state: activeChart.getState() });
      if (all) for (const [id, c] of charts.current) if (id !== active?.id) { c.setState({ type: st.type, candles: st.candles, grid: st.grid, sessionBreaks: st.sessionBreaks, volCandles: st.volCandles }); setPane(id, { state: c.getState() }); }
    },
  });
  const feedDot = feed.state === 'live' ? 'bg-data-green' : feed.state === 'connecting' ? 'bg-data-caution animate-pulse' : feed.state === 'error' ? 'bg-data-red' : 'bg-ink-4';
  const feedText = feed.state === 'live' ? 'Live' : feed.message ?? (feed.state === 'connecting' ? 'Connecting' : 'Not live');
  const showMax = !mobile && maxId && layout.panes.some((p) => p.id === maxId);
  const tradeBtn = 'tb disabled:pointer-events-none disabled:opacity-35';
  const item = 'flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm hover:bg-white/5';

  return (
    <div ref={shell} style={{ height: expanded ? '100dvh' : h }} className={`flex flex-col bg-brand-bg text-ink-2 ${expanded ? 'fixed inset-0 z-[70]' : ''}`}>
      <style>{`.tb{display:inline-flex;flex:none;align-items:center;gap:4px;border-radius:6px;padding:5px 8px;font-size:12.5px;color:var(--ink-2);white-space:nowrap}.tb:hover{background:rgba(232,234,240,.06);color:#fff}.tb-on{color:var(--candlelight-gold)!important;background:rgba(223,177,91,.1)}.tb-sep{width:1px;flex:none;align-self:stretch;margin:4px 4px;background:var(--line)}
.cc-scroll{scrollbar-width:thin;scrollbar-color:var(--line-strong) transparent}.cc-scroll::-webkit-scrollbar{width:8px;height:6px}.cc-scroll::-webkit-scrollbar-thumb{background:var(--line-strong);border-radius:8px}.cc-scroll::-webkit-scrollbar-track{background:transparent}`}</style>
      {/* top strip: one row (scrolls sideways on a phone) */}
      <div className="cc-scroll flex flex-nowrap items-center gap-0.5 overflow-x-auto border-b border-line bg-brand-section px-1.5 py-1">
        {mobile && <button className={`tb ${toolsOpen ? 'tb-on' : ''}`} onClick={() => setToolsOpen((v) => !v)} title="Drawing tools"><ToolIcon name="trend" className="size-4" /></button>}
        <button className="tb font-semibold text-white" onClick={() => setSearch({ initial: '' })} title="Symbol search (or just start typing)"><Search className="size-3.5" />{symbol || 'Symbol'}</button>
        <span className="tb-sep" />
        {(mobile ? ['1', '5', '10', 'D'] : QUICK).map((iv) => (
          <button key={iv} onClick={() => active && setPane(active.id, { interval: iv })} className={`tb ${active?.interval === iv ? 'tb-on' : ''}`}>{intervalLabel(iv)}</button>
        ))}
        <Menu label="" title="More intervals">{(close) => INTERVALS.map((iv) => (
          <button key={iv} onClick={() => { if (active) setPane(active.id, { interval: iv }); close(); }} className={`block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-white/5 ${active?.interval === iv ? 'text-brand-accent' : ''}`}>{intervalLabel(iv)}</button>
        ))}</Menu>
        <span className="tb-sep" />
        <button className="tb" onClick={() => setPicker(true)} title="Indicators (volume too)">ƒx Indicators</button>
        <button className={`tb ${active?.compareNifty ? 'tb-on' : ''}`} onClick={() => active && setPane(active.id, { compareNifty: !active.compareNifty })} title="Compare the selected chart with Nifty 500 (its price scale switches to %)">+ Nifty</button>
        <button className={`tb ${layout.showAlgo ? 'tb-on' : ''}`} onClick={() => { if (mobile && layout.showAlgo && !sheet) { setSheet(true); return; } setSheet(mobile && !layout.showAlgo); update((l) => ({ ...l, showAlgo: !l.showAlgo })); }}
          title={algoRelevant ? 'Show / hide what Algo Live saw (dots, levels, order, reasons)' : `${symbol} is not on Algo Live's list on ${date}`}>
          Algo {algoRelevant ? (layout.showAlgo ? 'on' : 'off') : '—'}
        </button>
        <span className="tb-sep" />
        {/* trading: the active chart's stock */}
        <button className={`${tradeBtn} text-data-red-text`} disabled={!trade.hasPosition || !!trade.busy} onClick={trade.actions.flatten} title={trade.hasPosition ? 'Cancel this stock\'s stop / target / other orders, then close the position at market' : `No open ${symbol} position`}>
          {trade.busy === 'flatten' ? 'Flattening…' : 'Flatten'}
        </button>
        <button className={tradeBtn} disabled={!trade.hasOrders || !!trade.busy} onClick={trade.actions.clearAll} title={trade.hasOrders ? 'Cancel every working order of this stock (the position stays)' : `No working ${symbol} orders`}>
          {trade.busy === 'clearall' ? 'Clearing…' : 'Clear all'}
        </button>
        <button className={`${tradeBtn} text-brand-accent`} disabled={!trade.hasPosition || !trade.hasStop || !!trade.busy} onClick={trade.actions.breakEven} title={trade.hasPosition ? (trade.hasStop ? 'Move the stop to break-even after Dhan\'s charges and slippage' : 'No stop order to move') : `No open ${symbol} position`}>
          {trade.busy === 'breakeven' ? 'Moving…' : 'Break-even'}
        </button>
        <button className={`tb ${pnlHover ? 'tb-on' : ''}`} onClick={togglePnlHover}
          title={pnlHover ? 'P&L on hover is on: the crosshair shows your open position\'s P&L at that price' : 'Show your open position\'s P&L at the price under the crosshair'}>
          P&amp;L hover {pnlHover ? 'on' : 'off'}
        </button>
        <button className={`${tradeBtn} text-data-green`} disabled={!trade.hasPosition || trade.hasStop || !!trade.busy} onClick={trade.actions.addStop}
          title={!trade.hasPosition ? `No open ${symbol} position` : trade.hasStop ? 'The position already has a stop' : 'Add a stop (stop-limit, 0.5% limit buffer) and a target at Algo Live\'s levels for this stock (they cancel each other)'}>
          {trade.busy === 'addstop' ? 'Adding…' : 'Add stop'}
        </button>
        {trade.bookErr && <span className="tb text-data-caution" title={`Orders could not be read: ${trade.bookErr}`}>⚠ orders off</span>}
        <span className="ml-auto" />
        <Menu label="Layout" title="Layout and sync" wide align="right">{(close) => (
          <div className="p-1">
            {!mobile && <div className="grid grid-cols-2 gap-1">
              {PRESETS.map((p) => (
                <button key={p.id} onClick={() => { setPreset(p.id); close(); }} className={`rounded px-2 py-1.5 text-left text-xs hover:bg-white/5 ${layout.preset === p.id ? 'text-brand-accent' : ''}`}>{p.label}</button>
              ))}
            </div>}
            {mobile && <p className="px-2 py-1 text-xs text-ink-3">On a phone one chart shows at a time: switch with the tabs under the strip. Layouts are for the laptop.</p>}
            <div className="mt-2 border-t border-line pt-2 text-xs">
              <label className="flex items-center gap-2 px-2 py-1"><input type="checkbox" checked={layout.syncSymbol} onChange={(e) => update((l) => ({ ...l, syncSymbol: e.target.checked }))} />Same symbol on every chart</label>
              <label className="flex items-center gap-2 px-2 py-1"><input type="checkbox" checked={layout.syncCrosshair} onChange={(e) => update((l) => ({ ...l, syncCrosshair: e.target.checked }))} />Crosshair follows across charts</label>
              <button className="mt-1 w-full rounded px-2 py-1.5 text-left text-ink-3 hover:bg-white/5 hover:text-white" onClick={() => { const d = defaultLayout(symbol || 'NIFTY500'); setLayout(d); saveLayout(d); setActiveId(d.panes[2].id); close(); }}>Reset to default (5m · 1D · 10m)</button>
            </div>
          </div>
        )}</Menu>
        <button className="tb" onClick={settings} title="Chart settings: chart type, candle colours, grid">⚙</button>
        <button className={`tb ${expanded ? 'tb-on' : ''}`} onClick={toggleExpanded} title={expanded ? 'Back to the page (show the top menu)' : 'Expand the charts over the whole window'}>
          {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>
        <Menu label="⋯" title="More" align="right">{(close) => (<>
          <button className={item} onClick={() => { activeChart?.undo(); close(); }}><ToolIcon name="undo" className="size-4" />Undo drawing <span className="ml-auto text-[10px] text-ink-4">Ctrl+Z</span></button>
          <button className={item} onClick={() => { activeChart?.redo(); close(); }}><ToolIcon name="redo" className="size-4" />Redo <span className="ml-auto text-[10px] text-ink-4">Ctrl+Shift+Z</span></button>
          <button className={item} onClick={() => { activeChart?.resetScales(); close(); }}>⟲ Reset chart scales <span className="ml-auto text-[10px] text-ink-4">Alt+R</span></button>
          <div className="my-1 h-px bg-line" />
          {(['linear', 'log', 'percent'] as const).map((m) => (
            <button key={m} className={item} onClick={() => { activeChart?.setScaleMode(m); close(); }}>Scale: {m === 'linear' ? 'regular' : m === 'log' ? 'logarithmic' : 'percent'}</button>
          ))}
          <button className={item} onClick={() => { activeChart?.setVolumeVisible(!activeChart.hasVolume()); close(); force((x) => x + 1); }}>{activeChart?.hasVolume() ? 'Remove volume' : 'Add volume'}</button>
          <div className="my-1 h-px bg-line" />
          <button className={item} onClick={() => { shot(); close(); }}><Camera className="size-4" />Picture of this chart</button>
          <a className={item} href={`/chart?symbol=${encodeURIComponent(symbol)}`} target="_blank" rel="noreferrer" onClick={close}><ExternalLink className="size-4" />Open in a new tab</a>
        </>)}</Menu>
        <span className="tb" title={feed.leader ? 'This tab holds the live feed for every chart tab' : 'Live prices come through the chart tab that holds the feed'}>
          <span className={`size-2 rounded-full ${feedDot}`} />{mobile ? '' : feedText}
        </span>
      </div>
      {!token && <p className="border-b border-line bg-data-caution/10 px-3 py-1.5 text-xs text-data-caution">Not logged in to Dhan: saved candles only, no live prices or orders. <a className="underline" href="/dhan-login">Dhan login</a></p>}
      {trade.msg && (
        <p className={`flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs ${trade.msg.bad ? 'bg-data-red/10 text-data-red-text' : 'bg-data-green/10 text-data-green'}`}>
          <span className="min-w-0 flex-1">{trade.msg.text}</span><button onClick={trade.clearMsg} className="text-ink-3 hover:text-white"><X className="size-3.5" /></button>
        </p>
      )}
      {/* phone: one chart at a time, tabs to switch */}
      {mobile && layout.panes.length > 1 && (
        <div className="cc-scroll flex flex-nowrap gap-1 overflow-x-auto border-b border-line bg-brand-bg px-2 py-1">
          {layout.panes.map((p) => (
            <button key={p.id} onClick={() => setActiveId(p.id)} className={`tb border ${p.id === active?.id ? 'border-brand-accent/60 tb-on' : 'border-line'}`}>{p.symbol === symbol ? '' : `${p.symbol} · `}{intervalLabel(p.interval)}</button>
          ))}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* drawing tools (a toggle on the phone) */}
        <div className={`${mobile ? (toolsOpen ? 'absolute inset-y-0 left-0 z-30 shadow-2xl' : 'hidden') : 'flex'} cc-scroll w-11 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-line bg-brand-section py-1.5 ${mobile && toolsOpen ? 'flex' : ''}`}>
          <button title="Cursor" onClick={() => setTool(null)} className={`rounded-md p-1.5 ${!tool ? 'text-brand-accent' : 'hover:bg-white/5 hover:text-white'}`}><ToolIcon name="cursor" /></button>
          {TOOL_GROUPS.map((g) => {
            const list = tools.filter((t) => t.group === g);
            const cur = list.find((t) => t.type === tool) ?? list[0];
            if (!cur) return null;
            return (
              <div key={g} className="relative" onMouseLeave={() => setToolGroup((x) => (x === g ? null : x))}>
                <button title={cur.label} onClick={() => { setTool(tool === cur.type ? null : cur.type); if (mobile) setToolsOpen(false); }} onContextMenu={(e) => { e.preventDefault(); setToolGroup(g); }}
                  className={`rounded-md p-1.5 ${list.some((t) => t.type === tool) ? 'bg-brand-accent/15 text-brand-accent' : 'hover:bg-white/5 hover:text-white'}`}>
                  <ToolIcon name={cur.type} />
                </button>
                {list.length > 1 && <button title={`More ${g.toLowerCase()}`} onClick={() => setToolGroup(toolGroup === g ? null : g)} className="absolute -right-0.5 bottom-0 px-0.5 text-[9px] leading-none text-ink-3 hover:text-white">▸</button>}
                {toolGroup === g && (
                  <div className="fixed z-[90] ml-11 -mt-8 w-44 rounded-lg border border-line-strong bg-brand-section p-1 shadow-2xl">
                    {list.map((t) => (
                      <button key={t.type} onClick={() => { setTool(t.type); setToolGroup(null); if (mobile) setToolsOpen(false); }} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-white/5 ${tool === t.type ? 'text-brand-accent' : ''}`}>
                        <ToolIcon name={t.type} className="size-4" />{t.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <span className="my-1 h-px w-6 bg-line" />
          <button title={`Magnet: ${layout.magnet}`} onClick={() => update((l) => ({ ...l, magnet: l.magnet === 'off' ? 'weak' : l.magnet === 'weak' ? 'strong' : 'off' }))}
            className={`rounded-md p-1.5 ${layout.magnet !== 'off' ? 'text-brand-accent' : 'hover:bg-white/5'}`}><ToolIcon name="magnet" /></button>
          {layout.magnet === 'strong' && <span className="-mt-1 text-[8px] text-brand-accent">strong</span>}
          <button title={hidden ? 'Show drawings' : 'Hide drawings'} onClick={() => setHidden((v) => !v)} className={`rounded-md p-1.5 ${hidden ? 'text-brand-accent' : 'hover:bg-white/5'}`}><ToolIcon name={hidden ? 'eyeOff' : 'eye'} /></button>
          <button title="Remove all drawings on this symbol" onClick={() => { if (activeChart && window.confirm(`Remove every drawing on ${symbol}?`)) activeChart.clearDrawings(); }} className="rounded-md p-1.5 hover:bg-white/5 hover:text-data-red-text"><ToolIcon name="trash" /></button>
        </div>

        {/* charts */}
        <div ref={grid} className="relative flex min-w-0 flex-1">
          {mobile && active ? (
            <div className="h-full w-full">{pane(active)}</div>
          ) : showMax ? (
            <div className="h-full w-full">{pane(layout.panes.find((p) => p.id === maxId)!)}</div>
          ) : layout.cols.map((col, ci) => (
            <div key={ci} className="relative flex h-full min-w-0 flex-col" style={{ width: `${col.w * 100}%` }}>
              {col.rows.map((row, ri) => {
                const cfg = layout.panes.find((p) => p.id === row.pane);
                return (
                  <div key={row.pane} className="relative min-h-0" style={{ height: `${row.h * 100}%` }}>
                    {cfg && pane(cfg)}
                    {ri < col.rows.length - 1 && <div onPointerDown={dragRow(ci, ri)} className="absolute -bottom-[3px] left-0 right-0 z-20 h-[6px] cursor-row-resize hover:bg-brand-accent/40" />}
                    {ri < col.rows.length - 1 && <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-px bg-line-strong" />}
                  </div>
                );
              })}
              {ci < layout.cols.length - 1 && <>
                <div className="pointer-events-none absolute bottom-0 right-0 top-0 w-px bg-line-strong" />
                <div onPointerDown={dragCol(ci)} className="absolute -right-[3px] bottom-0 top-0 z-20 w-[6px] cursor-col-resize hover:bg-brand-accent/40" />
              </>}
            </div>
          ))}
        </div>

        {/* Algo Live: a side panel on the laptop, a sheet from the bottom on the phone */}
        {layout.showAlgo && algoRelevant && algo && (!mobile || sheet) && (
          <AlgoPanel view={algo} slot={algoSlot} onSlot={pickSlot} parts={layout.algoParts ?? ALGO_PARTS_DEFAULT} onParts={(algoParts) => update((l) => ({ ...l, algoParts }))} onClose={() => { if (mobile) setSheet(false); else update((l) => ({ ...l, showAlgo: false })); }} mobile={mobile} />
        )}
      </div>
      {algoErr && layout.showAlgo && <p className="border-t border-line px-3 py-1 text-[11px] text-data-red-text">Algo Live view: {algoErr}</p>}

      {search && <SymbolSearch initial={search.initial} onPick={setSymbol} onClose={() => setSearch(null)} />}
      {picker && <IndicatorPicker onPick={(id) => { activeChart?.addIndicator(id); }} onClose={() => setPicker(false)} />}
    </div>
  );
}
