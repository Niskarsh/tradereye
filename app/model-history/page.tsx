"use client";
import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
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
  train?: [string, string]; val?: [string, string]; valN?: number; valR?: number | null; valSum?: number; facts?: [string, number][] | null;
}
interface LiveM {
  month: string; iteration: number | null; name: string; createdAt: number; runAt: string | null; dataTo: string | null;
  train: [string, string]; val: [string, string]; threshold: number | null; standAside: boolean; valTrades: number; valR: number | null; valDays: number;
  trees: number; factCount: number; facts: { f: string; label: string; share: number }[] | null; inUse: boolean;
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
  const facts = (m.facts ?? []).map(([f, share]) => ({ label: labels[f] ?? f, share }));
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
          {facts.length ? <><p className="text-[10px] font-black uppercase tracking-widest text-ink-3">What it leaned on most</p><Facts facts={facts} /></>
            : <p className="text-ink-3">The facts per month are kept from the next backtest Re-run on.</p>}
        </div>
      )}
    </li>
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
              <ul>{months.map((m) => <MonthRow key={m.month} m={m} labels={d.labels} open={open === m.month} toggle={() => setOpen(open === m.month ? null : m.month)} />)}</ul>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
