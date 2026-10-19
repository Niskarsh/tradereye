"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellRing, ChevronLeft, ChevronRight, ImagePlus, Loader2, Maximize2, Minimize2, Play, Plus, Sparkles, Square, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { TokenBar } from '@/components/auth/TokenBar';
import { BookChart, type AlertMark } from '@/components/book/BookChart';
import { useFullscreen } from '@/components/book/useFullscreen';
import { LoadingPanel, ProgressBar } from '@/components/ui/progress';
import { Recorder, loadDay, type RecInfo } from '@/lib/book/recorder';
import { BookModel } from '@/lib/book/model';
import { istDate } from '@/lib/book/record';
import type { WatchItem } from '@/lib/book/sheet';
import type { ReversalAlert } from '@/lib/book/reversal';

/**
 * Order Book tab: curate the list (type / paste symbols, or paste screener screenshots read by Gemini), press
 * Start recording, and keep this tab open. Every stock on the list is recorded to S3 whether or not its chart is
 * open. Charts are views: open as many as you like, stacked; each can show today (live) or a past recorded day.
 *
 * Reversal alerts: every recorded stock is checked as its data arrives (lib/book/reversal.ts, plain code, free).
 * An alert stays on screen (and as a desktop notification) until he closes it; clicking it opens that stock's chart
 * below the others (or reuses its open chart), zoomed to the moment the alert fired, with the wall marked.
 */

interface ChartCfg { id: string; symbol: string; date: string; focus?: { from: number; to: number; n?: number }; alert?: AlertMark } // date '' = today
const CHARTS_KEY = 'tradereye-orderbook-charts';
const CHANNEL = 'tradereye-orderbook';
const loadCharts = (): ChartCfg[] => { try { const v = JSON.parse(localStorage.getItem(CHARTS_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const ALERTS_KEY = 'tradereye-reversal-alerts';
type Alert = ReversalAlert & { opened?: boolean };
const loadAlerts = (): Alert[] => {
  try { const v = JSON.parse(localStorage.getItem(ALERTS_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((a) => istDate(a.at) === istDate(Date.now())) : []; } catch { return []; }
};
const clock = (t: number) => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

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
  const [listBusy, setListBusy] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [notifyPerm, setNotifyPerm] = useState<NotificationPermission | 'unsupported'>('default');
  const notes = useRef(new Map<string, Notification>());
  const openRef = useRef<(a: ReversalAlert) => void>(() => {});

  useEffect(() => { rec.current!.onChange = () => setInfo({ ...rec.current!.info }); }, []);

  // reversal alerts: kept (also across a refresh, for today) until he closes them
  useEffect(() => { setAlerts(loadAlerts()); setNotifyPerm(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission); }, []);
  useEffect(() => { try { localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts)); } catch { /* ignore */ } }, [alerts]);
  useEffect(() => {
    rec.current!.onAlert = (a) => {
      setAlerts((all) => [a, ...all].slice(0, 30));
      // desktop notification too (he may be on another tab): stays until he closes or clicks it
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          const n = new Notification(`${a.symbol}: reversal ${a.side === 'LONG' ? 'long' : 'short'} at ${a.wallPrice.toFixed(2)}`, { body: a.why, tag: a.id, requireInteraction: true });
          n.onclick = () => { window.focus(); openRef.current(a); n.close(); };
          notes.current.set(a.id, n);
        } catch { /* some browsers only allow notifications from a service worker */ }
      }
    };
    return () => { if (rec.current) rec.current.onAlert = undefined; };
  }, []);
  // "Should I take this?": one Claude call per click (never automatic), with the alert and the live book
  const [asks, setAsks] = useState<Record<string, AskState>>({});
  const askAlert = async (a: ReversalAlert) => {
    setAsks((x) => ({ ...x, [a.id]: { busy: true } }));
    const m = rec.current!.models.get(a.securityId);
    const p = a.plan;
    const alertText = [
      `ALERT ${clock(a.at)} IST: ${a.kind === 'EXTREME' ? `reversal at the day's ${a.side === 'SHORT' ? 'high' : 'low'}` : 'wall reversal'}, ${a.side}. ${a.why}`,
      a.zone ? `Zone ${a.zone[0]}–${a.zone[1]}.` : '',
      p ? `App's plan: ${a.side === 'SHORT' ? 'sell' : 'buy'} ${p.qty} @ ${p.entry}, stop ${p.stop}${p.capped ? ' (capped at 2x ATR)' : ''}, target today's POC ${p.target} (${p.rr}R).` : '',
    ].filter(Boolean).join('\n');
    try {
      const r = await api('/api/book/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        symbol: a.symbol, direction: a.side, setup: 'REVERSAL',
        question: 'Should I take this reversal now? Take / wait / skip, 2-3 short reasons, and the one thing that would prove it wrong.',
        book: `${alertText}\n${m?.summary(m.lastEventAt || Date.now()) ?? ''}`,
      }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setAsks((x) => ({ ...x, [a.id]: { busy: false, text: j.text, cost: j.costInr } }));
    } catch (e) { setAsks((x) => ({ ...x, [a.id]: { busy: false, err: (e as Error).message } })); }
  };
  const dismiss = (id: string) => { notes.current.get(id)?.close(); notes.current.delete(id); setAlerts((all) => all.filter((a) => a.id !== id)); };
  const dismissAll = () => { for (const n of notes.current.values()) n.close(); notes.current.clear(); setAlerts([]); };
  const askNotify = async () => { if (typeof Notification === 'undefined') return; setNotifyPerm(await Notification.requestPermission()); };
  useEffect(() => { setCharts(loadCharts()); }, []);
  useEffect(() => { try { localStorage.setItem(CHARTS_KEY, JSON.stringify(charts)); } catch { /* ignore */ } }, [charts]);

  // the saved list (same on every device)
  useEffect(() => {
    if (!token) return;
    api('/api/book/watchlist').then((r) => r.json()).then((j) => { if (Array.isArray(j.list)) { setList(j.list); rec.current!.list = rec.current!.info.status === 'recording' ? rec.current!.list : j.list; } }).catch(() => {});
  }, [token, api]);

  const saveList = useCallback(async (symbols: string[]) => {
    setListBusy(true);
    try {
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
    } finally { setListBusy(false); }
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

  // "Record live" on a chart: add the stock to the list and make sure recording is running
  const recordLive = async (sym: string) => {
    await saveList([...list.map((w) => w.symbol), sym]);
    const r0 = rec.current!;
    if (r0.info.status !== 'recording' && token && clientId) await r0.start(r0.list, token, clientId);
  };
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

  // clicking an alert: that stock's live chart (reused if open, else added below the others), zoomed to the alert
  const [scrollTo, setScrollTo] = useState<{ id: string; n: number } | null>(null);
  const openAlert = (a: ReversalAlert) => {
    const focus = { from: a.at - 4 * 60_000, to: a.at, n: Date.now() };
    const alert: AlertMark = { t: a.at, price: a.wallPrice, side: a.side };
    const open = charts.find((c) => c.symbol === a.symbol && !c.date);
    const id = open?.id ?? Math.random().toString(36).slice(2);
    setCharts((all) => (open ? all.map((c) => (c.id === id ? { ...c, focus, alert } : c)) : [...all, { id, symbol: a.symbol, date: '', focus, alert }]));
    setAlerts((all) => all.map((x) => (x.id === a.id ? { ...x, opened: true } : x)));
    setScrollTo({ id, n: focus.n });
  };
  openRef.current = openAlert;
  useEffect(() => {
    if (!scrollTo) return;
    const t = setTimeout(() => document.getElementById(`chart-${scrollTo.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    return () => clearTimeout(t);
  }, [scrollTo]);
  const recording = info.status === 'recording';

  // full screen: jump straight to another open chart (no reloading: the chart is already there, only the
  // full-screen element changes). Exit first, then enter on the other card, so Esc / the exit button fully leave.
  const switchFull = (id: string) => {
    const el = document.getElementById(`chart-${id}`);
    if (!el?.requestFullscreen) return;
    const enter = () => { void el.requestFullscreen().catch(() => el.scrollIntoView({ block: 'start' })); };
    if (document.fullscreenElement) void document.exitFullscreen().then(enter, enter); else enter();
  };

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
                : info.status === 'loading' ? 'Starting: loading today from S3…'
                : info.status === 'stopping' ? 'Stopping: saving the last minutes…'
                : info.status === 'other-tab' ? 'Already recording in another tab' : 'Not recording'}
            </span>
            {recording && (
              <button onClick={() => {
                const snap = rec.current!.feedLog();
                const url = URL.createObjectURL(new Blob([JSON.stringify(snap, null, 1)], { type: 'application/json' }));
                const a = document.createElement('a'); a.href = url; a.download = `feed-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`; a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }} title="Everything Dhan sent this session: packet counts per stock, connects / disconnects, raw messages. Also saved to S3."
                className="h-10 rounded-xl border border-line-strong px-3 text-xs font-bold text-ink-2 hover:border-brand-accent">Feed log</button>
            )}
            {recording || info.status === 'stopping'
              ? <button onClick={stop} disabled={info.status === 'stopping'} className="flex h-10 items-center gap-2 rounded-xl bg-data-red px-4 text-sm font-black text-ink disabled:opacity-60">
                  {info.status === 'stopping' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5" />}{info.status === 'stopping' ? 'Stopping…' : 'Stop recording'}
                </button>
              : <button onClick={start} disabled={!token || !clientId || !list.length || info.status === 'loading'} className="flex h-10 items-center gap-2 rounded-xl bg-brand-accent px-4 text-sm font-black text-brand-bg disabled:opacity-40">
                  {info.status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-3.5 w-3.5" />}{info.status === 'loading' ? 'Starting…' : 'Start recording'}
                </button>}
          </div>
        </header>
        {info.progress && (
          <ProgressBar className="rounded-xl border border-line bg-brand-card px-3 py-2"
            value={info.progress.total ? info.progress.done / info.progress.total : undefined}
            label={`${info.progress.label}${info.progress.total && info.status === 'loading' ? ` · ${Math.floor(info.progress.done)}/${info.progress.total} stocks` : info.progress.total ? ` · ${info.progress.done}/${info.progress.total} files` : '…'}`} />
        )}
        {!token && <TokenBar />}
        {info.error && <p className="rounded-xl border border-data-caution/50 bg-data-caution/10 px-3 py-2 text-xs text-data-caution">{info.error}</p>}

        {/* the list */}
        <section className="rounded-2xl bg-brand-card p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-ink-3">Recording list ({list.length}/50)</span>
            {listBusy && <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-accent" />}
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
            <button type="submit" disabled={listBusy} className="flex h-10 items-center gap-2 rounded-xl bg-ink px-4 text-sm font-black text-brand-bg disabled:opacity-60">{listBusy && <Loader2 className="h-4 w-4 animate-spin" />}{listBusy ? 'Saving…' : 'Add'}</button>
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

        {/* reversal alerts: bottom right, on top of everything, until closed */}
        <ReversalAlerts alerts={alerts} recording={recording} perm={notifyPerm} onOpen={openAlert} onDismiss={dismiss} onDismissAll={dismissAll} onAskPerm={askNotify} asks={asks} onAsk={askAlert} />

        {/* charts */}
        {charts.map((c, i) => (
          <ChartCard key={c.id} cfg={c} list={list} rec={rec.current!} recording={recording} api={api}
            pos={{ i, n: charts.length, prev: charts[(i - 1 + charts.length) % charts.length].symbol, next: charts[(i + 1) % charts.length].symbol }}
            onSwitch={(dir) => switchFull(charts[(i + dir + charts.length) % charts.length].id)}
            onChange={(n) => setCharts((all) => all.map((x) => (x.id === c.id ? n : x)))}
            onClose={() => setCharts((all) => all.filter((x) => x.id !== c.id))}
            onAddToList={recordLive} />
        ))}
        <button onClick={() => addChart()} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong text-sm font-bold text-ink-2">
          <Plus className="h-4 w-4" />Add chart
        </button>
      </div>
    </div>
  );
}

type AskState = { busy: boolean; text?: string; err?: string; cost?: number };
function ReversalAlerts({ alerts, recording, perm, onOpen, onDismiss, onDismissAll, onAskPerm, asks, onAsk }: {
  alerts: Alert[]; recording: boolean; perm: NotificationPermission | 'unsupported';
  onOpen: (a: ReversalAlert) => void; onDismiss: (id: string) => void; onDismissAll: () => void; onAskPerm: () => void;
  asks: Record<string, AskState>; onAsk: (a: ReversalAlert) => void;
}) {
  if (!alerts.length && !(recording && perm === 'default')) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 flex max-h-[75vh] w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto">
      {recording && perm === 'default' && (
        <button onClick={onAskPerm} className="flex items-center gap-2 rounded-xl border border-brand-accent/60 bg-brand-card px-3 py-2 text-left text-xs font-bold text-brand-accent shadow-lg">
          <Bell className="h-4 w-4 shrink-0" />Turn on desktop alerts, so reversals reach you on other tabs too
        </button>
      )}
      {alerts.length > 1 && (
        <button onClick={onDismissAll} className="self-end rounded-lg border border-line-strong bg-brand-card px-2 py-1 text-[11px] font-bold text-ink-2 shadow">Close all ({alerts.length})</button>
      )}
      {alerts.map((a) => {
        const long = a.side === 'LONG';
        const extreme = a.kind === 'EXTREME';
        const ask = asks[a.id];
        return (
          <div key={a.id} className={`relative rounded-xl border bg-brand-card shadow-lg ${long ? 'border-data-green/70' : 'border-data-red/70'} ${a.opened ? 'opacity-75' : ''}`}>
            <button onClick={() => onOpen(a)} className="block w-full px-3 py-2 pr-9 text-left" title="Open the chart at this moment">
              <span className="flex items-center gap-1.5 text-sm font-black">
                <BellRing className={`h-4 w-4 ${long ? 'text-data-green' : 'text-data-red-text'}`} />
                {a.symbol}
                <span className={long ? 'text-data-green' : 'text-data-red-text'}>{extreme ? (long ? '▲ Day-low reversal' : '▼ Day-high reversal') : (long ? '▲ Reversal long' : '▼ Reversal short')}</span>
                <span className="ml-auto font-mono text-[11px] font-normal text-ink-3">{clock(a.at)}</span>
              </span>
              <span className="mt-0.5 block font-mono text-[11px] text-brand-accent">{long ? 'Buy' : 'Sell'} wall {a.wallPrice.toFixed(2)}{a.zone ? ` · zone ${a.zone[0].toFixed(2)}–${a.zone[1].toFixed(2)}` : ''} · last {a.ltp.toFixed(2)}</span>
              {a.plan && (
                <span className="mt-1 block rounded-md border border-line bg-brand-bg px-2 py-1 font-mono text-[11px] text-ink">
                  {long ? 'Buy' : 'Sell'} {a.plan.qty} @ {a.plan.entry.toFixed(2)} · stop {a.plan.stop.toFixed(2)}{a.plan.capped ? ' (2x ATR cap)' : ''} · target POC {a.plan.target.toFixed(2)} · {a.plan.rr}R
                </span>
              )}
              <span className="mt-1 block text-[11px] leading-snug text-ink-2">{a.why}</span>
            </button>
            <div className="px-3 pb-2">
              {!ask && <button onClick={() => onAsk(a)} className="flex h-7 items-center gap-1 rounded-lg border border-brand-accent/60 px-2 text-[11px] font-black text-brand-accent hover:bg-brand-accent/10"><Sparkles className="h-3 w-3" />Should I take this?</button>}
              {ask?.busy && <p className="flex items-center gap-1.5 text-[11px] text-ink-3"><Loader2 className="h-3 w-3 animate-spin" />Claude is reading the stock…</p>}
              {ask?.err && <p className="text-[11px] text-data-red-text">{ask.err}</p>}
              {ask?.text && <p className="whitespace-pre-line text-[11px] leading-snug text-ink">{ask.text} <span className="text-[10px] text-ink-3">₹{ask.cost?.toFixed(2)}</span></p>}
            </div>
            <button onClick={() => onDismiss(a.id)} aria-label="Close alert" className="absolute right-1.5 top-1.5 rounded p-1 text-ink-3 hover:text-ink"><X className="h-3.5 w-3.5" /></button>
          </div>
        );
      })}
    </div>
  );
}

function ChartCard({ cfg, list, rec, recording, api, pos, onSwitch, onChange, onClose, onAddToList }: {
  cfg: ChartCfg; list: WatchItem[]; rec: Recorder; recording: boolean;
  /** this chart's place among the open charts, and its neighbours' symbols (for the full-screen switcher) */
  pos: { i: number; n: number; prev: string; next: string };
  onSwitch: (dir: -1 | 1) => void;
  api: (path: string, init?: RequestInit) => Promise<Response>;
  onChange: (c: ChartCfg) => void; onClose: () => void; onAddToList: (symbol: string) => Promise<void>;
}) {
  const today = istDate(Date.now());
  const isLive = !cfg.date || cfg.date === today;
  // any stock can be opened: what was recorded comes from S3 (found by symbol and date). Only the live stream needs
  // the stock on the recording list (the "Record live" button adds it).
  const listed = list.find((x) => x.symbol === cfg.symbol);
  const w: WatchItem | undefined = listed ?? (/^[A-Z0-9&-]{2,30}$/.test(cfg.symbol) ? { symbol: cfg.symbol, securityId: '' } : undefined);
  const liveNow = isLive && recording && !!listed;
  const [model, setModel] = useState<BookModel | null>(null);
  const [days, setDays] = useState<{ date: string; from: string; to: string }[]>([]);
  useEffect(() => {
    if (!/^[A-Z0-9&-]{2,30}$/.test(cfg.symbol)) { setDays([]); return; }
    const id = setTimeout(() => { api(`/api/book/days?symbol=${encodeURIComponent(cfg.symbol)}`).then((r) => r.json()).then((j) => setDays(Array.isArray(j.days) ? j.days : [])).catch(() => setDays([])); }, 300);
    return () => clearTimeout(id);
  }, [cfg.symbol, api]);
  // full screen: the whole card (controls, status line, chart, answer) fills the screen; the chart takes the height
  const { ref: card, full, height: fullH, toggle: toggleFull } = useFullscreen<HTMLElement>();
  // in full screen, the arrow keys switch charts too (not while typing in a field)
  useEffect(() => {
    if (!full || pos.n < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); onSwitch(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); onSwitch(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full, pos.n, onSwitch]);
  const [loading, setLoading] = useState<{ label: string; done: number; total: number } | null>(null);
  const [failed, setFailed] = useState('');
  const [adding, setAdding] = useState(false);
  const [answer, setAnswer] = useState<{ q: string; text?: string; busy: boolean; err?: string; cost?: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setModel(null); setAnswer(null); setFailed('');
    if (!w) { setLoading(null); return; }
    const progress = (done: number, total: number) => { if (!cancelled) setLoading({ label: total ? 'Loading from S3' : 'Finding saved data', done, total }); };
    progress(0, 0);
    (async () => {
      const m = liveNow ? await rec.fullModel(listed!, progress) : await loadDay(api, w, cfg.date || today, progress);
      if (!cancelled) { setModel(m); setLoading(null); }
    })().catch((e) => { if (!cancelled) { setLoading(null); setFailed(`Could not load: ${(e as Error).message}`); } });
    return () => { cancelled = true; };
  }, [w?.symbol, cfg.date, liveNow]); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = async (q: string) => {
    if (!w) return;
    setAnswer({ q, busy: true });
    try {
      const r = await api('/api/book/ask', { method: 'POST', body: JSON.stringify({ symbol: w.symbol, question: q, book: model?.summary(model.lastEventAt || Date.now()), date: isLive ? undefined : cfg.date }), headers: { 'Content-Type': 'application/json' } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setAnswer({ q, text: j.text, busy: false, cost: j.costInr });
    } catch (e) { setAnswer({ q, busy: false, err: (e as Error).message }); }
  };

  return (
    <section ref={card} id={`chart-${cfg.id}`} className={`scroll-mt-4 border border-line bg-brand-card p-3 space-y-2 ${full ? 'overflow-auto rounded-none' : 'rounded-2xl'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <input list="ob-symbols" value={cfg.symbol} onChange={(e) => onChange({ id: cfg.id, date: cfg.date, symbol: e.target.value.toUpperCase() })}
          className="h-8 w-36 rounded-lg border border-line bg-brand-bg px-2 text-sm font-black outline-none focus:border-brand-accent" />
        <datalist id="ob-symbols">{list.map((x) => <option key={x.securityId} value={x.symbol} />)}</datalist>
        <input type="date" value={cfg.date || today} max={today} onChange={(e) => onChange({ id: cfg.id, symbol: cfg.symbol, date: e.target.value === today ? '' : e.target.value })}
          className="h-8 rounded-lg border border-line bg-brand-bg px-2 text-xs text-ink-2 outline-none" />
        <span className="text-[11px] text-ink-3">{!w ? '' : liveNow ? 'live (recording)' : isLive ? 'recorded today' : 'recorded day'}</span>
        {days.filter((d) => d.date !== (cfg.date || today)).slice(0, 6).map((d) => (
          <button key={d.date} onClick={() => onChange({ id: cfg.id, symbol: cfg.symbol, date: d.date === today ? '' : d.date })} title={`recorded ${d.from}–${d.to}`}
            className="h-7 rounded-md border border-line-strong px-2 text-[11px] font-bold text-ink-2 hover:border-brand-accent">
            {new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}
          </button>
        ))}
        {w && !listed && (
          <button disabled={adding} onClick={() => { setAdding(true); void onAddToList(cfg.symbol).finally(() => setAdding(false)); }} title="Adds it to the recording list; it streams live while recording is on"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-brand-accent/60 px-3 text-xs font-black text-brand-accent hover:bg-brand-accent/10 disabled:opacity-60">
            {adding ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Adding…</> : '● Record live'}
          </button>
        )}
        {full && pos.n > 1 && (
          <span className="ml-auto flex items-center gap-1">
            <button onClick={() => onSwitch(-1)} aria-label={`Previous chart: ${pos.prev}`} title={`${pos.prev} (←)`} className="flex h-8 items-center gap-1 rounded-lg border border-line-strong pl-1.5 pr-2.5 text-xs font-black text-ink-2 hover:border-brand-accent hover:text-ink">
              <ChevronLeft className="h-4 w-4" />{pos.prev}
            </button>
            <span className="px-1 font-mono text-[11px] text-ink-3">{pos.i + 1}/{pos.n}</span>
            <button onClick={() => onSwitch(1)} aria-label={`Next chart: ${pos.next}`} title={`${pos.next} (→)`} className="flex h-8 items-center gap-1 rounded-lg border border-line-strong pl-2.5 pr-1.5 text-xs font-black text-ink-2 hover:border-brand-accent hover:text-ink">
              {pos.next}<ChevronRight className="h-4 w-4" />
            </button>
          </span>
        )}
        <button onClick={toggleFull} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen (Esc)' : 'Full screen'} className={`${full && pos.n > 1 ? '' : 'ml-auto '}rounded-lg border border-line p-1.5 text-ink-3 hover:text-ink`}>
          {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
        {!full && <button onClick={onClose} aria-label="Close chart" className="rounded-lg border border-line p-1.5 text-ink-3 hover:text-ink"><X className="h-4 w-4" /></button>}
      </div>
      {w && model && <BookChart model={model} live={liveNow} height={full ? fullH : 560} onAsk={ask} focus={cfg.focus} focusLabel="Alert" alertMark={cfg.alert} />}
      {w && !model && loading && (
        <LoadingPanel height={full ? fullH : 560} value={loading.total ? loading.done / loading.total : undefined}
          label={loading.total ? `${loading.label} · ${loading.done}/${loading.total} pieces (10 min each)` : `${loading.label}…`} />
      )}
      {failed && <p className="text-xs text-data-red-text">{failed}</p>}
      {liveNow && listed && (() => {
        const snap = rec.probe.snapshots.get(listed.securityId);
        if (!snap) return null;
        const save = () => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(snap, null, 1)], { type: 'application/json' }));
          const a = document.createElement('a'); a.href = url; a.download = `${snap.symbol}-feed-diagnostic.json`; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        return (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-data-caution/50 bg-data-caution/10 px-3 py-2 text-xs text-data-caution">
            <span>Dhan is sending trades for {snap.symbol} but not one order book packet ({snap.stock.quotes} trades, 0 book packets). A diagnostic with the raw feed was saved to S3.</span>
            <button onClick={save} className="ml-auto h-7 rounded-lg border border-data-caution/70 px-2.5 font-black">Download diagnostic</button>
          </div>
        );
      })()}
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
