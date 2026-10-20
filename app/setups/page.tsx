"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { TokenBar } from '@/components/auth/TokenBar';
import { ProgressBar } from '@/components/ui/progress';
import { Card, Delta, StatCells, StatHead, Verdict, pct, rr } from '@/components/setups/parts';
import { CASE_BY_ID, EXIT_KEYS, EXIT_LABEL, PRIMARY_TARGET, STRETCH_AT_LEAST, STRETCH_UNDER, TARGET_KEYS, TARGET_LABEL, hhmm, type CaseId, type OutKey, type Signal } from '@/lib/setups/cases';
import { DIMS, applyFilter, statsOf, unpack, type DimKey, type Filter, type Packed, type Stats, type Summary } from '@/lib/setups/stats';
import type { RunIndexItem, RunStatus } from '@/lib/setups/store';

/**
 * My Setups: every setup tested on two years of the stocks his screener would have shown, with numbers after Dhan's
 * charges. Re-run fetches only what is new (a finished month of candles is never fetched again) and the page shows
 * what changed against the run before.
 */

type Status = (RunStatus & { stale?: boolean }) | null;
interface Data { status: Status; runs: RunIndexItem[]; summary: Summary | null; previous: Summary | null; minHit?: number }

const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtTime = (ms: number) => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

export default function SetupsPage() {
  const { token } = useAuth();
  const [data, setData] = useState<Data | null>(null);
  const [run, setRun] = useState('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<CaseId | null>(null);
  const [starting, setStarting] = useState(false);
  const [help, setHelp] = useState(false);

  const load = useCallback(async (runId = '') => {
    try {
      const r = await fetch(`/api/setups/runs${runId ? `?run=${encodeURIComponent(runId)}` : ''}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setData(j); setErr('');
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // while a run is going: poll its status, then reload the results when it is done
  const active = !!data?.status && (data.status.state === 'queued' || data.status.state === 'running') && !data.status.stale;
  const wasActive = useRef(false);
  useEffect(() => {
    if (!active) { if (wasActive.current) { wasActive.current = false; void load(); } return; }
    wasActive.current = true;
    const id = setInterval(async () => {
      try {
        const j = await (await fetch('/api/setups/runs?status=1')).json();
        setData((d) => (d ? { ...d, status: j.status } : d));
      } catch { /* keep polling */ }
    }, 8000);
    return () => clearInterval(id);
  }, [active, load]);

  const rerun = async () => {
    setStarting(true); setErr('');
    try {
      const r = await fetch('/api/setups/run', { method: 'POST', headers: { 'x-dhan-token': token } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok && !j.status) throw new Error(j.message ?? `HTTP ${r.status}`);
      setData((d) => (d ? { ...d, status: j.status } : d));
      if (!r.ok) setErr(j.message);
    } catch (e) { setErr((e as Error).message); } finally { setStarting(false); }
  };

  const s = data?.summary ?? null, prev = data?.previous ?? null;
  const minHit = data?.minHit ?? 0.6;
  const prevCase = (id: CaseId) => prev?.cases.find((c) => c.id === id);

  return (
    <div className="min-h-screen bg-brand-bg text-ink font-sans pb-24">
      <div className="page-shell pt-6 space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
          <div>
            <h1 className="text-2xl font-black tracking-tighter">My Setups</h1>
            <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-ink-3">Two years of your screener's stocks · 10-minute chart · after Dhan's charges · nothing after 15:00</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data && data.runs.length > 1 && (
              <select value={run || data.runs[0].runId} onChange={(e) => { setRun(e.target.value); void load(e.target.value); }}
                className="h-10 rounded-xl border border-line-strong bg-brand-bg px-3 text-xs font-bold text-ink-2 outline-none">
                {data.runs.map((x, i) => <option key={x.runId} value={x.runId}>{i === 0 ? 'Latest · ' : ''}{fmtTime(x.createdAt)}</option>)}
              </select>
            )}
            <button onClick={rerun} disabled={!token || starting || active}
              title={!token ? 'Log in on the Dhan login tab first: the run uses today\'s token' : 'Fetches only what is new and tests everything again'}
              className="flex h-10 items-center gap-2 rounded-xl bg-brand-accent px-4 text-sm font-black text-brand-bg disabled:opacity-40">
              {starting || active ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {active ? 'Running…' : data?.runs.length ? 'Re-run' : 'Run the backtest'}
            </button>
          </div>
        </header>

        {!token && <TokenBar />}
        <RunLine status={data?.status ?? null} />
        {err && <p className="rounded-xl border border-data-caution/50 bg-data-caution/10 px-3 py-2 text-xs text-data-caution">{err} <button onClick={() => setHelp(true)} className="underline">How to set up</button></p>}
        {!data && !err && <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>}

        {data && !s && (
          <Card title="No results yet" sub="Press “Run the backtest”. The first run fetches two years of 1-minute candles and takes about an hour; later runs take minutes.">
            <p className="text-xs text-ink-2">It needs today’s Dhan token (Dhan login tab) and the one-time GitHub setup below.</p>
          </Card>
        )}

        {s && (
          <>
            <p className="text-[11px] text-ink-3">
              {fmtDate(s.period.from)} – {fmtDate(s.period.to)} · {s.universe.symbols} stocks on {s.universe.stockDays.toLocaleString('en-IN')} stock-days · {s.universe.signals.toLocaleString('en-IN')} past trades · {s.universe.source}
              {prev && <> · ▲▼ = hit rate change in points vs the run of {fmtTime(prev.createdAt)}</>}
            </p>
            {s.v !== 2 && (
              <p className="rounded-xl border border-data-caution/50 bg-data-caution/10 px-3 py-2 text-xs text-data-caution">This run used the old rules (1-minute triggers, no swing stops, no discretionary exits). Press Re-run for the 10-minute version.</p>
            )}
            <CaseTable summary={s} minHit={minHit} prevCase={prevCase} hasPrev={!!prev} open={open} onOpen={(id) => setOpen(open === id ? null : id)} />
            {open && s.v === 2 && <CaseDetail key={`${s.runId}-${open}`} summary={s} minHit={minHit} id={open} prev={prev?.v === 2 ? prevCase(open) : undefined} onClose={() => setOpen(null)} />}
            <Rules summary={s} previous={prev} />
          </>
        )}

        <HowItWorks open={help} onToggle={() => setHelp((h) => !h)} />
      </div>
    </div>
  );
}

function RunLine({ status }: { status: Status }) {
  if (!status) return null;
  if (status.state === 'done') return <p className="text-[11px] text-ink-3">Last run finished {fmtTime(status.finishedAt ?? status.updatedAt)}{status.message ? `: ${status.message}` : ''}.</p>;
  if (status.state === 'failed') return <p className="rounded-xl border border-data-red/50 bg-data-red/10 px-3 py-2 text-xs text-data-red-text">The last run failed ({fmtTime(status.updatedAt)}): {status.message}</p>;
  if (status.stale) return <p className="rounded-xl border border-data-caution/50 bg-data-caution/10 px-3 py-2 text-xs text-data-caution">The run started {fmtTime(status.startedAt)} stopped responding (cancelled or timed out on GitHub). Press Re-run; nothing already fetched is fetched again.</p>;
  return (
    <ProgressBar className="rounded-xl border border-line bg-brand-card px-3 py-2"
      value={status.total ? (status.done ?? 0) / status.total : undefined}
      label={`${status.state === 'queued' ? 'Starting on GitHub' : status.phase ?? 'Running'}${status.total ? ` · ${status.done}/${status.total}` : ''} · started ${fmtTime(status.startedAt)}`} />
  );
}

function CaseTable({ summary, minHit, prevCase, hasPrev, open, onOpen }: { summary: Summary; minHit: number; prevCase: (id: CaseId) => Summary['cases'][number] | undefined; hasPrev: boolean; open: CaseId | null; onOpen: (id: CaseId) => void }) {
  const groups = [
    { title: 'Combined: several conditions together', pick: (id: CaseId) => CASE_BY_ID.get(id)?.group === 'COMBINED' },
    { title: 'Momentum building blocks (one condition each)', pick: (id: CaseId) => CASE_BY_ID.get(id)?.group === 'BLOCK' && CASE_BY_ID.get(id)?.family === 'MOMENTUM' },
    { title: 'Reversal building blocks (one condition each)', pick: (id: CaseId) => CASE_BY_ID.get(id)?.group === 'BLOCK' && CASE_BY_ID.get(id)?.family === 'REVERSAL' },
  ];
  return (
    <Card title="Every setup" sub={`Hit rate = target before stop (momentum: 1R, reversal: its level). Alert-worthy = 50+ trades, ${Math.round(minHit * 100)}%+ hit, makes money after charges, steady in both halves. Tap a setup for its stops, exits, stretch steps and times.`}>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <thead>
            <tr className="border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3">
              <th className="px-2 py-1.5 text-left">Setup</th>
              <th className="px-2 py-1.5 text-right">Trades</th>
              <th className="px-2 py-1.5 text-right">Hit</th>
              <th className="px-2 py-1.5 text-right">R after costs</th>
              <th className="hidden px-2 py-1.5 text-right sm:table-cell">1st / 2nd half</th>
              {hasPrev && <th className="px-2 py-1.5 text-right">vs last</th>}
              <th className="px-2 py-1.5 text-right">Verdict</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.title}>
              <tr><td colSpan={7} className="px-2 pb-1 pt-3 text-[10px] font-black uppercase tracking-[0.2em] text-brand-accent">{g.title}</td></tr>
              {summary.cases.filter((c) => g.pick(c.id)).map((c) => {
                const info = CASE_BY_ID.get(c.id)!;
                return (
                  <tr key={c.id} onClick={() => onOpen(c.id)} className={`cursor-pointer border-b border-line/60 hover:bg-white/5 ${open === c.id ? 'bg-white/5' : ''}`}>
                    <td className="px-2 py-1.5">
                      <span className="flex items-center gap-1.5">
                        {open === c.id ? <ChevronDown className="h-3.5 w-3.5 text-brand-accent" /> : <ChevronRight className="h-3.5 w-3.5 text-ink-3" />}
                        <span className="font-mono text-[10px] text-ink-3">{c.id}</span>
                        <span className="font-bold">{info.name}</span>
                        <span className={`text-[9px] font-black uppercase ${info.family === 'MOMENTUM' ? 'text-data-green' : 'text-data-red-text'}`}>{info.family === 'MOMENTUM' ? 'mom' : 'rev'}</span>
                        {c.all.fill !== undefined && <span className="text-[10px] text-ink-3">· filled {pct(c.all.fill)}</span>}
                      </span>
                    </td>
                    <StatCells s={c.all} />
                    {hasPrev && <td className="px-2 py-1.5 text-right font-mono"><Delta now={c.all} before={prevCase(c.id)?.all} /></td>}
                    <td className="px-2 py-1.5 text-right"><Verdict s={c.all} minHit={minHit} /></td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </Card>
  );
}

/** Every past trade of one case, unzipped in the browser (one small file per case). */
function useSignals(runId: string, id: CaseId) {
  const [sigs, setSigs] = useState<Signal[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let off = false;
    (async () => {
      const r = await fetch(`/api/setups/signals?run=${encodeURIComponent(runId)}&case=${id}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? `HTTP ${r.status}`);
      const text = await new Response(r.body!.pipeThrough(new DecompressionStream('gzip'))).text();
      if (!off) setSigs(unpack(JSON.parse(text) as Packed));
    })().catch((e) => { if (!off) setErr((e as Error).message); });
    return () => { off = true; };
  }, [runId, id]);
  return { sigs, err };
}

function CaseDetail({ summary, minHit, id, prev, onClose }: { summary: Summary; minHit: number; id: CaseId; prev?: Summary['cases'][number]; onClose: () => void }) {
  const info = CASE_BY_ID.get(id)!;
  const c = summary.cases.find((x) => x.id === id)!;
  const { sigs, err } = useSignals(summary.runId, id);
  const [f, setF] = useState<Filter>({});
  const filtered = useMemo(() => (sigs ? applyFilter(sigs, f) : []), [sigs, f]);
  const [exitKey, setExitKey] = useState<OutKey>(PRIMARY_TARGET[info.family]);
  const fs = useMemo(() => (sigs ? statsOf(filtered, exitKey, summary.period.mid) : undefined), [sigs, filtered, exitKey, summary.period.mid]);
  const anyFilter = Object.values(f).some((v) => (Array.isArray(v) ? v.length : v !== undefined));
  const toggle = (k: DimKey, v: string) => setF((x) => { const cur = x[k] ?? []; const nxt = cur.includes(v) ? cur.filter((y) => y !== v) : [...cur, v]; return { ...x, [k]: nxt }; });
  // where it works best: the alert buckets of this case, best first
  const buckets = Object.entries(summary.lookup).filter(([k]) => k.startsWith(`${id}|`) && k.split('|').length >= 3)
    .sort((a, b) => b[1].hit - a[1].hit || b[1].netR - a[1].netR).slice(0, 8);
  const outLabel = (k: OutKey) => (k.startsWith('T') ? (k === 'TS' ? `${TARGET_LABEL.TS} (${info.target})` : TARGET_LABEL[k as 'T1' | 'T15']) : EXIT_LABEL[k as keyof typeof EXIT_LABEL]);

  return (
    <Card title={`${id} · ${info.name}`} sub={info.rule} right={<button onClick={onClose} aria-label="Close" className="rounded-lg border border-line p-1.5 text-ink-3 hover:text-ink"><X className="h-4 w-4" /></button>}>
      <p className="text-[11px] text-ink-3">
        Stops: {pct(c.slices.stopType?.SWING ? c.slices.stopType.SWING.n / Math.max(1, c.all.n) : 0)} at a solid swing, the rest at 2x ATR (no solid swing).
        {c.skippedFar > 0 && <> {c.skippedFar.toLocaleString('en-IN')} more times the setup appeared but the solid swing was beyond 2x ATR, so it was not taken.</>}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <MiniTable title="Systematic exits (hit = target before stop)" first="Exit" rows={TARGET_KEYS.map((k) => ({ label: outLabel(k), s: c.byOut[k], before: prev?.byOut?.[k] }))} />
        <MiniTable title="Discretionary exits (hit = made money after charges)" first="Exit when" rows={EXIT_KEYS.map((k) => ({ label: outLabel(k), s: c.byOut[k], before: prev?.byOut?.[k] }))} />
        {c.stretchUnder && (
          <MiniTable title="% of daily range moved, under" first="Stretch" rows={STRETCH_UNDER.map((t) => ({ label: `under ${t}%`, s: c.stretchUnder![`under ${t}%`], before: prev?.stretchUnder?.[`under ${t}%`] }))} />
        )}
        {c.stretchAtLeast && (
          <MiniTable title="% of daily range moved, at least" first="Stretch" rows={STRETCH_AT_LEAST.map((t) => ({ label: `${t}%+`, s: c.stretchAtLeast![`${t}%+`], before: prev?.stretchAtLeast?.[`${t}%+`] }))} />
        )}
        {c.tests && c.tests.length > 0 && <TestsTable rows={c.tests} />}
        {buckets.length > 0 && (
          <MiniTable title="Where it works best (50+ trades each)" first="Stretch · time · Nifty open → trade" rows={buckets.map(([k, s]) => ({ label: k.split('|').slice(1).join(' · '), s }))} />
        )}
        {c.combos.length > 0 && (
          <MiniTable title="Together with another setup (same way, within 30 min)" first="With" rows={c.combos.map((x) => ({ label: `${x.with} ${CASE_BY_ID.get(x.with)?.name ?? ''}`, s: x.stats }))} />
        )}
        {c.slices.slot30 && (
          <MiniTable title="When it sets up (30-minute slots)" first="From" rows={Object.entries(c.slices.slot30).map(([k, s]) => ({ label: k, s }))} />
        )}
      </div>

      <div className="space-y-2 rounded-xl border border-line bg-brand-bg p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex flex-wrap items-center gap-2 text-[10px] font-black uppercase tracking-widest text-ink-3">
            Combine any slices · exit
            <select value={exitKey} onChange={(e) => setExitKey(e.target.value as OutKey)} className="h-7 max-w-[260px] rounded-md border border-line-strong bg-brand-bg px-1.5 text-[11px] font-bold normal-case tracking-normal text-ink-2 outline-none">
              {[...TARGET_KEYS, ...EXIT_KEYS].map((k) => <option key={k} value={k}>{outLabel(k)}</option>)}
            </select>
          </p>
          {anyFilter && <button onClick={() => setF({})} className="text-[11px] font-bold text-brand-accent">Clear</button>}
        </div>
        {DIMS.map((d) => {
          const counts = c.slices[d.key] ?? {};
          const vals = d.values.filter((v) => counts[v]);
          if (vals.length < 2) return null;
          return (
            <div key={d.key} className="flex flex-wrap items-center gap-1.5">
              <span className="w-36 shrink-0 text-[11px] text-ink-3">{d.label}</span>
              {vals.map((v) => {
                const on = (f[d.key] ?? []).includes(v);
                return (
                  <button key={v} onClick={() => toggle(d.key, v)} title={`${counts[v].n} trades, ${pct(counts[v].hit)} hit, ${rr(counts[v].netR)}`}
                    className={`h-7 rounded-md border px-2 text-[11px] font-bold ${on ? 'border-brand-accent bg-brand-accent/15 text-brand-accent' : 'border-line-strong text-ink-2'}`}>
                    {v} <span className={`font-mono font-normal ${counts[v].netR > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{pct(counts[v].hit)}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {err && <p className="text-xs text-data-red-text">{err}</p>}
        {!sigs && !err && <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading the past trades…</p>}
        {sigs && fs && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2 text-xs">
            <span className="font-bold">{anyFilter ? 'These slices' : 'All trades'}:</span>
            <span><b className="font-mono">{fs.n}</b> trades</span>
            <span><b className="font-mono">{pct(fs.hit)}</b> hit</span>
            <span className={fs.netR > 0 ? 'text-data-green' : 'text-data-red-text'}><b className="font-mono">{rr(fs.netR)}</b> per trade after costs</span>
            <span className="text-ink-3">halves {pct(fs.h1.hit)} / {pct(fs.h2.hit)}</span>
            <span className="text-ink-3">avg {fs.min} min</span>
            <Verdict s={fs} minHit={minHit} />
          </div>
        )}
        {sigs && filtered.length > 0 && <RecentTrades sigs={filtered} target={exitKey} />}
      </div>
    </Card>
  );
}

/** Which test of the day's high / low, and at what time each test set up. */
function TestsTable({ rows }: { rows: { test: string; stats: Stats; bySlot: Record<string, Stats> }[] }) {
  return (
    <div className="lg:col-span-2">
      <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-ink-3">By test of the day&apos;s high / low, and when that test set up</p>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-xs">
          <StatHead first="Test" />
          <tbody>
            {rows.map((r) => (
              <React.Fragment key={r.test}>
                <tr className="border-b border-line/60">
                  <td className="px-2 py-1.5 font-bold">{r.test === '1' ? '1st test' : r.test === '2' ? '2nd test' : '3rd test or later'}</td>
                  <StatCells s={r.stats} />
                </tr>
                <tr className="border-b border-line/60">
                  <td colSpan={5} className="px-2 pb-2 pt-0.5">
                    <span className="flex flex-wrap gap-1">
                      {Object.entries(r.bySlot).map(([slot, s]) => (
                        <span key={slot} title={`${s.n} trades, ${pct(s.hit)} hit, ${rr(s.netR)} after costs`}
                          className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${s.n < 20 ? 'border-line text-ink-4' : s.netR > 0 ? 'border-data-green/50 text-data-green' : 'border-line-strong text-ink-2'}`}>
                          {slot} · {s.n} · {pct(s.hit)}
                        </span>
                      ))}
                    </span>
                  </td>
                </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10px] text-ink-3">Chips: the 30-minute slot the test happened in · trades · hit rate. Green = makes money after charges (20+ trades).</p>
    </div>
  );
}

function MiniTable({ title, first, rows }: { title: string; first: string; rows: { label: string; s?: Stats; before?: Stats }[] }) {
  const hasBefore = rows.some((r) => r.before);
  return (
    <div>
      <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-ink-3">{title}</p>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-xs">
          <StatHead first={first} />
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-line/60">
                <td className="px-2 py-1.5">{r.label} {hasBefore && <span className="ml-1 font-mono text-[10px]"><Delta now={r.s} before={r.before} /></span>}</td>
                <StatCells s={r.s} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RecentTrades({ sigs, target }: { sigs: Signal[]; target: OutKey }) {
  const [n, setN] = useState(12);
  const last = sigs.filter((s) => s.out).slice(-n).reverse();
  return (
    <div className="border-t border-line pt-2">
      <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-ink-3">Latest examples (check them on your chart)</p>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-[520px] text-[11px]">
          <tbody>
            {last.map((s) => {
              const o = s.out?.[target];
              return (
                <tr key={`${s.symbol}${s.date}${s.slot}${s.dir}`} className="border-b border-line/40">
                  <td className="px-2 py-1 font-mono text-ink-3">{s.date} {hhmm(s.slot)}</td>
                  <td className="px-2 py-1 font-bold">{s.symbol}</td>
                  <td className={`px-2 py-1 font-bold ${s.dir === 1 ? 'text-data-green' : 'text-data-red-text'}`}>{s.dir === 1 ? 'LONG' : 'SHORT'}</td>
                  <td className="px-2 py-1 font-mono">@ {s.entry} · stop {s.stop}{s.stopType === 'ATR2' ? ' (2x ATR)' : ''} · target {s.target}</td>
                  <td className="px-2 py-1 font-mono text-ink-3">{s.stretch}% range{s.testNo ? ` · test ${s.testNo} (${s.tests.map(hhmm).join(', ')})` : ''}</td>
                  <td className={`px-2 py-1 text-right font-mono ${o && o.net > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{s.case === 'M9' && !s.out?.filled ? 'not filled' : o ? `${o.hit ? 'hit' : 'miss'} ${rr(o.net)}` : '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sigs.length > n && <button onClick={() => setN(n + 24)} className="mt-1 text-[11px] font-bold text-brand-accent">Show more</button>}
    </div>
  );
}

function Rules({ summary, previous }: { summary: Summary; previous: Summary | null }) {
  return (
    <Card title="Your rules, checked" sub="Every momentum and reversal trade above, split by your own rules. Same hit-rate definition as the table.">
      <div className="grid gap-4 lg:grid-cols-3">
        {summary.rules.map((r) => {
          const before = previous?.rules.find((x) => x.id === r.id);
          return <MiniTable key={r.id} title={r.title} first="" rows={r.rows.map((x) => ({ label: x.label, s: x.stats, before: before?.rows.find((y) => y.label === x.label)?.stats }))} />;
        })}
      </div>
    </Card>
  );
}

function HowItWorks({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <section className="rounded-2xl border border-line p-4">
      <button onClick={onToggle} className="flex w-full items-center justify-between text-left text-sm font-black">
        How it works · how to set up
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {open && (
        <div className="mt-3 space-y-3 text-xs leading-relaxed text-ink-2">
          <p><b>Which stocks:</b> each day, the Nifty 500 stocks your screener would have shown that morning (previous close ₹250–340, 10-day average volume above 3M). Today&apos;s Nifty 500 members are used, so stocks that left the index are missed; that flatters the numbers slightly.</p>
          <p><b>How a trade is scored:</b> everything is decided on the 10-minute chart: a setup appears only when a 10-minute candle closes, and the entry is that close. The stop goes 0.1 ATR beyond the nearest solid swing (a 10-min swing low/high that price moved away from by 0.75 ATR+, came back to and was rejected, and has not been broken since). If that swing is beyond 2x ATR the trade is not taken; with no solid swing the stop is 2x ATR. 1-minute candles are used only to see whether the stop or the target came first inside a 10-minute candle; when both are touched in the same minute it counts as the stop. Anything open is closed at 15:00. Size = your ₹300 risk / stop distance, and Dhan&apos;s charges at that size are taken off every result. Order-book rejection cannot be tested (no past order books), so confirm it on the Order Book page.</p>
          <p><b>Exits:</b> systematic = 1R, 1.5R, the structural target. Discretionary = the first time one marker shows up (checked at each 10-minute close): structure breaks, a heavy candle against you, Nifty turns against you, the day range reaches 95% of usual, the next obstacle, no progress after 30 minutes, give-back from +1R. Their &quot;hit&quot; = the trade made money after charges.</p>
          <p><b>Halves:</b> the two years are split in the middle. A setup that only works in one half was probably luck or one market mood.</p>
          <p><b>Re-run:</b> runs on GitHub Actions with today&apos;s Dhan token. Finished months of 1-minute candles are kept in S3 and never fetched again, so a re-run a month later only fetches the new month.</p>
          <p><b>One-time setup.</b> GitHub repo → Settings → Secrets and variables → Actions: <code>DHAN_CLIENT_ID</code>, <code>AWS_ACCESS_KEY_ID</code>, <code>AWS_SECRET_ACCESS_KEY</code>, <code>AWS_REGION</code>, <code>S3_BUCKET</code>. Vercel → Environment Variables: <code>GH_DISPATCH_TOKEN</code> (fine-grained token, tradereye only, Actions: Read and write), then redeploy. Optional: <code>SETUPS_ALERT_MIN_HIT</code> (default 0.6) for the Order Book alerts.</p>
        </div>
      )}
    </section>
  );
}
