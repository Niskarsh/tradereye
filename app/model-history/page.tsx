"use client";
import React, { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, rr } from '@/components/setups/parts';

/**
 * Model history: month by month, the model behind Algo Live's strategy (/api/algo/history).
 * Each month the model is trained again on the months before its 3 "bar months", and the bar (the least predicted R a
 * stock needs to be traded) is the one that made the most on those 3 months. The settings never change; what changes is
 * what the trees learned from the newer data (the facts they lean on) and the bar.
 */

interface Active { iteration: number | null; name: string; month: string; runAt: string | null }
interface BtMonth {
  month: string; thr: number | null; note: string; n: number; netR: number; sumR: number; hit: number; exam: boolean; shadow?: boolean;
  train?: [string, string]; val?: [string, string]; valN?: number; valR?: number | null; valSum?: number; facts?: [string, number][] | null; shares?: Record<string, number> | null;
}
interface LiveM {
  month: string; iteration: number | null; name: string; createdAt: number; runAt: string | null; dataTo: string | null;
  train: [string, string]; val: [string, string]; threshold: number | null; standAside: boolean; valTrades: number; valR: number | null; valDays: number;
  trees: number; factCount: number; facts: { f: string; label: string; share: number }[] | null; inUse: boolean;
  shares?: Record<string, number> | null; factLabels?: Record<string, string> | null;
}
interface Data {
  active: Active | null; strategy: string; source: { runId: string; iteration: number; createdAt: number; name?: string } | null;
  labels: Record<string, string>; months: BtMonth[]; live: LiveM[]; liveError: string | null;
}

const mon = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const span = (x?: [string, string]) => (x ? `${mon(x[0])}–${mon(x[1])}` : '–');
const tone = (x: number | null | undefined) => (x == null || !Number.isFinite(x) || x === 0 ? 'text-ink-2' : x > 0 ? 'text-data-green' : 'text-data-red-text');
const sum = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(1)}R`;

function Facts({ facts }: { facts: { label: string; share: number }[] }) {
  const top = facts[0]?.share || 1;
  return (
    <ol className="space-y-1">
      {facts.map((f, i) => (
        <li key={i} className="text-[11px]">
          <div className="flex justify-between gap-2"><span className="text-ink-2">{i + 1}. {f.label}</span><span className="font-mono text-ink-3">{Math.round(f.share * 100)}%</span></div>
          <div className="mt-0.5 h-1 rounded bg-line"><div className="h-1 rounded bg-brand-accent" style={{ width: `${(f.share / top) * 100}%` }} /></div>
        </li>
      ))}
    </ol>
  );
}

function LiveCard({ m }: { m: LiveM }) {
  return (
    <div className={`rounded-xl border p-3 ${m.inUse ? 'border-data-green/50 bg-data-green/5' : 'border-line'}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-black">{mon(m.month)} {m.inUse && <span className="ml-1 rounded bg-data-green/15 px-1.5 text-[9px] font-black uppercase tracking-widest text-data-green">Trading now</span>}</p>
        <p className="text-[11px] text-ink-3">Iteration {m.iteration ?? '?'} · {m.name}</p>
      </div>
      <p className="mt-1 text-sm">
        {m.standAside ? <b className="text-brand-accent">Stood aside: no bar made money on its bar months.</b>
          : <>Bar <b className="font-mono">{rr(m.threshold)}</b> · on its bar months: {m.valTrades} trades in {m.valDays} days, <b className={`font-mono ${tone(m.valR)}`}>{rr(m.valR)}</b> a trade</>}
      </p>
      <p className="mt-1 text-[11px] text-ink-3">Learned from {span(m.train)} · bar set on {span(m.val)} · {m.trees} trees reading {m.factCount} facts · data run {m.runAt ?? '–'}</p>
      <div className="mt-2">
        {m.facts?.length ? <><p className="mb-1 text-[10px] font-black uppercase tracking-widest text-ink-3">What it leans on most</p><Facts facts={m.facts} /></>
          : <p className="text-[11px] text-ink-3">Made before the model kept its facts: pressing Make this month&apos;s model on Algo Live again (same data, same model) adds them.</p>}
      </div>
    </div>
  );
}

function MonthRow({ m, labels, open, toggle }: { m: BtMonth; labels: Record<string, string>; open: boolean; toggle: () => void }) {
  const [all, setAll] = useState(false);
  const every = m.shares ? Object.entries(m.shares).sort((a, b) => b[1] - a[1]).map(([f, share]) => ({ label: labels[f] ?? f, share })) : [];
  const top = (m.facts ?? []).map(([f, share]) => ({ label: labels[f] ?? f, share }));
  const facts = all && every.length ? every : top;
  const stood = m.thr === null || !!m.note;
  return (
    <li className="border-b border-line/60">
      <button className="flex w-full items-center gap-2 py-2 text-left" onClick={toggle}>
        <span className="w-14 shrink-0 text-xs font-bold">{mon(m.month)}{m.exam && <span className="block text-[9px] font-black uppercase tracking-widest text-ink-3">exam</span>}</span>
        <span className="w-16 shrink-0 font-mono text-xs">{stood ? <span className="text-brand-accent">aside</span> : rr(m.thr)}</span>
        <span className="flex-1 font-mono text-xs text-ink-2">{m.n ? `${m.n} trades` : 'no trades'}</span>
        <span className={`w-16 shrink-0 text-right font-mono text-xs font-bold ${tone(m.n ? m.sumR : null)}`}>{m.n ? sum(m.sumR) : '–'}</span>
      </button>
      {open && (
        <div className="space-y-2 pb-3 pl-1 text-[11px]">
          <p className="text-ink-2">
            Learned from {span(m.train)} · bar set on {span(m.val)}.
            {m.valN !== undefined && !stood && <> On those bar months the bar took {m.valN} trades, <b className={`font-mono ${tone(m.valR)}`}>{rr(m.valR)}</b> a trade ({sum(m.valSum ?? 0)} in all).</>}
            {stood && <> {m.note || 'Stood aside.'}</>}
          </p>
          {!!m.n && <p className="text-ink-2">The month itself: {m.n} trades, <b className={`font-mono ${tone(m.netR)}`}>{rr(m.netR)}</b> a trade, {Math.round(m.hit * 100)}% hit, {sum(m.sumR)} in all.</p>}
          {facts.length ? <>
            <p className="text-[10px] font-black uppercase tracking-widest text-ink-3">{all ? `Every fact it used (${facts.length})` : 'What it leaned on most'}</p>
            <Facts facts={facts} />
            {every.length > top.length && <button className="text-[11px] font-bold text-brand-accent underline" onClick={() => setAll(!all)}>{all ? 'Show the top 10' : `Show all ${every.length} facts`}</button>}
          </>
            : <p className="text-ink-3">The facts per month are kept from the next backtest Re-run on.</p>}
        </div>
      )}
    </li>
  );
}

/** the chart's series colours: a fixed order, validated on the card surface (#16222F) for contrast and colour blindness */
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];
const MAX_LINES = SERIES.length;
const short = (s: string) => (s.length > 34 ? `${s.slice(0, 32)}…` : s);

/** each month's weights: the backtest month where it has them, else that month's live model */
function weightRows(d: Data) {
  const rows = new Map<string, Record<string, number>>();
  for (const m of d.months) if (m.shares) rows.set(m.month, m.shares);
  for (const m of d.live) if (m.shares && !rows.has(m.month)) rows.set(m.month, m.shares);
  return [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function WeightChart({ d, labels }: { d: Data; labels: Record<string, string> }) {
  const rows = useMemo(() => weightRows(d), [d]);
  // facts by their average weight over every month (0 where a month left it out)
  const ranked = useMemo(() => {
    const tot = new Map<string, number>();
    for (const [, sh] of rows) for (const [f, v] of Object.entries(sh)) tot.set(f, (tot.get(f) ?? 0) + v);
    return [...tot.entries()].map(([f, t]) => ({ f, avg: t / Math.max(1, rows.length) })).sort((a, b) => b.avg - a.avg);
  }, [rows]);
  // a colour belongs to a fact while it is picked (never repainted when another is added or removed)
  const [slots, setSlots] = useState<(string | null)[] | null>(null);
  const [all, setAll] = useState(false);
  const picked = slots ?? Array.from({ length: MAX_LINES }, (_, i) => ranked[i]?.f ?? null);
  const toggle = (f: string) => {
    const cur = [...picked];
    const at = cur.indexOf(f);
    if (at >= 0) cur[at] = null;
    else { const free = cur.indexOf(null); if (free < 0) return; cur[free] = f; }
    setSlots(cur);
  };
  if (rows.length < 2) {
    return <p className="text-xs text-ink-3">The chart needs the weights of at least 2 months. They are kept from the next backtest Re-run on (every month at once), and for live models from the next Make this month&apos;s model.</p>;
  }
  const data = rows.map(([month, sh]) => ({ month: mon(month), ...Object.fromEntries(picked.filter((f): f is string => !!f).map((f) => [f, Math.round((sh[f] ?? 0) * 1000) / 10])) }));
  const full = picked.every((x) => x);
  const shown = all ? ranked : ranked.slice(0, 15);
  return (
    <>
      <div className="h-72 -mx-2">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
            <XAxis dataKey="month" stroke="var(--ink-4)" fontSize={10} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis stroke="var(--ink-4)" fontSize={10} tickLine={false} axisLine={false} unit="%" width={44} />
            <Tooltip
              cursor={{ stroke: 'var(--ink-3)', strokeWidth: 1 }}
              contentStyle={{ background: '#16222F', border: '1px solid var(--line)', borderRadius: 8, fontSize: 11 }}
              labelStyle={{ color: 'var(--ink)', fontWeight: 700 }} itemStyle={{ color: 'var(--ink-2)' }}
              formatter={(v, name) => [`${v}%`, short(labels[String(name)] ?? String(name))]}
              itemSorter={(x) => -(Number(x.value) || 0)}
            />
            <Legend formatter={(name) => <span className="text-[10px] text-ink-2">{short(labels[String(name)] ?? String(name))}</span>} iconType="plainline" wrapperStyle={{ fontSize: 10 }} />
            {picked.map((f, i) => f && <Line key={f} type="monotone" dataKey={f} stroke={SERIES[i]} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: SERIES[i] }} activeDot={{ r: 4, stroke: '#16222F', strokeWidth: 2 }} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] text-ink-3">Pick up to {MAX_LINES} facts to plot ({full ? 'untick one to add another' : `${picked.filter(Boolean).length} picked`}). Ordered by their average weight over all months.</p>
      <div className="flex flex-wrap gap-1.5">
        {shown.map(({ f, avg }) => {
          const i = picked.indexOf(f);
          return (
            <button key={f} onClick={() => toggle(f)} disabled={i < 0 && full}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] disabled:opacity-40 ${i >= 0 ? 'border-ink-3 text-ink' : 'border-line text-ink-2'}`}>
              {i >= 0 && <span className="h-2 w-2 rounded-full" style={{ background: SERIES[i] }} />}
              {short(labels[f] ?? f)} <span className="font-mono text-ink-3">{Math.round(avg * 1000) / 10}%</span>
            </button>
          );
        })}
      </div>
      {ranked.length > 15 && <button className="text-[11px] font-bold text-brand-accent underline" onClick={() => setAll(!all)}>{all ? 'Show the top 15' : `Show all ${ranked.length} facts`}</button>}
    </>
  );
}

function BarChart({ d }: { d: Data }) {
  const rows = new Map<string, number | null>();
  for (const m of d.months) rows.set(m.month, m.thr === null || m.note ? null : m.thr);
  for (const m of d.live) if (!rows.has(m.month)) rows.set(m.month, m.standAside ? null : m.threshold);
  const data = [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, thr]) => ({ month: mon(month), bar: thr }));
  if (data.length < 2) return null;
  return (
    <div className="h-44 -mx-2">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
          <XAxis dataKey="month" stroke="var(--ink-4)" fontSize={10} tickLine={false} axisLine={false} minTickGap={16} />
          <YAxis stroke="var(--ink-4)" fontSize={10} tickLine={false} axisLine={false} unit="R" width={44} />
          <Tooltip cursor={{ stroke: 'var(--ink-3)', strokeWidth: 1 }}
            contentStyle={{ background: '#16222F', border: '1px solid var(--line)', borderRadius: 8, fontSize: 11 }}
            labelStyle={{ color: 'var(--ink)', fontWeight: 700 }} itemStyle={{ color: 'var(--ink-2)' }}
            formatter={(v) => [v == null ? 'stood aside' : rr(Number(v)), 'Bar']} />
          <Line type="monotone" dataKey="bar" stroke={SERIES[3]} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: SERIES[3] }} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function ModelHistoryPage() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/algo/history', { cache: 'no-store' }).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setD(j);
    }).catch((e) => setErr((e as Error).message));
  }, []);
  const months = d ? [...d.months].reverse() : [];
  const labels = useMemo(() => ({ ...Object.assign({}, ...(d?.live ?? []).map((m) => m.factLabels ?? {})), ...(d?.labels ?? {}) }) as Record<string, string>, [d]);
  const traded = d?.months.filter((m) => m.n > 0) ?? [];
  const green = traded.filter((m) => m.sumR > 0).length;
  const bars = d?.months.map((m) => m.thr).filter((x): x is number => x !== null) ?? [];
  return (
    <div className="min-h-screen bg-brand-bg text-ink font-sans pb-24">
      <div className="page-shell pt-6 space-y-4">
        <header className="border-b border-line pb-3">
          <h1 className="text-2xl font-black tracking-tighter">Model history</h1>
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-ink-3">Month by month: what the model learned, its bar, and how it went</p>
        </header>
        {err && <p className="text-xs text-data-red-text">{err}</p>}
        {!d && !err && <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>}
        {d && (
          <>
            <Card title="How it works" sub="The same every month">
              <p className="text-xs text-ink-2">
                The settings never change (the kind of model, how many trees, how deep). Each month only two things are made again from newer data:
                the <b>trees</b> (which of the facts about a stock matter, and at what levels) and the <b>bar</b> (the least predicted R a stock needs to be shorted:
                the one that made the most on the 3 months just before). Algo Live trades iteration {d.active?.iteration ?? '?'}{d.active ? `: ${d.active.name}` : ''}.
              </p>
            </Card>

            <Card title="How each fact's weight moved" sub="Weight = the share of the model's decisions that came from that fact that month (all facts add up to 100%). A rising line: the model leaned on it more. Tap a point for the month's numbers.">
              <WeightChart d={d} labels={labels} />
            </Card>

            <Card title="The bar, month by month" sub="The least predicted R a stock needed to be shorted that month. A gap is a month it stood aside.">
              <BarChart d={d} />
            </Card>

            <Card title="Live months" sub="Every model Algo Live has traded, newest first.">
              {d.liveError && <p className="text-[11px] text-data-red-text">Could not list the live models: {d.liveError}</p>}
              {!d.live.length && !d.liveError && <p className="text-xs text-ink-3">No live model kept yet.</p>}
              <div className="space-y-3">{d.live.map((m) => <LiveCard key={`${m.month}${m.createdAt}`} m={m} />)}</div>
            </Card>

            <Card title="Backtest, month by month"
              sub={d.source ? `${d.source.name ?? d.strategy} as the walk-forward traded it, each month blind (backtest fills, after costs, ₹300 risk). From the iteration ${d.source.iteration} run of ${new Date(d.source.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}. Tap a month.` : 'No Algo Lab run has this strategy yet.'}>
              {traded.length > 0 && (
                <p className="text-xs text-ink-2">
                  {green} of {traded.length} traded months green · bar ranged {rr(Math.min(...bars))} to {rr(Math.max(...bars))} · stood aside {d.months.length - bars.length} of {d.months.length} months.
                </p>
              )}
              <div className="flex gap-2 border-b border-line pb-1 text-[10px] font-black uppercase tracking-widest text-ink-3">
                <span className="w-14">Month</span><span className="w-16">Bar</span><span className="flex-1">Trades</span><span className="w-16 text-right">Total</span>
              </div>
              <ul>{months.map((m) => <MonthRow key={m.month} m={m} labels={labels} open={open === m.month} toggle={() => setOpen(open === m.month ? null : m.month)} />)}</ul>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
