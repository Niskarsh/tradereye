"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Loader2, Maximize2, Minimize2, RefreshCcw, TrendingUp, Upload } from 'lucide-react';
import { CandleChart, type ChartFlag, type ChartHLine, type ChartMark } from '@/components/journal/CandleChart';
import { useFullscreen } from '@/components/book/useFullscreen';
import { tradeMarks, type Fill } from '@/lib/book/marks';
import { buildDaily, buildIntraday, istHHMM, tradeFacts, type SignalKind } from '@/lib/candles/chart';
import type { Candles } from '@/lib/dhan';

/**
 * The trade's charts, rebuilt from market data (no screenshot needed): daily candles on the left (about a month in
 * view, two years to drag back through), the 10-minute chart of the day on the right with his entries, adds and exits,
 * stop / target / 1R, VWAP, 200 EMA, the day's volume profile, Nifty 500 underneath, and the exit signals that fired.
 * Tap a day on the daily chart to open it on the 10-minute chart.
 *
 * Data: /api/journal/candles reads the saved candles from S3 (Google sign-in is enough); anything missing comes from Dhan
 * once (needs the Dhan token that one time) and is saved, so opening the journal again needs no Dhan login. Loads when the card scrolls into view (or at once with `eager`, as the journal does), one trade at a time.
 */

interface Resp { symbol: string; securityId?: string; date: string; minute: Candles; nifty: Candles; daily?: Candles; live: boolean; counts: { fromS3: number; fromDhan: number; saved: number; dhanCalls: number; s3Errors: number; s3Error?: string; notSaved?: number } }

// one request at a time across all trade cards (Dhan allows 5 data requests a second)
let queue: Promise<unknown> = Promise.resolve();
function queued<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

const SIGNAL_COLOR: Record<SignalKind, string> = { MFE: '#1DC995', R08: '#4FA3E0', GIVEBACK: '#E8873A', VWAP_RECLAIM: '#DFB15B' };
const num = (v?: string) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? n : undefined; };

function useWide() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const on = () => setWide(mq.matches); on();
    mq.addEventListener('change', on); return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

export function TradeCharts({ symbol, date, direction, fills, token, securityId, initialStop, stopDist, lastStop, target, uploadedChart, uploading, onViewUploaded, onUpload, eager = false }: {
  symbol: string; date: string; direction: string; fills: Fill[]; token: string;
  /** start loading as soon as the page opens instead of when the card scrolls near the screen */
  eager?: boolean;
  /** a chart screenshot uploaded by hand (older trades): shown on demand, not as a big box */
  uploadedChart?: string; uploading?: boolean; onViewUploaded?: (url: string) => void; onUpload?: (file: File) => void;
  securityId?: string; initialStop?: string; stopDist?: string; lastStop?: string; target?: string;
}) {
  const sym = symbol.trim().toUpperCase();
  const ok = /^[A-Z0-9&-]{1,30}$/.test(sym) && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const tokenRef = useRef(token); tokenRef.current = token;
  const fetchCandles = useCallback((body: Record<string, unknown>) => queued(async () => {
    const r = await fetch('/api/journal/candles', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dhan-token': tokenRef.current }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.message ?? `HTTP ${r.status}`), { code: j.error as string | undefined });
    return j as Resp;
  }), []);

  // load once the card is (nearly) on screen
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(eager);
  useEffect(() => {
    const el = box.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(el); return () => io.disconnect();
  }, [seen]);

  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState('');
  const [needsDhan, setNeedsDhan] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try { setData(await fetchCandles({ symbol: sym, date, securityId: /^\d+$/.test(securityId ?? '') ? securityId : undefined })); }
    catch (e) { setErr((e as Error).message); setNeedsDhan((e as { code?: string }).code === 'NEEDS_DHAN'); }
    finally { setBusy(false); }
  }, [fetchCandles, sym, date, securityId]);
  // saved charts need only the Google sign-in; the Dhan token is used just to fetch days not saved yet
  useEffect(() => { if (seen && ok && !data && !busy && !err) void load(); }, [seen, ok, data, busy, err, load]);
  // logged in to Dhan after "not saved yet": try again by itself
  useEffect(() => { if (token && needsDhan) { setNeedsDhan(false); setErr(''); } }, [token, needsDhan]);

  // a day picked on the daily chart: shown on the 10-minute chart (fetched if it is older than what is loaded)
  const [picked, setPicked] = useState<string>(date);
  const [extra, setExtra] = useState<Record<string, Resp | 'loading' | { error: string }>>({});
  const loadedDays = useMemo(() => new Set(data ? data.minute.t.map((t) => new Date(t * 1000 + 19800_000).toISOString().slice(0, 10)) : []), [data]);
  const pick = useCallback((d: string) => {
    setPicked(d);
    if (d === date || loadedDays.has(d) || extra[d]) return;
    setExtra((x) => ({ ...x, [d]: 'loading' }));
    fetchCandles({ symbol: sym, date: d, securityId: data?.securityId, parts: ['minute', 'nifty'] })
      .then((r) => setExtra((x) => ({ ...x, [d]: r })))
      .catch((e) => setExtra((x) => ({ ...x, [d]: { error: (e as Error).message } })));
  }, [date, loadedDays, extra, fetchCandles, sym, data?.securityId]);

  const fillsKey = JSON.stringify(fills);
  const marks = useMemo(() => tradeMarks(date, direction, JSON.parse(fillsKey)), [date, direction, fillsKey]);
  const dir: 'LONG' | 'SHORT' = /short/i.test(direction) ? 'SHORT' : /long/i.test(direction) ? 'LONG' : marks[0]?.side === 'SELL' ? 'SHORT' : 'LONG';

  const daily = useMemo(() => (data ? buildDaily(data.daily, data.minute, date) : null), [data, date]);
  const src = picked === date || loadedDays.has(picked) ? data : (extra[picked] && typeof extra[picked] === 'object' && 'minute' in (extra[picked] as object) ? extra[picked] as Resp : null);
  const intra = useMemo(() => (src ? buildIntraday(src.minute, src.nifty, picked) : null), [src, picked]);
  const facts = useMemo(() => (data && picked === date && intra ? tradeFacts(intra, { date, direction: dir, marks, initialStop: num(initialStop), stopDist: num(stopDist), lastStop: num(lastStop), target: num(target) }) : undefined), [data, intra, picked, date, dir, marks, initialStop, stopDist, lastStop, target]);

  const onTradeDay = picked === date;
  const intraFocus = useMemo(() => {
    if (!intra) return { from: 0, to: 0 };
    const s = intra.sessions.findIndex((x) => x.date === picked);
    if (s < 0) return { from: Math.max(0, intra.bars.length - 60), to: intra.bars.length - 1 };
    const day = intra.sessions[s];
    return { from: Math.max(0, day.from - (s > 0 ? 19 : 0)), to: day.to };
  }, [intra, picked]);
  const dailyFocus = useMemo(() => {
    if (!daily?.bars.length) return { from: 0, to: 0 };
    const i = daily.bars.findIndex((b) => b.date === date);
    const at = i < 0 ? daily.bars.length - 1 : i;
    return { from: Math.max(0, at - 22), to: Math.min(daily.bars.length - 1, at + 2) };
  }, [daily, date]);

  const chartMarks: ChartMark[] = useMemo(() => (onTradeDay ? marks.map((m) => ({ t: m.t, price: m.price, side: m.side, label: `${m.role === 'ENTRY' ? 'Entry' : m.role === 'ADD' ? 'Add' : 'Exit'} ${m.qty} @ ${m.price.toFixed(2)}` })) : []), [marks, onTradeDay]);
  const hlines: ChartHLine[] = useMemo(() => {
    if (!facts || !onTradeDay) return [];
    const from = facts.entryAt, to = facts.exitAt ?? facts.entryAt + 60 * 60_000;
    const out: ChartHLine[] = [{ price: facts.avgEntry, color: '#DFB15B', label: 'Avg', dash: [5, 3], from, to }];
    const st = num(initialStop), ls = num(lastStop), tg = num(target);
    if (st) out.push({ price: st, color: '#F06B7C', label: 'Stop', dash: [5, 3], from, to });
    if (ls && st && Math.abs(ls - st) > 0.001) out.push({ price: ls, color: '#F06B7C', label: 'Last stop', dash: [2, 3], from, to });
    if (tg) out.push({ price: tg, color: '#1DC995', label: 'Target', dash: [5, 3], from, to });
    if (facts.oneRPrice) out.push({ price: facts.oneRPrice, color: '#4FA3E0', label: facts.rBasis === '2ATR' ? '1R (2 ATR)' : '1R', dash: [2, 3], from, to });
    return out;
  }, [facts, onTradeDay, initialStop, lastStop, target]);
  const flags: ChartFlag[] = useMemo(() => (facts?.signals ?? []).map((s) => ({ t: s.t, price: s.price, color: SIGNAL_COLOR[s.kind], label: s.label })), [facts]);

  const intraLines = useMemo(() => (intra ? [{ values: intra.vwap, color: '#DFB15B', label: 'VWAP' }, { values: intra.ema200, color: '#E8EAF0', label: 'EMA200', width: 1.2 }] : []), [intra]);
  const dailyLines = useMemo(() => (daily ? [{ values: daily.ema20, color: '#4FA3E0', label: 'EMA20' }, { values: daily.ema50, color: '#E8873A', label: 'EMA50' }, { values: daily.ema200, color: '#E8EAF0', label: 'EMA200', width: 1.2 }] : []), [daily]);
  const lower = useMemo(() => (intra ? { values: intra.niftyPct, label: 'Nifty 500 % vs prev close', color: '#9F8CF0', fmt: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` } : undefined), [intra]);
  const profile = useMemo(() => (intra ? { ...intra.profile, date: picked } : undefined), [intra, picked]);
  const highlight = useMemo(() => (facts && onTradeDay ? { from: facts.entryAt, to: facts.exitAt ?? facts.entryAt } : undefined), [facts, onTradeDay]);
  const dailyHighlight = useMemo(() => {
    const b = daily?.bars.find((x) => x.date === date);
    return b ? { from: b.t, to: b.t } : undefined;
  }, [daily, date]);

  const wide = useWide();
  const { ref: card, full, height: fullH, toggle } = useFullscreen<HTMLDivElement>(150);
  const hIntra = full ? fullH : wide ? 460 : 380;
  const hDaily = full ? (wide ? fullH : Math.round(fullH * 0.45)) : wide ? 460 : 260;

  const fileInput = useRef<HTMLInputElement>(null);
  const pill = 'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[11px] font-bold transition-colors disabled:opacity-60';
  const head = (
    <div className="flex flex-wrap items-center gap-2 mb-3 text-zinc-500">
      <TrendingUp size={14} /><span className="text-[10px] font-black uppercase tracking-widest">Charts</span>
      <div className="ml-auto flex items-center gap-2">
        {uploadedChart && onViewUploaded && (
          <button onClick={() => onViewUploaded(uploadedChart)} className={`${pill} border-brand-accent/60 text-brand-accent hover:bg-brand-accent/10`}>
            <Camera className="h-3.5 w-3.5" />Uploaded chart
          </button>
        )}
        {onUpload && (
          <>
            <input ref={fileInput} type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} />
            <button onClick={() => fileInput.current?.click()} disabled={uploading} title={uploadedChart ? 'Replace the uploaded chart' : 'Upload a chart screenshot (PNG, JPG up to 10MB)'}
              className={`${pill} border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-white`}>
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {uploading ? 'Uploading…' : uploadedChart ? 'Replace' : 'Upload chart'}
            </button>
          </>
        )}
      </div>
    </div>
  );
  if (!ok) return <div className="px-6 pb-4">{head}</div>;

  const pickedState = extra[picked];
  const c = data?.counts;
  const r = (x?: number) => (x === undefined ? '' : `${x}R`);
  const exitR = facts?.avgExit !== undefined && facts.oneR ? Math.round((((facts.avgExit - facts.avgEntry) * (dir === 'LONG' ? 1 : -1)) / facts.oneR) * 100) / 100 : undefined;
  const chips: [string, string][] = facts ? ([
    ['Peak', facts.mfe ? `≈ ₹${Math.round(facts.mfe.inr)}${facts.mfe.r !== undefined ? ` · ${r(facts.mfe.r)}` : ''} at ${istHHMM(facts.mfe.t)}` : ''],
    ['Worst', facts.mae ? `≈ -₹${Math.round(facts.mae.inr)}${facts.mae.r !== undefined ? ` · ${r(facts.mae.r)}` : ''}` : ''],
    ['Exit', exitR !== undefined ? `${exitR >= 0 ? '+' : ''}${exitR}R` : ''],
    ['1R', facts.oneR ? `${facts.oneR.toFixed(2)}/share (${facts.rBasis === '2ATR' ? '2 × ATR, no stop' : 'stop'})` : ''],
    ['Nifty in trade', facts.niftyDuringPct !== undefined ? `${facts.niftyDuringPct >= 0 ? '+' : ''}${facts.niftyDuringPct}%` : ''],
  ] as [string, string][]).filter(([, v]) => v) : [];

  return (
    <div ref={box} className="px-6 pb-6">
      {head}
      <div ref={card} className={`space-y-3 border border-zinc-800/80 bg-brand-card p-3 ${full ? 'overflow-auto rounded-none' : 'rounded-[24px]'}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-black text-white">{sym}</span>
          <span className="text-[11px] text-zinc-500">
            {data?.live ? 'Today · live, saved after the close' : c ? (c.dhanCalls ? `Fetched from Dhan${c.saved ? ', saved to S3 for next time' : ''}` : c.notSaved ? 'From S3 · a few older days are not saved yet (Dhan login fills them in)' : 'From S3') : ''}
          </span>
          {c && c.s3Errors > 0 && c.saved === 0 && c.dhanCalls > 0 && <span title={c.s3Error} className="text-[11px] text-data-caution">Could not save to S3 (shown anyway)</span>}
          <button onClick={toggle} aria-label={full ? 'Exit full screen' : 'Full screen'} className="ml-auto rounded-lg border border-zinc-800 p-1.5 text-zinc-500 hover:text-white">
            {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>

        {err ? (
          <div className="flex items-center gap-3 text-xs text-data-red-text">
            {needsDhan
              ? <span className="text-zinc-400">{err} <a href="/dhan-login" className="font-bold text-brand-accent underline">Dhan login</a></span>
              : <span>Could not load the charts: {err}</span>}
            <button onClick={() => void load()} className="flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-zinc-400 hover:text-white"><RefreshCcw className="h-3 w-3" />Retry</button>
          </div>
        ) : !data ? (
          <div className="flex h-40 items-center justify-center gap-2 text-xs text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />Loading candles…</div>
        ) : (
          <div className={`grid gap-3 ${wide ? 'grid-cols-[2fr_3fr]' : 'grid-cols-1'}`}>
            <div className="min-w-0 space-y-1">
              <p className="text-[11px] text-zinc-500">Daily · <span className="text-[#4FA3E0]">EMA20</span> · <span className="text-[#E8873A]">EMA50</span> · <span className="text-zinc-300">EMA200</span> · tap a day to open it</p>
              {daily && <CandleChart bars={daily.bars} barMs={86400_000} lines={dailyLines} highlight={dailyHighlight} focus={dailyFocus} height={hDaily}
                onPick={(b) => pick(b.date)} pickedDate={picked !== date ? picked : undefined} />}
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                <span>10 min · {picked}{!onTradeDay && ' (not the trade day)'} · <span className="text-brand-accent">VWAP</span> · <span className="text-zinc-300">EMA200</span> · profile = that day</span>
                {!onTradeDay && <button onClick={() => setPicked(date)} className="rounded-md border border-brand-accent/60 px-2 py-0.5 font-bold text-brand-accent">Back to trade day</button>}
              </div>
              {pickedState === 'loading' ? <div className="flex items-center justify-center gap-2 text-xs text-zinc-500" style={{ height: hIntra }}><Loader2 className="h-4 w-4 animate-spin" />Loading {picked}…</div>
                : pickedState && typeof pickedState === 'object' && 'error' in pickedState ? <p className="text-xs text-data-red-text">Could not load {picked}: {pickedState.error}</p>
                : intra && <CandleChart bars={intra.bars} barMs={600_000} lines={intraLines} hlines={hlines} marks={chartMarks} flags={flags} lower={lower}
                    profile={profile} highlight={highlight} focus={intraFocus} height={hIntra} />}
            </div>
          </div>
        )}

        {chips.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {chips.map(([k, v]) => <span key={k} className="rounded-full border border-zinc-800/60 bg-zinc-900/60 px-3 py-1 text-[10px] font-bold text-zinc-500">{k}: <span className="font-mono text-zinc-300">{v}</span></span>)}
          </div>
        )}
        {facts && facts.signals.length > 0 && (
          <ul className="space-y-1">
            {facts.signals.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-zinc-300">
                <span className="mt-1 h-2 w-2 shrink-0 rotate-45" style={{ background: SIGNAL_COLOR[s.kind] }} />{s.detail}
              </li>
            ))}
          </ul>
        )}
        {data && onTradeDay && !facts && <p className="text-[11px] text-zinc-600">No fills to mark on this chart.</p>}
      </div>
    </div>
  );
}
