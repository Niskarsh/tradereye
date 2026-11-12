'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ChevronDown, ExternalLink, Maximize2, Minimize2, Search, X } from 'lucide-react';
import { intervalLabel, listIndicators, listTools, MONO_CANDLES, type Chart, type ChartType } from '@/packages/candle-chart/src';
import { useAuth } from '@/context/AuthContext';
import { sharedFeed, type FeedStatus } from '@/lib/chart/feed';
import { seriesFor } from '@/lib/chart/series';
import type { AlgoView } from '@/lib/chart/algo';
import { ChartPane } from './ChartPane';
import { AlgoPanel } from './AlgoPanel';
import { ToolIcon } from './icons';
import { ALGO_PARTS_DEFAULT, colsFor, defaultLayout, loadLayout, paneId, PRESETS, saveLayout, type Layout, type PaneCfg } from './stores';

const INTERVALS = ['1', '3', '5', '10', '15', '30', '60', '120', '240', 'D', 'W', 'M'];
const QUICK = ['1', '5', '10', '15', '60', 'D', 'W'];
const TYPES: { id: ChartType; label: string }[] = [
  { id: 'candles', label: 'Candles' }, { id: 'hollow', label: 'Hollow candles' }, { id: 'heikin', label: 'Heikin Ashi' },
  { id: 'bars', label: 'Bars' }, { id: 'line', label: 'Line' }, { id: 'area', label: 'Area' },
];
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

function Menu({ label, title, children, wide }: { label: React.ReactNode; title: string; children: (close: () => void) => React.ReactNode; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useOutside(open, close);
  return (
    <div ref={ref} className="relative">
      <button title={title} onClick={() => setOpen((o) => !o)} className={`tb ${open ? 'bg-white/10 text-white' : ''}`}>{label}<ChevronDown className="size-3 opacity-60" /></button>
      {open && <div className={`absolute left-0 top-full z-50 mt-1 ${wide ? 'w-72' : 'w-48'} rounded-lg border border-line-strong bg-brand-section p-1 shadow-2xl`}>{children(close)}</div>}
    </div>
  );
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
  const toggleExpanded = () => setExpanded((e) => { try { localStorage.setItem('tradereye-chart-expanded', e ? '0' : '1'); } catch { /* private mode */ } return !e; });
  const [, force] = useState(0);
  const date = algoDate ?? istDate();

  useEffect(() => { sharedFeed.setToken(token, clientId); }, [token, clientId]);
  useEffect(() => { const off = sharedFeed.onStatus(setFeed); return () => { off(); }; }, []);

  // the layout: this browser's copy first, then S3's; ?symbol= wins
  useEffect(() => {
    let done = false;
    const apply = (l: Layout) => {
      const lay: Layout = JSON.parse(JSON.stringify(l));
      // charts saved before candle colours existed get the white / black candles
      lay.panes = lay.panes.map((p) => (p.state?.candles ? p : { ...p, state: { ...p.state, candles: { ...MONO_CANDLES } } }));
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
      const r = await fetch(`/api/chart/algo?symbol=${encodeURIComponent(symbol)}&date=${date}${slot != null ? `&slot=${slot}` : ''}`, { cache: 'no-store' });
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
      compareNifty={layout.compareNifty} magnet={layout.magnet} tool={tool} drawingsHidden={hidden}
      algo={algoRelevant ? algo : null} showAlgo={layout.showAlgo} algoSlot={algoSlot} algoParts={layout.algoParts ?? ALGO_PARTS_DEFAULT}
      maximized={maxId === cfg.id}
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
  const feedDot = feed.state === 'live' ? 'bg-data-green' : feed.state === 'connecting' ? 'bg-data-caution animate-pulse' : feed.state === 'error' ? 'bg-data-red' : 'bg-ink-4';
  const feedText = feed.state === 'live' ? 'Live' : feed.message ?? (feed.state === 'connecting' ? 'Connecting' : 'Not live');

  return (
    <div ref={shell} style={{ height: expanded ? '100dvh' : h }} className={`flex flex-col bg-brand-bg text-ink-2 ${expanded ? 'fixed inset-0 z-[70]' : ''}`}>
      <style>{`.tb{display:inline-flex;align-items:center;gap:4px;border-radius:6px;padding:5px 8px;font-size:12.5px;color:var(--ink-2);white-space:nowrap}.tb:hover{background:rgba(232,234,240,.06);color:#fff}.tb-on{color:var(--candlelight-gold)!important;background:rgba(223,177,91,.1)}.tb-sep{width:1px;align-self:stretch;margin:4px 4px;background:var(--line)}`}</style>
      {/* top bar */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line bg-brand-section px-2 py-1">
        <button className="tb font-semibold text-white" onClick={() => setSearch({ initial: '' })} title="Symbol search (or just start typing)"><Search className="size-3.5" />{symbol || 'Symbol'}</button>
        <span className="tb-sep" />
        {QUICK.map((iv) => (
          <button key={iv} onClick={() => active && setPane(active.id, { interval: iv })} className={`tb ${active?.interval === iv ? 'tb-on' : ''}`}>{intervalLabel(iv)}</button>
        ))}
        <Menu label="" title="More intervals">{(close) => INTERVALS.map((iv) => (
          <button key={iv} onClick={() => { if (active) setPane(active.id, { interval: iv }); close(); }} className={`block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-white/5 ${active?.interval === iv ? 'text-brand-accent' : ''}`}>{intervalLabel(iv)}</button>
        ))}</Menu>
        <span className="tb-sep" />
        <Menu label={TYPES.find((t) => t.id === (activeChart?.getType() ?? 'candles'))?.label ?? 'Candles'} title="Chart type">{(close) => TYPES.map((t) => (
          <button key={t.id} onClick={() => { activeChart?.setType(t.id); close(); force((x) => x + 1); }} className="block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-white/5">{t.label}</button>
        ))}</Menu>
        <button className="tb" onClick={() => setPicker(true)} title="Indicators">ƒx Indicators</button>
        <button className={`tb ${layout.compareNifty ? 'tb-on' : ''}`} onClick={() => update((l) => ({ ...l, compareNifty: !l.compareNifty }))} title="Compare with Nifty 500 (price scale switches to %)">+ Nifty 500</button>
        <Menu label="Scale" title="Price scale">{(close) => (['linear', 'log', 'percent'] as const).map((m) => (
          <button key={m} onClick={() => { activeChart?.setScaleMode(m); close(); }} className="block w-full rounded px-3 py-1.5 text-left text-sm capitalize hover:bg-white/5">{m === 'linear' ? 'Regular' : m === 'log' ? 'Logarithmic' : 'Percent'}</button>
        ))}</Menu>
        <button className={`tb ${activeChart?.hasVolume() ? 'tb-on' : ''}`} onClick={() => { activeChart?.setVolumeVisible(!activeChart.hasVolume()); force((x) => x + 1); }} title="Volume on the price pane (hover its legend line to hide, set up or remove it)">Vol</button>
        <button className="tb" title="Chart settings: candle colours, borders, wicks, grid" onClick={() => activeChart?.openSettings({
          allOption: layout.panes.length > 1,
          onApply: (st, all) => { if (all) for (const [id, c] of charts.current) if (id !== active?.id && st.candles) { c.setState({ candles: st.candles, grid: st.grid, sessionBreaks: st.sessionBreaks }); setPane(id, { state: c.getState() }); } },
        })}>⚙ Settings</button>
        <span className="tb-sep" />
        <button className={`tb ${layout.showAlgo ? 'tb-on' : ''}`} onClick={() => update((l) => ({ ...l, showAlgo: !l.showAlgo }))}
          title={algoRelevant ? 'Show / hide what Algo Live saw (dots, levels, order, reasons)' : `${symbol} is not on Algo Live's list on ${date}`}>
          Algo {algoRelevant ? (layout.showAlgo ? 'on' : 'off') : '—'}
        </button>
        <span className="ml-auto" />
        <Menu label="Layout" title="Layout and sync" wide>{(close) => (
          <div className="p-1">
            <div className="grid grid-cols-2 gap-1">
              {PRESETS.map((p) => (
                <button key={p.id} onClick={() => { setPreset(p.id); close(); }} className={`rounded px-2 py-1.5 text-left text-xs hover:bg-white/5 ${layout.preset === p.id ? 'text-brand-accent' : ''}`}>{p.label}</button>
              ))}
            </div>
            <div className="mt-2 border-t border-line pt-2 text-xs">
              <label className="flex items-center gap-2 px-2 py-1"><input type="checkbox" checked={layout.syncSymbol} onChange={(e) => update((l) => ({ ...l, syncSymbol: e.target.checked }))} />Same symbol on every chart</label>
              <label className="flex items-center gap-2 px-2 py-1"><input type="checkbox" checked={layout.syncCrosshair} onChange={(e) => update((l) => ({ ...l, syncCrosshair: e.target.checked }))} />Crosshair follows across charts</label>
              <button className="mt-1 w-full rounded px-2 py-1.5 text-left text-ink-3 hover:bg-white/5 hover:text-white" onClick={() => { const d = defaultLayout(symbol || 'NIFTY500'); setLayout(d); saveLayout(d); setActiveId(d.panes[2].id); close(); }}>Reset to default (5m · 1D · 10m)</button>
            </div>
          </div>
        )}</Menu>
        <button className="tb" onClick={() => activeChart?.undo()} title="Undo drawing (Ctrl+Z)"><ToolIcon name="undo" className="size-4" /></button>
        <button className="tb" onClick={() => activeChart?.redo()} title="Redo (Ctrl+Shift+Z)"><ToolIcon name="redo" className="size-4" /></button>
        <button className="tb" onClick={shot} title="Download a picture of the active chart"><Camera className="size-4" /></button>
        <a className="tb" href={`/chart?symbol=${encodeURIComponent(symbol)}`} target="_blank" rel="noreferrer" title="Open in a new tab"><ExternalLink className="size-4" /></a>
        <button className={`tb ${expanded ? 'tb-on' : ''}`} onClick={toggleExpanded} title={expanded ? 'Back to the page (show the top menu)' : 'Expand the charts over the whole window'}>
          {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>
        <span className="tb" title={feed.leader ? 'This tab holds the live feed for every chart tab' : 'Live prices come through the chart tab that holds the feed'}>
          <span className={`size-2 rounded-full ${feedDot}`} />{feedText}
        </span>
      </div>
      {!token && <p className="border-b border-line bg-data-caution/10 px-3 py-1.5 text-xs text-data-caution">Not logged in to Dhan: saved candles only, no live prices. <a className="underline" href="/dhan-login">Dhan login</a></p>}

      <div className="flex min-h-0 flex-1">
        {/* drawing tools */}
        <div className="flex w-11 shrink-0 flex-col items-center gap-0.5 border-r border-line bg-brand-section py-1.5">
          <button title="Cursor" onClick={() => setTool(null)} className={`rounded-md p-1.5 ${!tool ? 'text-brand-accent' : 'hover:bg-white/5 hover:text-white'}`}><ToolIcon name="cursor" /></button>
          {TOOL_GROUPS.map((g) => {
            const list = tools.filter((t) => t.group === g);
            const cur = list.find((t) => t.type === tool) ?? list[0];
            if (!cur) return null;
            return (
              <div key={g} className="relative" onMouseLeave={() => setToolGroup((x) => (x === g ? null : x))}>
                <button title={cur.label} onClick={() => setTool(tool === cur.type ? null : cur.type)} onContextMenu={(e) => { e.preventDefault(); setToolGroup(g); }}
                  className={`rounded-md p-1.5 ${list.some((t) => t.type === tool) ? 'bg-brand-accent/15 text-brand-accent' : 'hover:bg-white/5 hover:text-white'}`}>
                  <ToolIcon name={cur.type} />
                </button>
                {list.length > 1 && <button title={`More ${g.toLowerCase()}`} onClick={() => setToolGroup(toolGroup === g ? null : g)} className="absolute -right-0.5 bottom-0 text-[8px] leading-none text-ink-3 hover:text-white">▸</button>}
                {toolGroup === g && (
                  <div className="absolute left-full top-0 z-50 ml-1 w-44 rounded-lg border border-line-strong bg-brand-section p-1 shadow-2xl">
                    {list.map((t) => (
                      <button key={t.type} onClick={() => { setTool(t.type); setToolGroup(null); }} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-white/5 ${tool === t.type ? 'text-brand-accent' : ''}`}>
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
          {maxId && layout.panes.some((p) => p.id === maxId) ? (
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

        {/* Algo Live */}
        {layout.showAlgo && algoRelevant && algo && (
          <AlgoPanel view={algo} slot={algoSlot} onSlot={pickSlot} parts={layout.algoParts ?? ALGO_PARTS_DEFAULT} onParts={(algoParts) => update((l) => ({ ...l, algoParts }))} onClose={() => update((l) => ({ ...l, showAlgo: false }))} />
        )}
      </div>
      {algoErr && layout.showAlgo && <p className="border-t border-line px-3 py-1 text-[11px] text-data-red-text">Algo Live view: {algoErr}</p>}

      {search && <SymbolSearch initial={search.initial} onPick={setSymbol} onClose={() => setSearch(null)} />}
      {picker && <IndicatorPicker onPick={(id) => { activeChart?.addIndicator(id); }} onClose={() => setPicker(false)} />}
    </div>
  );
}
