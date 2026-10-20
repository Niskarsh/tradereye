"use client";
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, HelpCircle, Loader2, Sparkles } from 'lucide-react';
import { Card, pct, rr } from '@/components/setups/parts';
import type { ComboStudy, Outcomes, Study } from '@/lib/study/analyze';
import type { RunIndexItem } from '@/lib/setups/store';

/**
 * Reversal Study: no rules decided in advance. Every moment that could have been a reversal entry in two years is
 * labelled with what happened next (clean win / messy win / failure); the facts that separate winners from failures
 * are found, rules are searched on year 1, and every rule is traded on year 2, which the search never saw.
 */

const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
// saved through JSON: Infinity / -Infinity / NaN arrive as null
const ok = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);
const inr = (x: number | null) => (ok(x) ? `${x < 0 ? '−' : '+'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}` : '–');
const band = (lo: number | null, hi: number | null) => (!ok(hi) ? `${lo ?? 0}+` : `${lo ?? 0}–${hi}`);
const num = (x: number | null) => (!ok(x) ? '–' : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));
const show = (x: number | null | undefined) => (ok(x) ? String(x) : '–');

/* ---- "Explain this" (one Claude call per press; the numbers are taken from the saved study on the server) ---- */

const ExplainCtx = createContext<{ run: string; combo: number }>({ run: '', combo: 0 });
type Answer = { text?: string; err?: string; busy?: boolean; cost?: number };
const ANSWERS_KEY = 'tradereye-study-explain';
const loadAnswers = (): Record<string, Answer> => { try { return JSON.parse(localStorage.getItem(ANSWERS_KEY) ?? '{}'); } catch { return {}; } };

/**
 * A button that asks Claude to explain one part of the study like he is five, with a box for a follow-up question.
 * The answer is kept in this browser (per run and part), so opening the page again costs nothing.
 */
function Explain({ part, item, label = 'Explain this', small = false, combo: comboOverride }: { part: string; item?: number | string; label?: string; small?: boolean; combo?: number }) {
  const ctx = useContext(ExplainCtx);
  const combo = comboOverride ?? ctx.combo;
  const key = `${ctx.run}|${part}|${part === 'overview' ? '' : combo}|${item ?? ''}`;
  const [a, setA] = useState<Answer | undefined>(undefined);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => { const saved = loadAnswers()[key]; setA(saved); setOpen(!!saved); }, [key]);
  const ask = async (question?: string) => {
    setA({ busy: true }); setOpen(true);
    try {
      const r = await fetch('/api/study/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run: ctx.run, part, combo, item, question }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      const ans = { text: question ? `Q: ${question}\n\n${j.text}` : j.text, cost: j.costInr };
      setA(ans); setQ('');
      try { const all = loadAnswers(); all[key] = ans; localStorage.setItem(ANSWERS_KEY, JSON.stringify(all)); } catch { /* ignore */ }
    } catch (e) { setA({ err: (e as Error).message }); }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => (a?.text && !open ? setOpen(true) : void ask())} disabled={a?.busy}
          className={`flex items-center gap-1 rounded-lg border border-brand-accent/60 font-black text-brand-accent hover:bg-brand-accent/10 disabled:opacity-50 ${small ? 'h-7 px-2 text-[11px]' : 'h-8 px-3 text-xs'}`}>
          {a?.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {a?.busy ? 'Claude is reading…' : a?.text && !open ? 'Show the explanation' : label}
        </button>
        {a?.text && open && <button onClick={() => void ask()} className="text-[11px] font-bold text-ink-3 hover:text-ink">Ask again</button>}
        {a?.text && open && <button onClick={() => setOpen(false)} className="text-[11px] font-bold text-ink-3 hover:text-ink">Hide</button>}
      </div>
      {open && a?.err && <p className="text-xs text-data-red-text">{a.err}</p>}
      {open && a?.text && (
        <div className="space-y-2 rounded-xl border border-brand-accent/30 bg-brand-bg p-3">
          <p className="whitespace-pre-line text-[13px] leading-relaxed text-ink">{a.text}</p>
          <p className="text-[10px] text-ink-3">{a.cost !== undefined ? `₹${a.cost.toFixed(2)} · ` : ''}from the saved numbers of this run</p>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim()) void ask(q.trim()); }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask a follow-up about this part…"
              className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-brand-card px-2 text-xs outline-none focus:border-brand-accent" />
            <button type="submit" disabled={!q.trim() || a?.busy} className="h-8 rounded-lg bg-brand-accent px-3 text-xs font-black text-brand-bg disabled:opacity-40">Ask</button>
          </form>
        </div>
      )}
    </div>
  );
}

/** What every number on this page means, in plain words. */
function Glossary() {
  const [open, setOpen] = useState(false);
  const items: [string, string][] = [
    ['Possible entry', 'A moment where a reversal trade could have been taken: a 10-minute candle closing while the stock is down from its open (up, for shorts), still below VWAP (above, for shorts) and close to its day low (high). Entry at that close.'],
    ['Stop and target', 'The stop sits just beyond the day\'s low (high) so far. The target is VWAP (as it was at entry) on the VWAP tabs, the day\'s open on the "open" tabs. Anything still open is closed at 15:00.'],
    ['Clean', 'Reached the target before touching the stop. This is the trade you want.'],
    ['Messy', 'Touched the stop first, then went to the target anyway. With a stop at the low you lose; a wider stop could have won. The "2 ATR stop" number shows that case.'],
    ['Fail', 'Never reached the target by 15:00. Failures are always counted: nothing is hidden.'],
    ['R', 'Your risk on the trade: ₹300. +1R = +₹300, −1R = −₹300. +0.10R per trade = +₹30 per trade on average.'],
    ['R before costs / after costs', 'Both already use the cautious fills (slippage). Before = before Dhan\'s charges: is there an edge at all. After = after Dhan\'s charges (brokerage, STT, exchange, SEBI, IPFT, stamp, GST) at your size. Only "after costs" decides if you make money.'],
    ['₹ / month', 'R after costs × ₹300 × trades per month: what it would have made if you took every trade the rule gave.'],
    ['Year 1 / Year 2', 'The two years are cut in half. Rules are searched only on year 1, so they always look good there. Year 2 was never seen by the search: it is the honest test. Trust year 2.'],
    ['Baseline', 'Taking every possible entry with no rule. A rule is only useful if it beats this on year 2.'],
    ['First of each day', 'A stock can give many possible entries in one day; only the first counts as the trade, like you would trade it.'],
    ['ATR', 'The stock\'s normal 10-minute candle size. "1.5 ATR" = one and a half normal candles.'],
    ['× daily range', 'Compared with how much the stock usually moves from high to low in a day. "Fell 0.6× daily range" = it fell 60% of its usual daily move.'],
    ['Five groups of a fact', 'Every value of a fact (say, volume) is sorted and cut into five equal piles. If one pile has many more clean wins and better R than the others, that fact matters.'],
    ['Held up / Green, could be luck / Did not hold', 'Held up = made money after charges on year 2, 50+ trades and t of 2 or more. Green, could be luck = made money on year 2 but t under 2. Did not hold = lost on year 2 (it was luck on year 1).'],
    ['t (how sure)', 'The average R after costs divided by how much it could wobble by chance. 2 or more: unlikely to be luck. 1–2: maybe. Under 1: could easily be luck. The more rules you look at, the more greens appear by luck, so prefer t of 2+.'],
    ['Year 1, year 2, both years', 'Each counted on its own. Year 2 is the rule applied to every day of year 2, not what was left after year 1. Both years = year 1 + year 2 together (flattered by year 1, where the rule was found).'],
    ['Fills (slippage)', 'Cautious, like live: you buy 1 tick (₹0.05) worse than the 10-min close, the stop fills 1 tick beyond the stop, the target fills only if price trades through it, stop and target in the same minute counts as the stop, and stops/targets sit on ₹0.05 ticks.'],
    ['Position', 'Rupees in the trade at ₹300 risk. A tight stop means a big position (₹300 ÷ a 30 paise stop = 1,000 shares ≈ ₹3 lakh), which needs intraday margin.'],
  ];
  return (
    <section className="rounded-2xl border border-line p-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-left text-sm font-black">
        <span className="flex items-center gap-2"><HelpCircle className="h-4 w-4 text-brand-accent" />What the numbers mean</span>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {open && (
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          {items.map(([k, v]) => <div key={k}><dt className="font-black text-ink">{k}</dt><dd className="leading-relaxed text-ink-2">{v}</dd></div>)}
        </dl>
      )}
    </section>
  );
}

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
          <ExplainCtx.Provider value={{ run: s.runId, combo: pick }}>
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
            {s.v !== 2 && (
              <p className="rounded-xl border border-data-caution/50 bg-data-caution/10 px-3 py-2 text-xs text-data-caution">
                This study was made before the fills were corrected (entries and stops 1 tick worse, targets only when traded through, stops and targets on ticks, no trades with less than 2 ticks to the target) and before the &quot;both years&quot; and &quot;t&quot; numbers. Its greens may be too good. Press Re-run on My Setups for the corrected numbers.
              </p>
            )}
            <Glossary />
            <section className="rounded-2xl border border-brand-accent/40 bg-brand-card p-4 space-y-2">
              <p className="text-sm font-black">Find insights in everything</p>
              <p className="text-[11px] text-ink-3">Sends every number of all four tabs (every rule, every fall range, all {c.features.length} facts, year 1 and year 2) and asks Claude to dig: what holds up on year 2, what is probably luck, what points the same way across tabs, and what to try next. Takes up to a few minutes; about ₹10–20 per press.</p>
              <Explain part="insights" label="Find insights" />
            </section>
            <section className="rounded-2xl bg-brand-card p-4 space-y-2">
              <p className="text-sm font-black">Ask Claude to explain</p>
              <p className="text-[11px] text-ink-3">In plain words, from the numbers of this run. One Claude call per press; the answer is kept on this device.</p>
              <div className="grid gap-3 lg:grid-cols-2">
                <Explain part="overview" label="Explain all four tabs" />
                <Explain part="tab" label={`Explain this tab (${c.dir === 'LONG' ? 'long' : 'short'} → ${c.target === 'VWAP' ? 'VWAP' : 'open'})`} />
              </div>
            </section>
            <Moves c={c} />
            <Rules c={c} months2={months2} />
            <Drop c={c} />
            <Facts c={c} />
          </ExplainCtx.Provider>
        )}
      </div>
    </div>
  );
}

/** how sure a number is: t (R after costs ÷ its standard error), coloured */
function Sure({ o }: { o: Outcomes }) {
  if (o.t == null || !o.n) return <span className="text-ink-4">–</span>;
  const cls = Math.abs(o.t) >= 2 ? (o.t > 0 ? 'text-data-green font-bold' : 'text-data-red-text font-bold') : Math.abs(o.t) >= 1 ? 'text-ink-2' : 'text-ink-4';
  return <span className={cls} title={Math.abs(o.t) >= 2 ? 'unlikely to be luck' : Math.abs(o.t) >= 1 ? 'maybe' : 'could easily be luck'}>{o.t.toFixed(1)}</span>;
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
      <td className="hidden px-2 py-1.5 text-right sm:table-cell"><Sure o={o} /></td>
      {extra}
    </tr>
  );
}
const OutHead = ({ first, extra }: { first: string; extra?: React.ReactNode }) => (
  <thead>
    <tr className="border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3">
      <th className="px-2 py-1.5 text-left">{first}</th><th className="px-2 py-1.5 text-right" title="How many trades">Trades</th>
      <th className="px-2 py-1.5 text-right" title="Reached the target before the stop">Clean</th>
      <th className="px-2 py-1.5 text-right" title="Stop hit first, but price reached the target later">Messy</th>
      <th className="px-2 py-1.5 text-right" title="Never reached the target by 15:00">Fail</th>
      <th className="hidden px-2 py-1.5 text-right sm:table-cell" title="Average result per trade before Dhan's charges, in R (1R = ₹300)">R before</th>
      <th className="px-2 py-1.5 text-right" title="Average result per trade after Dhan's charges and 1-tick slippage, in R (1R = ₹300). This decides if it makes money.">R after costs</th>
      <th className="hidden px-2 py-1.5 text-right sm:table-cell" title="How sure: R after costs ÷ its standard error. 2 or more = unlikely to be luck; under 1 = could easily be luck.">t</th>{extra}
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
          ['Typical fall before a clean turn', `${show(m.dropBeforeClean.p25)}–${show(m.dropBeforeClean.p75)}× daily range`],
          ['…in %', `${show(m.dropPctBeforeClean.p25)}–${show(m.dropPctBeforeClean.p75)}% (middle ${show(m.dropPctBeforeClean.p50)}%)`],
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
            {c.base.allFirst && <OutRow label="Both years" o={c.base.allFirst} />}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-ink-3">This is the baseline: what a rule has to beat. A rule is worth something only if it lifts the clean share and R after costs above these rows, on year 2.</p>
      <p className="text-[11px] text-ink-2"><b>How to read it:</b> clean + messy + fail = 100% of the trades. If R after costs is negative here, taking every reversal blindly loses money, and only a rule that turns it positive on year 2 is worth using.</p>
    </Card>
  );
}

function Rules({ c, months2 }: { c: ComboStudy; months2: number }) {
  const [open, setOpen] = useState<number | null>(null);
  const held = (o: Outcomes) => (o.n < 50 ? { t: 'Too few', cls: 'border-line-strong text-ink-3' }
    : o.netR <= 0 ? { t: 'Did not hold', cls: 'border-data-red/60 text-data-red-text' }
    : (o.t ?? 0) >= 2 ? { t: 'Held up', cls: 'border-data-green/60 text-data-green' }
    : { t: 'Green, could be luck', cls: 'border-brand-accent/60 text-brand-accent' });
  const cells = (o: Outcomes | undefined, strong: boolean) => !o ? <><td /><td /><td /><td /><td /><td /></> : (
    <>
      <td className="px-2 py-1.5 text-right">{o.n}</td>
      <td className="px-2 py-1.5 text-right font-bold text-data-green">{pct(o.clean)}</td>
      <td className="px-2 py-1.5 text-right text-ink-2">{pct(o.messy)}</td>
      <td className="px-2 py-1.5 text-right text-data-red-text">{pct(o.fail)}</td>
      <td className={`px-2 py-1.5 text-right ${strong ? 'font-bold' : ''} ${o.netR > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{rr(o.netR)}</td>
      <td className="px-2 py-1.5 text-right"><Sure o={o} /></td>
    </>
  );
  return (
    <Card title="Rules found on year 1, traded on year 2" sub="Each rule is the best combination of facts on year 1 (scored cautiously, failures included). Each next rule was searched on the days the earlier ones did not take. Year 2 was never seen by the search: it is the proof.">
      <p className="text-[11px] text-ink-2"><b>How to read it:</b> each row is one rule (all its boxes must be true at the same 10-min close). Year 1, year 2 and both years are each counted on their own: year 2 is the rule on <i>all</i> of year 2&apos;s days, not what year 1 left. Clean + messy + fail = 100%. Year 1 is where the rule was found, so it always looks good: judge on year 2. &quot;Held up&quot; = green on year 2 with t ≥ 2 (unlikely to be luck); &quot;Green, could be luck&quot; = green but not sure enough yet. With many rules on the page, a few greens are expected by luck alone. Tap a rule to see its latest trades.</p>
      <Explain part="rules" label="Explain these rules" />
      {!c.rules.length && <p className="text-xs text-ink-3">No combination of facts had enough trades on year 1.</p>}
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="text-[10px] font-black uppercase tracking-widest text-ink-3">
              <th />
              <th colSpan={2} className="border-b border-line px-2 py-1 text-center">Year 1 (found here)</th>
              <th colSpan={7} className="border-b border-data-green/40 px-2 py-1 text-center text-ink-2">Year 2 (never seen by the search)</th>
              <th colSpan={2} className="border-b border-line px-2 py-1 text-center">Both years</th>
              <th />
            </tr>
            <tr className="border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3">
              <th className="px-2 py-1.5 text-left">Rule</th>
              <th className="px-2 py-1.5 text-right">Trades</th><th className="px-2 py-1.5 text-right">R</th>
              <th className="px-2 py-1.5 text-right">Trades</th><th className="px-2 py-1.5 text-right" title="Reached the target before the stop">Clean</th>
              <th className="px-2 py-1.5 text-right" title="Stop hit first, target reached later">Messy</th><th className="px-2 py-1.5 text-right" title="Never reached the target by 15:00">Fail</th>
              <th className="px-2 py-1.5 text-right" title="After Dhan's charges and 1-tick slippage">R after costs</th>
              <th className="px-2 py-1.5 text-right" title="How sure: 2 or more = unlikely to be luck">t</th><th className="px-2 py-1.5 text-right">₹/month</th>
              <th className="px-2 py-1.5 text-right">Trades</th><th className="px-2 py-1.5 text-right">R</th>
              <th className="px-2 py-1.5 text-right"></th>
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
                    {cells(r.y2, true)}
                    <td className={`px-2 py-1.5 text-right ${r.y2.netR > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{inr((r.y2.netR * 300 * r.y2.n) / months2)}</td>
                    <td className="px-2 py-1.5 text-right text-ink-3">{r.all?.n ?? '–'}</td>
                    <td className={`px-2 py-1.5 text-right ${r.all ? (r.all.netR > 0 ? 'text-data-green' : 'text-data-red-text') : 'text-ink-3'}`}>{r.all ? rr(r.all.netR) : '–'}</td>
                    <td className="px-2 py-1.5 text-right"><span className={`whitespace-nowrap rounded-md border px-1.5 py-0.5 font-sans text-[10px] font-black uppercase ${h.cls}`}>{h.t}</span></td>
                  </tr>
                  {open === i && (
                    <tr className="border-b border-line/60">
                      <td colSpan={13} className="px-2 pb-3 pt-1">
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
                        <p className="mt-1 text-[11px] text-ink-3">With a 2 ATR stop instead of the low: {rr(r.y2.netWide)} per trade on year 2 (catches some of the messy ones). Average {r.y2.min} min in the trade.{r.y2.posMed ? ` Median position ₹${r.y2.posMed.toLocaleString('en-IN')} at ₹300 risk (tight stops = big positions: check your margin).` : ''}</p>
                        <div className="mt-2"><Explain part="rule" item={i} label={`Explain rule ${i + 1}`} small /></div>
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
                {cells(c.together.y2, true)}
                <td className={`px-2 py-1.5 text-right font-black ${c.together.y2.netR > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{inr((c.together.y2.netR * 300 * c.together.y2.n) / months2)}</td>
                <td className="px-2 py-1.5 text-right text-ink-3">{c.together.all?.n ?? '–'}</td>
                <td className="px-2 py-1.5 text-right text-ink-3">{c.together.all ? rr(c.together.all.netR) : '–'}</td>
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
              <OutRow key={`${d.lo}-${d.hi}`} label={<span className={c.bestDrop && d.lo >= c.bestDrop.lo && (!ok(c.bestDrop.hi) || (ok(d.hi) && d.hi <= c.bestDrop.hi)) ? 'font-bold text-brand-accent' : ''}>{band(d.lo, d.hi)}</span>} o={d.y1}
                extra={<td className={`px-2 py-1.5 text-right ${d.y2.netR > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{d.y2.n ? rr(d.y2.netR) : '–'}</td>} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-ink-2"><b>How to read it:</b> each row is how far the stock had already fallen from its open when the entry came, compared with its usual daily move (0.6 = 60% of a normal day). The row with the best R after costs on year 1 is highlighted; the last column says whether that range still paid on year 2.</p>
      <Explain part="drop" label="Explain the fall ranges" />
      {c.bestDrop && (
        <p className="text-[11px] text-ink-2">Best range on year 1: a fall of <b>{band(c.bestDrop.lo, c.bestDrop.hi)}×</b> the daily range ({rr(c.bestDrop.y1.netR)} on {c.bestDrop.y1.n} trades). On year 2 the same range made <b className={c.bestDrop.y2.netR > 0 ? 'text-data-green' : 'text-data-red-text'}>{rr(c.bestDrop.y2.netR)}</b> on {c.bestDrop.y2.n} trades.</p>
      )}
    </Card>
  );
}

/** a small "?" per fact that opens its own explanation */
function ExplainFact({ f }: { f: string }) {
  const [show, setShow] = useState(false);
  if (!show) return <button onClick={() => setShow(true)} className="flex items-center gap-1 text-[10px] font-bold text-brand-accent hover:underline"><Sparkles className="h-3 w-3" />Explain</button>;
  return <div className="w-full"><Explain part="fact" item={f} label="Explain this fact" small /></div>;
}

function Facts({ c }: { c: ComboStudy }) {
  const [all, setAll] = useState(false);
  const list = useMemo(() => (all ? c.features : c.features.slice(0, 10)), [all, c.features]);
  return (
    <Card title="Every fact, winners vs failures" sub="Each fact split into five equal groups (on year 1). For each group: how often it was a clean win, a messy win or a failure, and R after costs; year 2 on the right. Sorted by how much the fact changes R.">
      <p className="text-[11px] text-ink-2"><b>How to read it:</b> each table is one thing you could see on the chart at the entry, cut into five equal groups by its value. Compare the rows: if one group has clearly more clean wins, fewer fails and a better R after costs than the others — on year 1 and still on year 2 (last column) — that fact really separates good reversals from bad ones.</p>
      <Explain part="facts" label="Explain these facts" />
      <div className="grid gap-4 lg:grid-cols-2">
        {list.map((f) => (
          <div key={f.f} className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] font-bold">{f.label}</p>
              <ExplainFact f={f.f} />
            </div>
            <div className="-mx-2 overflow-x-auto">
              <table className="w-full text-[11px]">
                <OutHead first="Value" extra={<th className="px-2 py-1.5 text-right">Y2 R</th>} />
                <tbody>
                  {f.bins.map((b) => (
                    <OutRow key={`${b.lo}-${b.hi}`} o={b.y1}
                      label={!ok(b.lo) ? `< ${num(b.hi)}` : !ok(b.hi) ? `≥ ${num(b.lo)}` : `${num(b.lo)} – ${num(b.hi)}`}
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
