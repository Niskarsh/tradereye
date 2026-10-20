"use client";
import React from 'react';
import type { Stats } from '@/lib/setups/stats';

/** Small pieces of the My Setups page. */

export const pct = (x: number | undefined) => (x === undefined ? '–' : `${Math.round(x * 100)}%`);
export const rr = (x: number | undefined) => (x === undefined ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(2)}R`);

/** An honest one-word verdict for a set of numbers. */
export function verdict(s: Stats | undefined, minHit: number): { label: string; tone: 'good' | 'ok' | 'bad' | 'thin' } {
  if (!s || s.n < 50) return { label: 'Too few', tone: 'thin' };
  if (s.netR <= 0) return { label: 'Loses money', tone: 'bad' };
  const steady = s.h1.n >= 20 && s.h2.n >= 20 && Math.min(s.h1.hit, s.h2.hit) >= minHit - 0.1;
  if (s.hit >= minHit && steady) return { label: 'Alert-worthy', tone: 'good' };
  return { label: steady ? 'Makes money' : 'Unsteady', tone: 'ok' };
}

const TONE = {
  good: 'border-data-green/60 text-data-green',
  ok: 'border-brand-accent/50 text-brand-accent',
  bad: 'border-data-red/60 text-data-red-text',
  thin: 'border-line-strong text-ink-3',
};
export function Verdict({ s, minHit }: { s: Stats | undefined; minHit: number }) {
  const v = verdict(s, minHit);
  return <span className={`inline-block whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide ${TONE[v.tone]}`}>{v.label}</span>;
}

/** Hit rate change vs the previous run, in points. */
export function Delta({ now, before }: { now?: Stats; before?: Stats }) {
  if (!now || !before || now.n < 50 || before.n < 50) return <span className="text-ink-4">–</span>;
  const d = Math.round((now.hit - before.hit) * 100);
  if (d === 0) return <span className="text-ink-3">0</span>;
  return <span className={d > 0 ? 'text-data-green' : 'text-data-red-text'}>{d > 0 ? '▲' : '▼'}{Math.abs(d)}</span>;
}

/** One row of numbers: trades, hit rate, R after charges, both halves. */
export function StatCells({ s, dim = false }: { s?: Stats; dim?: boolean }) {
  const thin = !s || s.n < 50;
  const cls = `px-2 py-1.5 text-right font-mono tabular-nums ${thin || dim ? 'text-ink-3' : ''}`;
  return (
    <>
      <td className={cls}>{s?.n ?? 0}</td>
      <td className={`${cls} font-bold`}>{pct(s?.hit)}</td>
      <td className={`${cls} ${!thin && s ? (s.netR > 0 ? 'text-data-green' : 'text-data-red-text') : ''}`}>{rr(s?.netR)}</td>
      <td className={`${cls} hidden sm:table-cell`}>{s ? `${pct(s.h1.hit)} / ${pct(s.h2.hit)}` : '–'}</td>
    </>
  );
}

export function StatHead({ first }: { first: string }) {
  return (
    <thead>
      <tr className="border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3">
        <th className="px-2 py-1.5 text-left">{first}</th>
        <th className="px-2 py-1.5 text-right">Trades</th>
        <th className="px-2 py-1.5 text-right">Hit</th>
        <th className="px-2 py-1.5 text-right">R after costs</th>
        <th className="hidden px-2 py-1.5 text-right sm:table-cell">1st / 2nd half</th>
      </tr>
    </thead>
  );
}

export function Card({ title, sub, children, right }: { title: string; sub?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-brand-card p-4 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-black tracking-tight">{title}</h2>
          {sub && <p className="text-[11px] text-ink-3">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}
