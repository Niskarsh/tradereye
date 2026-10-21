"use client";
import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Card, pct, rr } from '@/components/setups/parts';

/**
 * Algo Lab: walk-forward machine learning on every 10-min close of every stock in his price range
 * (scripts/ml_walkforward.py). Every trade shown was predicted by a model trained only on earlier months.
 */

interface S { n: number; hit: number; netR: number; sumR: number; inr: number; t: number }
interface Month extends S { month: string; thr: number | null; note: string; baseL: number; baseS: number }
interface Ml {
  v: 1; runId: string; createdAt: number; period: { from: string; to: string }; rows: number; stocks: number; days: number;
  setup: { stopAtr: number; targetAtr: number; trainMonths: number; valMonths: number; maxPerDay: number; riskInr: number };
  baseline: { long: number; short: number };
  overall: S & { gross: number; monthsGreen: number; monthsTraded: number; monthsTotal: number; maxDrawdownR: number; inrPerMonth: number };
  bySide: { long: S; short: S }; byHour: (S & { hour: string })[]; months: Month[];
  importance: { f: string; label: string; share: number }[];
  liked: { side: string; f: string; label: string; z: number; taken: number; all: number }[];
  recent: { day: string; sym: string; time: string; side: string; pred: number; net: number }[];
}

const inr = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${x < 0 ? '−' : '+'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`);
const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const mon = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });

/** the honest one-line verdict */
function verdict(o: Ml['overall']): { text: string; tone: string } {
  if (o.n < 100) return { text: 'Not enough trades to judge.', tone: 'border-line-strong text-ink-2' };
  if (o.netR > 0 && o.t >= 2 && o.monthsGreen >= 0.6 * o.monthsTraded) return { text: 'An edge: profitable after costs out of sample, sure enough (t ≥ 2), and green most months. Worth paper-trading next.', tone: 'border-data-green/60 bg-data-green/10 text-data-green' };
  if (o.netR > 0) return { text: 'Slightly profitable out of sample, but not sure enough yet (t under 2 or too many red months). Could be luck.', tone: 'border-brand-accent/60 bg-brand-accent/10 text-brand-accent' };
  return { text: 'No edge: out of sample, the model\'s trades lose money after costs. Candle and volume data alone do not beat the charges.', tone: 'border-data-red/60 bg-data-red/10 text-data-red-text' };
}

export default function AlgoPage() {
  const [ml, setMl] = useState<Ml | null | undefined>(undefined);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/algo').then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`); setMl(j.ml); }).catch((e) => setErr((e as Error).message));
  }, []);
  const o = ml?.overall;
  const v = o ? verdict(o) : undefined;
  return (
    <div className="min-h-screen bg-brand-bg text-ink font-sans pb-24">
      <div className="page-shell pt-6 space-y-4">
        <header className="border-b border-line pb-3">
          <h1 className="text-2xl font-black tracking-tighter">Algo Lab</h1>
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-ink-3">Machine learning on every stock, every 10 minutes · trained on the past, tested month by month on what it had not seen</p>
        </header>
        {err && <p className="text-xs text-data-red-text">{err}</p>}
        {ml === undefined && !err && <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>}
        {ml === null && <Card title="No results yet" sub="Made by the backtest run: press Re-run on My Analysis → My Setups. The model step adds 30–60 minutes after the backtest."><span /></Card>}
        {ml && o && v && (
          <>
            <p className={`rounded-xl border px-3 py-2 text-sm font-bold ${v.tone}`}>{v.text}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ['Out-of-sample trades', o.n.toLocaleString('en-IN')],
                ['R per trade after costs', rr(o.netR)],
                ['How sure (t)', o.t.toFixed(1)],
                ['Months green', `${o.monthsGreen} of ${o.monthsTraded}`],
                ['Total, at ₹300 risk', inr(o.inr)],
                ['Per month, on average', inr(o.inrPerMonth)],
                ['Made money after costs', pct(o.hit)],
                ['Worst drop (R)', `−${o.maxDrawdownR}R`],
              ].map(([k, val]) => (
                <div key={k} className="rounded-xl border border-line bg-brand-card px-3 py-2">
                  <p className="text-[10px] font-black uppercase tracking-widest text-ink-3">{k}</p>
                  <p className="font-mono text-sm font-bold">{val}</p>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-ink-3">
              {fmtDate(ml.period.from)} – {fmtDate(ml.period.to)} · {ml.stocks} stocks · {ml.rows.toLocaleString('en-IN')} moments (every 10-min close 09:35–14:45).
              Each moment&apos;s trade: entry 1 tick worse than the close, stop {ml.setup.stopAtr} ATR, target {ml.setup.targetAtr} ATR, out by 15:00, Dhan&apos;s charges at ₹{ml.setup.riskInr} risk.
              For each month the models were trained on the {ml.setup.trainMonths} months before it, the bar to trade was set on the {ml.setup.valMonths} months before it, and the month was traded blind: one trade per stock per day at most, {ml.setup.maxPerDay} a day at most.
              Taking every moment blindly makes {rr(ml.baseline.long)} (long) / {rr(ml.baseline.short)} (short) per trade; that is what the model has to beat.
            </p>

            <Card title="Month by month (every month traded blind)" sub="Green months after costs. A real edge is green most months, not just one big month.">
              <div className="-mx-2 overflow-x-auto">
                <table className="w-full min-w-[520px] text-xs">
                  <thead><tr className="border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3">
                    <th className="px-2 py-1.5 text-left">Month</th><th className="px-2 py-1.5 text-right">Trades</th><th className="px-2 py-1.5 text-right">Made money</th>
                    <th className="px-2 py-1.5 text-right">R per trade</th><th className="px-2 py-1.5 text-right">Total R</th><th className="px-2 py-1.5 text-right">₹ at ₹300 risk</th><th className="px-2 py-1.5 text-left"></th>
                  </tr></thead>
                  <tbody>
                    {ml.months.map((m) => (
                      <tr key={m.month} className="border-b border-line/60 font-mono tabular-nums">
                        <td className="px-2 py-1.5 font-sans">{mon(m.month)}</td>
                        <td className="px-2 py-1.5 text-right">{m.n}</td>
                        <td className="px-2 py-1.5 text-right">{m.n ? pct(m.hit) : '–'}</td>
                        <td className={`px-2 py-1.5 text-right ${m.netR > 0 ? 'text-data-green' : m.n ? 'text-data-red-text' : 'text-ink-3'}`}>{m.n ? rr(m.netR) : '–'}</td>
                        <td className={`px-2 py-1.5 text-right ${m.sumR > 0 ? 'text-data-green' : m.n ? 'text-data-red-text' : 'text-ink-3'}`}>{m.n ? `${m.sumR > 0 ? '+' : ''}${m.sumR.toFixed(1)}R` : '–'}</td>
                        <td className={`px-2 py-1.5 text-right font-bold ${m.inr > 0 ? 'text-data-green' : m.n ? 'text-data-red-text' : 'text-ink-3'}`}>{m.n ? inr(m.inr) : '–'}</td>
                        <td className="px-2 py-1.5 font-sans text-[10px] text-ink-3">{m.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="By side and time of day" sub="Out of sample. Where the model's trades made or lost money.">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3"><th className="px-2 py-1.5 text-left"></th><th className="px-2 py-1.5 text-right">Trades</th><th className="px-2 py-1.5 text-right">R per trade</th><th className="px-2 py-1.5 text-right">t</th><th className="px-2 py-1.5 text-right">₹</th></tr></thead>
                  <tbody>
                    {[['Longs', ml.bySide.long], ['Shorts', ml.bySide.short], ...ml.byHour.map((h) => [`From ${h.hour}`, h] as const)].map(([k, s]) => (
                      <tr key={k as string} className="border-b border-line/60 font-mono tabular-nums">
                        <td className="px-2 py-1.5 font-sans">{k as string}</td><td className="px-2 py-1.5 text-right">{(s as S).n}</td>
                        <td className={`px-2 py-1.5 text-right ${(s as S).netR > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{rr((s as S).netR)}</td>
                        <td className="px-2 py-1.5 text-right">{(s as S).t.toFixed(1)}</td><td className="px-2 py-1.5 text-right">{inr((s as S).inr)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              <Card title="What the model leans on" sub="Each fact's share of how much the model's trees improved their predictions.">
                <ol className="space-y-1 text-xs">
                  {ml.importance.map((x, i) => (
                    <li key={x.f} className="flex items-center gap-2">
                      <span className="w-5 text-right font-mono text-ink-3">{i + 1}</span>
                      <span className="flex-1">{x.label}</span>
                      <span className="h-1.5 rounded-full bg-brand-accent" style={{ width: `${Math.round(x.share * 400)}px` }} />
                      <span className="w-12 text-right font-mono text-ink-3">{pct(x.share)}</span>
                    </li>
                  ))}
                </ol>
              </Card>
            </div>

            <Card title="What its trades look like" sub="How the moments the model chose differ from all moments (in standard deviations; + = higher than usual). This is the pattern in plain facts.">
              <div className="-mx-2 overflow-x-auto">
                <table className="w-full min-w-[520px] text-xs">
                  <thead><tr className="border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3"><th className="px-2 py-1.5 text-left">Side</th><th className="px-2 py-1.5 text-left">Fact</th><th className="px-2 py-1.5 text-right">Difference</th><th className="px-2 py-1.5 text-right">Its trades (median)</th><th className="px-2 py-1.5 text-right">All moments (median)</th></tr></thead>
                  <tbody>
                    {ml.liked.map((x) => (
                      <tr key={`${x.side}${x.f}`} className="border-b border-line/60 font-mono tabular-nums">
                        <td className="px-2 py-1.5 font-sans">{x.side}</td><td className="px-2 py-1.5 font-sans">{x.label}</td>
                        <td className={`px-2 py-1.5 text-right ${x.z > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{x.z > 0 ? '+' : ''}{x.z.toFixed(2)}</td>
                        <td className="px-2 py-1.5 text-right">{x.taken}</td><td className="px-2 py-1.5 text-right text-ink-3">{x.all}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="Its latest trades" sub="Check them on your chart: these were picked by a model that had not seen that month.">
              <table className="w-full text-[11px]"><tbody>
                {ml.recent.slice().reverse().map((t, i) => (
                  <tr key={i} className="border-b border-line/40 font-mono">
                    <td className="px-1 py-1 text-ink-3">{t.day} {t.time}</td><td className="px-1 py-1 font-bold">{t.sym}</td>
                    <td className={`px-1 py-1 ${t.side === 'LONG' ? 'text-data-green' : 'text-data-red-text'}`}>{t.side}</td>
                    <td className="px-1 py-1 text-ink-3">predicted {rr(t.pred)}</td>
                    <td className={`px-1 py-1 text-right ${t.net > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{rr(t.net)}</td>
                  </tr>
                ))}
              </tbody></table>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
