"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Loader2, Play, Plus, Sparkles, Square, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { TokenBar } from '@/components/auth/TokenBar';
import { BookChart } from '@/components/book/BookChart';
import { Recorder, loadDay, type RecInfo } from '@/lib/book/recorder';
import { BookModel } from '@/lib/book/model';
import { istDate } from '@/lib/book/record';
import type { WatchItem } from '@/lib/book/sheet';

/**
 * Order Book tab: curate the list (type / paste symbols, or paste screener screenshots read by Gemini), press
 * Start recording, and keep this tab open. Every stock on the list is recorded to S3 whether or not its chart is
 * open. Charts are views: open as many as you like, stacked; each can show today (live) or a past recorded day.
 */

interface ChartCfg { id: string; symbol: string; date: string } // date '' = today
const CHARTS_KEY = 'tradereye-orderbook-charts';
const CHANNEL = 'tradereye-orderbook';
const loadCharts = (): ChartCfg[] => { try { const v = JSON.parse(localStorage.getItem(CHARTS_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

/** Screenshots are shrunk before upload (Gemini only needs to read tickers). */
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}

export default function OrderBookPage() {
  const { token, clientId } = useAuth();
  const tokenRef = useRef(token); tokenRef.current = token;
  const api = useCallback((path: string, init: RequestInit = {}) => fetch(path, { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), 'x-dhan-token': tokenRef.current } }), []);
  const rec = useRef<Recorder | null>(null);
  if (!rec.current) rec.current = new Recorder(api);
  const [info, setInfo] = useState<RecInfo>(rec.current.info);
  const [list, setList] = useState<WatchItem[]>([]);
  const [listMsg, setListMsg] = useState('');
  const [draft, setDraft] = useState('');
  const [ocr, setOcr] = useState<{ busy: boolean; found?: string[]; rejected?: string[]; err?: string }>({ busy: false });
  const [charts, setCharts] = useState<ChartCfg[]>([]);

  useEffect(() => { rec.current!.onChange = () => setInfo({ ...rec.current!.info }); }, []);
  useEffect(() => { setCharts(loadCharts()); }, []);
  useEffect(() => { try { localStorage.setItem(CHARTS_KEY, JSON.stringify(charts)); } catch { /* ignore */ } }, [charts]);

  // the saved list (same on every device)
  useEffect(() => {
    if (!token) return;
    api('/api/book/watchlist').then((r) => r.json()).then((j) => { if (Array.isArray(j.list)) { setList(j.list); rec.current!.list = rec.current!.info.status === 'recording' ? rec.current!.list : j.list; } }).catch(() => {});
  }, [token, api]);

  const saveList = useCallback(async (symbols: string[]) => {
    const r = await api('/api/book/watchlist', { method: 'POST', body: JSON.stringify({ symbols }), headers: { 'Content-Type': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setListMsg(j.message ?? 'Could not save the list.'); return; }
    setList(j.list);
    setListMsg(j.unknown?.length ? `Not NSE equity symbols, skipped: ${j.unknown.join(', ')}` : j.dropped ? `Only the first 50 are recorded (${j.dropped} left out).` : '');
    const r0 = rec.current!;
    if (r0.info.status === 'recording') {
      const now = new Set((j.list as WatchItem[]).map((w) => w.securityId));
      for (const w of r0.list) if (!now.has(w.securityId)) await r0.remove(w.securityId);
      await r0.add(j.list);
    } else r0.list = j.list;
  }, [api]);

  const addSymbols = (syms: string[]) => saveList([...list.map((w) => w.symbol), ...syms.map((s) => s.trim().toUpperCase()).filter(Boolean)]);
  const removeSymbol = (sym: string) => saveList(list.filter((w) => w.symbol !== sym).map((w) => w.symbol));

  // screener screenshots -> symbols (Gemini)
  const readShots = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/')).slice(0, 8);
    if (!imgs.length) return;
    setOcr({ busy: true });
    try {
      const images = await Promise.all(imgs.map(shrink));
      const r = await api('/api/book/ocr', { method: 'POST', body: JSON.stringify({ images }), headers: { 'Content-Type': 'application/json' } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setOcr({ busy: false, found: j.symbols.filter((s: string) => !list.some((w) => w.symbol === s)), rejected: j.rejected });
    } catch (e) { setOcr({ busy: false, err: (e as Error).message }); }
  };
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.some((f) => f.type.startsWith('image/'))) { e.preventDefault(); void readShots(files); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => { if (token && clientId) void rec.current!.start(list, token, clientId); };
  const stop = () => { void rec.current!.stop(); };
  useEffect(() => () => { void rec.current?.stop(); }, []);

  // stocks not on screen keep only 15 minutes in memory; summaries go to the co-pilot tab
  const viewed = useMemo(() => new Set(charts.filter((c) => !c.date).map((c) => list.find((w) => w.symbol === c.symbol)?.securityId).filter(Boolean) as string[]), [charts, list]);
  useEffect(() => {
    let ch: BroadcastChannel | null = null;
    try { ch = new BroadcastChannel(CHANNEL); } catch { /* old browser */ }
    const id = setInterval(() => {
      const r0 = rec.current!;
      if (r0.info.status !== 'recording') return;
      r0.trimHidden(viewed);
      const now = Date.now();
      ch?.postMessage({ at: now, items: r0.list.map((w) => ({ securityId: w.securityId, symbol: w.symbol, summary: r0.models.get(w.securityId)?.summary(now) ?? '' })).filter((x) => x.summary) });
    }, 5_000);
    return () => { clearInterval(id); ch?.close(); };
  }, [viewed]);

  const addChart = (symbol = list[0]?.symbol ?? '') => setCharts((c) => [...c, { id: Math.random().toString(36).slice(2), symbol, date: '' }]);
  const recording = info.status === 'recording';

  return (
    <div className="min-h-screen bg-brand-bg text-ink font-sans pb-24">
      <div className="page-shell pt-6 space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
          <div>
            <h1 className="text-2xl font-black tracking-tighter">Order Book</h1>
            <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-ink-3">Record your list · keep this tab open · charts are just views</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-ink-3">
              {info.status === 'recording' ? `Recording ${info.stocks} stocks${info.lastSave ? ` · saved ${new Date(info.lastSave).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}` : ''}${info.pending ? ` · ${info.pending} waiting to save` : ''}`
                : info.status === 'loading' ? 'Loading today from S3…'
                : info.status === 'other-tab' ? 'Already recording in another tab' : 'Not recording'}
            </span>
            {recording
              ? <button onClick={stop} className="flex h-10 items-center gap-2 rounded-xl bg-data-red px-4 text-sm font-black text-ink"><Square className="h-3.5 w-3.5" />Stop recording</button>
              : <button onClick={start} disabled={!token || !clientId || !list.length || info.status === 'loading'} className="flex h-10 items-center gap-2 rounded-xl bg-brand-accent px-4 text-sm font-black text-brand-bg disabled:opacity-40">
                  {info.status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-3.5 w-3.5" />}Start recording
                </button>}
          </div>
        </header>
        {!token && <TokenBar />}
        {info.error && <p className="rounded-xl border border-data-caution/50 bg-data-caution/10 px-3 py-2 text-xs text-data-caution">{info.error}</p>}

        {/* the list */}
        <section className="rounded-2xl bg-brand-card p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-ink-3">Recording list ({list.length}/50)</span>
            {list.map((w) => (
              <span key={w.securityId} className="flex h-8 items-center gap-1 rounded-lg border border-line-strong pl-3 pr-1 text-xs font-bold">
                <button onClick={() => addChart(w.symbol)} title="Open a chart">{w.symbol}</button>
                <button onClick={() => removeSymbol(w.symbol)} aria-label={`Remove ${w.symbol}`} className="rounded p-1 text-ink-3 hover:text-ink"><X className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); const s = draft.split(/[\s,;]+/).filter(Boolean); if (s.length) { void addSymbols(s); setDraft(''); } }}>
            <input value={draft} onChange={(e) => setDraft(e.target.value.toUpperCase())} placeholder="Add symbols: TARIL, HINDPETRO, LTF"
              className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-brand-bg px-3 text-sm font-bold outline-none focus:border-brand-accent" />
            <button type="submit" className="h-10 rounded-xl bg-ink px-4 text-sm font-black text-brand-bg">Add</button>
            <label className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-line-strong px-3 text-xs font-bold text-ink-2">
              {ocr.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}Screener screenshots
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { void readShots([...(e.target.files ?? [])]); e.target.value = ''; }} />
            </label>
          </form>
          <p className="text-[11px] text-ink-3">Tip: copy a screenshot and press Ctrl+V anywhere on this page. Screenshots are read by Gemini (free), not Claude.</p>
          {ocr.err && <p className="text-xs text-data-red-text">{ocr.err}</p>}
          {ocr.found && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-accent/40 bg-brand-accent/5 p-3 text-xs">
              <span className="font-bold text-ink-2">Found {ocr.found.length} new:</span>
              <span className="font-mono">{ocr.found.join(', ') || '—'}</span>
              {ocr.rejected?.length ? <span className="text-ink-3">(not NSE symbols, ignored: {ocr.rejected.join(', ')})</span> : null}
              {ocr.found.length > 0 && <button onClick={() => { void addSymbols(ocr.found!); setOcr({ busy: false }); }} className="ml-auto h-8 rounded-lg bg-brand-accent px-3 font-black text-brand-bg">Add these</button>}
              <button onClick={() => setOcr({ busy: false })} className="h-8 rounded-lg border border-line-strong px-3 text-ink-2">Dismiss</button>
            </div>
          )}
          {listMsg && <p className="text-xs text-data-caution">{listMsg}</p>}
        </section>

        {/* charts */}
        {charts.map((c) => (
          <ChartCard key={c.id} cfg={c} list={list} rec={rec.current!} recording={recording} api={api}
            onChange={(n) => setCharts((all) => all.map((x) => (x.id === c.id ? n : x)))}
            onClose={() => setCharts((all) => all.filter((x) => x.id !== c.id))}
            onAddToList={(s) => addSymbols([s])} />
        ))}
        <button onClick={() => addChart()} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong text-sm font-bold text-ink-2">
          <Plus className="h-4 w-4" />Add chart
        </button>
      </div>
    </div>
  );
}

function ChartCard({ cfg, list, rec, recording, api, onChange, onClose, onAddToList }: {
  cfg: ChartCfg; list: WatchItem[]; rec: Recorder; recording: boolean;
  api: (path: string, init?: RequestInit) => Promise<Response>;
  onChange: (c: ChartCfg) => void; onClose: () => void; onAddToList: (symbol: string) => void;
}) {
  const w = list.find((x) => x.symbol === cfg.symbol);
  const [model, setModel] = useState<BookModel | null>(null);
  const [loading, setLoading] = useState('');
  const [answer, setAnswer] = useState<{ q: string; text?: string; busy: boolean; err?: string; cost?: number } | null>(null);
  const today = istDate(Date.now());
  const isLive = !cfg.date || cfg.date === today;

  useEffect(() => {
    let cancelled = false;
    setModel(null); setAnswer(null);
    if (!w) return;
    (async () => {
      if (isLive && recording) { setLoading('Loading today…'); const m = await rec.fullModel(w); if (!cancelled) { setModel(m); setLoading(''); } return; }
      setLoading('Loading from S3…');
      const m = await loadDay(api, w, cfg.date || today, (d, t) => { if (!cancelled) setLoading(`Loading from S3… ${d}/${t}`); });
      if (!cancelled) { setModel(m); setLoading(''); }
    })().catch((e) => { if (!cancelled) setLoading(`Could not load: ${(e as Error).message}`); });
    return () => { cancelled = true; };
  }, [w?.securityId, cfg.date, recording]); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = async (q: string) => {
    if (!w) return;
    setAnswer({ q, busy: true });
    try {
      const r = await api('/api/book/ask', { method: 'POST', body: JSON.stringify({ symbol: w.symbol, question: q, book: model?.summary(model.lastEventAt || Date.now()) }), headers: { 'Content-Type': 'application/json' } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setAnswer({ q, text: j.text, busy: false, cost: j.costInr });
    } catch (e) { setAnswer({ q, busy: false, err: (e as Error).message }); }
  };

  return (
    <section className="rounded-2xl border border-line bg-brand-card p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input list="ob-symbols" value={cfg.symbol} onChange={(e) => onChange({ ...cfg, symbol: e.target.value.toUpperCase() })}
          className="h-8 w-36 rounded-lg border border-line bg-brand-bg px-2 text-sm font-black outline-none focus:border-brand-accent" />
        <datalist id="ob-symbols">{list.map((x) => <option key={x.securityId} value={x.symbol} />)}</datalist>
        <input type="date" value={cfg.date || today} max={today} onChange={(e) => onChange({ ...cfg, date: e.target.value === today ? '' : e.target.value })}
          className="h-8 rounded-lg border border-line bg-brand-bg px-2 text-xs text-ink-2 outline-none" />
        <span className="text-[11px] text-ink-3">{!w ? '' : isLive ? (recording ? 'live' : 'saved today (not recording)') : 'recorded day'}{loading ? ` · ${loading}` : ''}</span>
        {!w && cfg.symbol && <button onClick={() => onAddToList(cfg.symbol)} className="h-8 rounded-lg bg-brand-accent px-3 text-xs font-black text-brand-bg">Add {cfg.symbol} to the list</button>}
        <button onClick={onClose} aria-label="Close chart" className="ml-auto rounded-lg border border-line p-1.5 text-ink-3 hover:text-ink"><X className="h-4 w-4" /></button>
      </div>
      {w && model && <BookChart model={model} live={isLive && recording} height={560} onAsk={ask} />}
      {answer && (
        <div className="rounded-xl border border-line bg-brand-bg p-3 text-sm space-y-1">
          <p className="text-[11px] text-ink-3"><Sparkles className="mr-1 inline h-3 w-3 text-brand-accent" />{answer.q}</p>
          {answer.busy ? <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin" />Claude is reading…</p>
            : answer.err ? <p className="text-xs text-data-red-text">{answer.err}</p>
            : <p className="leading-relaxed">{answer.text} <span className="text-[10px] text-ink-3">₹{answer.cost?.toFixed(2)}</span></p>}
        </div>
      )}
    </section>
  );
}
