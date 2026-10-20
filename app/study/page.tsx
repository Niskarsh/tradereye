"use client";
import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { Card, pct, rr } from '@/components/setups/parts';
import type { ComboStudy, Outcomes, Study } from '@/lib/study/analyze';
import type { RunIndexItem } from '@/lib/setups/store';

/**
 * Reversal Study: no rules decided in advance. Every moment that could have been a reversal entry in two years is
 * labelled with what happened next (clean win / messy win / failure); the facts that separate winners from failures
 * are found, rules are searched on year 1, and every rule is traded on year 2, which the search never saw.
 */

const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const inr = (x: number) => `${x < 0 ? '−' : '+'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;
const band = (lo: number, hi: number) => (hi === Infinity ? `${lo}+` : `${lo}–${hi}`);
const num = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));

export default function StudyPage() {
  const [data, setData] = useState<{ runs: RunIndexItem[]; study: Study | null } | null>(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState(0);
  useEffect(() => {
    fetch('/api/study').then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`); setData(j); }).catch((e) => setErr((e as Error).message));
  }, []);
  const s = data?.study;
  const c = s?.combos[pick];
  // months in year 2 (from the middle of the period to its end): for ₹ per month
  const months2 = s ? Math.max(1, (Date.parse(s.period.to) - Date.parse(s.period.mid)) / (30.44 * 86400_000)) : 12;

  return (
    <div className="min-h-screen bg-brand-bg text-ink font-sans pb-24">
      <div className="page-shell pt-6 space-y-4">
        <header className="border-b border-line pb-3">
          <h1 className="text-2xl font-black tracking-tighter">Reversal Study</h1>
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-ink-3">The moves first, then the rules · found on year 1 · proven or not on year 2</p>
        </header>
        {err && <p className="text-xs text-data-red-text">{err}</p>}
        {!data && !err && <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>}
        {data && !s && (
          <Card title="No study yet" sub="It is made by the backtest run: press Re-run on My Analysis → My Setups. It uses the same saved candles, so it adds only a few minutes." >
            <span />
          </Card>
        )}
        {s && c && (
          <>
            <p className="text-[11px] text-ink-3">
              {fmtDate(s.period.from)} – {fmtDate(s.period.to)} · year 1 until {fmtDate(s.period.mid)}, year 2 after · {s.moments.toLocaleString('en-IN')} possible entries.
              Every 10-min close where the stock was down from the open (up, for shorts), still on the far side of VWAP and within 1.5 ATR of its low, is a possible entry: stop 0.1 ATR beyond the low, target VWAP or the open.
              Clean = target before the stop. Messy = the stop went first, but price got there later. Failure = never got there by 15:00. Every number below includes the failures.
            </p>
            <div className="flex flex-wrap gap-2">
              {s.combos.map((x, i) => (
                <button key={i} onClick={() => setPick(i)}
                  className={`h-9 rounded-xl border px-3 text-xs font-black ${i === pick ? 'border-brand-accent bg-brand-accent/15 text-brand-accent' : 'border-line-strong text-ink-2'}`}>
                  {x.dir === 'LONG' ? 'Long' : 'Short'} → {x.target === 'VWAP' ? 'VWAP' : 'the open'}
                </button>
              ))}
            </div>
            <Moves c={c} />
            <Rules c={c} months2={months2} />
            <Drop c={c} />
            <Facts c={c} />
          </>
        )}
      </div>
    </div>
  );
}

function OutRow({ label, o, extra }: { label: React.ReactNode; o: Outcomes; extra?: React.ReactNode }) {
  return (
    <tr className="border-b border-line/60 font-mono tabular-nums">
      <td className="px-2 py-1.5 font-sans">{label}</td>
      <td className="px-2 py-1.5 text-right">{o.n}</td>
      <td className="px-2 py-1.5 text-right font-bold text-data-green">{pct(o.clean)}</td>
      <td className="px-2 py-1.5 text-right text-ink-2">{pct(o.messy)}</td>
      <td className="px-2 py-1.5 text-right text-data-red-text">{pct(o.fail)}</td>
      <td className="hidden px-2 py-1.5 text-right sm:table-cell">{rr(o.grossR)}</td>
      <td className={`px-2 py-1.5 text-right ${o.netR > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{rr(o.netR)}</td>
      {extra}
    </tr>
  );
}
const OutHead = ({ first, extra }: { first: string; extra?: React.ReactNode }) => (
  <thead>
    <tr className="border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3">
      <th className="px-2 py-1.5 text-left">{first}</th><th className="px-2 py-1.5 text-right">Trades</th>
      <th className="px-2 py-1.5 text-right">Clean</th><th className="px-2 py-1.5 text-right">Messy</th><th className="px-2 py-1.5 text-right">Fail</th>
      <th className="hidden px-2 py-1.5 text-right sm:table-cell">R before</th><th className="px-2 py-1.5 text-right">R after costs</th>{extra}
    </tr>
  </thead>
);

function Moves({ c }: { c: ComboStudy }) {
  const m = c.moves;
  return (
    <Card title="The moves" sub="What was there to capture, before any rule.">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Stock-days with a possible entry', m.stockDays.toLocaleString('en-IN')],
          ['…with a clean reversal at some point', `${m.withClean.toLocaleString('en-IN')} (${pct(m.withClean / Math.max(1, m.stockDays))})`],
          ['Typical fall before a clean turn', `${m.dropBeforeClean.p25}–${m.dropBeforeClean.p75}× daily range`],
          ['…in %', `${m.dropPctBeforeClean.p25}–${m.dropPctBeforeClean.p75}% (middle ${m.dropPctBeforeClean.p50}%)`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-line bg-brand-bg px-3 py-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-ink-3">{k}</p>
            <p className="font-mono text-sm font-bold">{v}</p>
          </div>
        ))}
      </div>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-[520px] text-xs">
          <OutHead first="Taking every possible entry (first of each day)" />
          <tbody>
            <OutRow label="Year 1" o={c.base.y1First} />
            <OutRow label="Year 2" o={c.base.y2First} />
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-ink-3">This is the baseline: what a rule has to beat. A rule is worth something only if it lifts the clean share and R after costs above these rows, on year 2.</p>
    </Card>
  );
}

function Rules({ c, months2 }: { c: ComboStudy; months2: number }) {
  const [open, setOpen] = useState<number | null>(null);
  const held = (o: Outcomes) => (o.n < 50 ? { t: 'Too few', cls: 'border-line-strong text-ink-3' } : o.netR > 0 ? { t: 'Held up', cls: 'border-data-green/60 text-data-green' } : { t: 'Did not hold', cls: 'border-data-red/60 text-data-red-text' });
  return (
    <Card title="Rules found on year 1, traded on year 2" sub="Each rule is the best combination of facts on year 1 (scored cautiously, failures included). Each next rule was searched on the days the earlier ones did not take. Year 2 was never seen by the search: it is the proof.">
      {!c.rules.length && <p className="text-xs text-ink-3">No combination of facts had enough trades on year 1.</p>}
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3">
              <th className="px-2 py-1.5 text-left">Rule</th>
              <th className="px-2 py-1.5 text-right">Y1 trades</th><th className="px-2 py-1.5 text-right">Y1 R</th>
              <th className="px-2 py-1.5 text-right">Y2 trades</th><th className="px-2 py-1.5 text-right">Y2 clean</th><th className="px-2 py-1.5 text-right">Y2 fail</th>
              <th className="px-2 py-1.5 text-right">Y2 R after costs</th><th className="px-2 py-1.5 text-right">Y2 ₹/month</th><th className="px-2 py-1.5 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {c.rules.map((r, i) => {
              const h = held(r.y2);
              return (
                <React.Fragment key={i}>
                  <tr onClick={() => setOpen(open === i ? null : i)} className="cursor-pointer border-b border-line/60 font-mono tabular-nums hover:bg-white/5">
                    <td className="px-2 py-1.5 font-sans">
                      <span className="flex items-start gap-1">
                        {open === i ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-accent" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" />}
                        <span className="flex flex-wrap gap-1">{r.text.split(' AND ').map((t) => <span key={t} className="rounded-md border border-line-strong px-1.5 py-0.5 text-[11px]">{t}</span>)}</span>
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right text-ink-3">{r.y1.n}</td>
                    <td className="px-2 py-1.5 text-right text-ink-3">{rr(r.y1.netR)}</td>
                    <td className="px-2 py-1.5 text-right">{r.y2.n}</td>
                    <td className="px-2 py-1.5 text-right font-bold text-data-green">{pct(r.y2.clean)}</td>
                    <td className="px-2 py-1.5 text-right text-data-red-text">{pct(r.y2.fail)}</td>
                    <td className={`px-2 py-1.5 text-right font-bold ${r.y2.netR > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{rr(r.y2.netR)}</td>
                    <td className={`px-2 py-1.5 text-right ${r.y2.netR > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{inr((r.y2.netR * 300 * r.y2.n) / months2)}</td>
                    <td className="px-2 py-1.5 text-right"><span className={`whitespace-nowrap rounded-md border px-1.5 py-0.5 font-sans text-[10px] font-black uppercase ${h.cls}`}>{h.t}</span></td>
                  </tr>
                  {open === i && (
                    <tr className="border-b border-line/60">
                      <td colSpan={9} className="px-2 pb-3 pt-1">
                        <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-ink-3">Latest year-2 trades of this rule (check them on your chart)</p>
                        <table className="w-full text-[11px]"><tbody>
                          {r.examples.map((e) => (
                            <tr key={`${e.symbol}${e.date}${e.time}`} className="font-mono">
                              <td className="px-1 py-0.5 text-ink-3">{e.date} {e.time}</td><td className="px-1 py-0.5 font-bold">{e.symbol}</td>
                              <td className="px-1 py-0.5">@ {e.entry} · stop {e.stop} · target {e.target}</td>
                              <td className={`px-1 py-0.5 text-right ${e.net > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{e.label === 'C' ? 'clean' : e.label === 'M' ? 'messy' : 'fail'} {rr(e.net)}</td>
                            </tr>
                          ))}
                        </tbody></table>
                        <p className="mt-1 text-[11px] text-ink-3">With a 2 ATR stop instead of the low: {rr(r.y2.netWide)} per trade on year 2 (catches some of the messy ones). Average {r.y2.min} min in the trade.</p>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {c.rules.length > 1 && (
              <tr className="font-mono tabular-nums">
                <td className="px-2 py-1.5 font-sans font-black">All rules together</td>
                <td className="px-2 py-1.5 text-right text-ink-3">{c.together.y1.n}</td><td className="px-2 py-1.5 text-right text-ink-3">{rr(c.together.y1.netR)}</td>
                <td className="px-2 py-1.5 text-right">{c.together.y2.n}</td><td className="px-2 py-1.5 text-right font-bold text-data-green">{pct(c.together.y2.clean)}</td>
                <td className="px-2 py-1.5 text-right text-data-red-text">{pct(c.together.y2.fail)}</td>
                <td className={`px-2 py-1.5 text-right font-black ${c.together.y2.netR > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{rr(c.together.y2.netR)}</td>
                <td className={`px-2 py-1.5 text-right font-black ${c.together.y2.netR > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{inr((c.together.y2.netR * 300 * c.together.y2.n) / months2)}</td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {c.common.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-ink-3">What the rules have in common</p>
          <div className="flex flex-wrap gap-1.5">
            {c.common.map((x) => <span key={x.f} className="rounded-md border border-line-strong px-2 py-1 text-[11px]">{x.label} <b className="font-mono text-brand-accent">×{x.rules}</b></span>)}
          </div>
        </div>
      )}
    </Card>
  );
}

function Drop({ c }: { c: ComboStudy }) {
  return (
    <Card title="How far it fell before the entry" sub="The fall from the open to the low, in the stock's usual daily range. Read from the data: where reversals actually paid, failures included.">
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <OutHead first="Fall (× daily range) · year 1" extra={<th className="px-2 py-1.5 text-right">Y2 R after costs</th>} />
          <tbody>
            {c.drop.map((d) => (
              <OutRow key={d.lo} label={<span className={c.bestDrop && d.lo >= c.bestDrop.lo && d.hi <= c.bestDrop.hi ? 'font-bold text-brand-accent' : ''}>{band(d.lo, d.hi)}</span>} o={d.y1}
                extra={<td className={`px-2 py-1.5 text-right ${d.y2.netR > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{d.y2.n ? rr(d.y2.netR) : '–'}</td>} />
            ))}
          </tbody>
        </table>
      </div>
      {c.bestDrop && (
        <p className="text-[11px] text-ink-2">Best range on year 1: a fall of <b>{band(c.bestDrop.lo, c.bestDrop.hi)}×</b> the daily range ({rr(c.bestDrop.y1.netR)} on {c.bestDrop.y1.n} trades). On year 2 the same range made <b className={c.bestDrop.y2.netR > 0 ? 'text-data-green' : 'text-data-red-text'}>{rr(c.bestDrop.y2.netR)}</b> on {c.bestDrop.y2.n} trades.</p>
      )}
    </Card>
  );
}

function Facts({ c }: { c: ComboStudy }) {
  const [all, setAll] = useState(false);
  const list = useMemo(() => (all ? c.features : c.features.slice(0, 10)), [all, c.features]);
  return (
    <Card title="Every fact, winners vs failures" sub="Each fact split into five equal groups (on year 1). For each group: how often it was a clean win, a messy win or a failure, and R after costs; year 2 on the right. Sorted by how much the fact changes R.">
      <div className="grid gap-4 lg:grid-cols-2">
        {list.map((f) => (
          <div key={f.f}>
            <p className="mb-1 text-[11px] font-bold">{f.label}</p>
            <div className="-mx-2 overflow-x-auto">
              <table className="w-full text-[11px]">
                <OutHead first="Value" extra={<th className="px-2 py-1.5 text-right">Y2 R</th>} />
                <tbody>
                  {f.bins.map((b) => (
                    <OutRow key={`${b.lo}`} o={b.y1}
                      label={b.lo === -Infinity ? `< ${num(b.hi)}` : b.hi === Infinity ? `≥ ${num(b.lo)}` : `${num(b.lo)} – ${num(b.hi)}`}
                      extra={<td className={`px-2 py-1.5 text-right ${b.y2.netR > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{b.y2.n ? rr(b.y2.netR) : '–'}</td>} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
      {c.features.length > 10 && <button onClick={() => setAll(!all)} className="text-[11px] font-bold text-brand-accent">{all ? 'Show the top 10' : `Show all ${c.features.length} facts`}</button>}
    </Card>
  );
}
