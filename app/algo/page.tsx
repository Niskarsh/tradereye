"use client";
import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Card, pct, rr } from '@/components/setups/parts';

/**
 * Algo Lab: walk-forward machine learning on every 10-min close of every stock in his price range
 * (scripts/ml_walkforward.py). Every trade shown was predicted by a model trained only on earlier months.
 * Each run is one iteration; the table at the top keeps every iteration so far, so luck from trying many things shows.
 */

interface S { n: number; hit: number; netR: number; gross: number; sumR: number; inr: number; t: number }
interface P extends S { monthsGreen: number; monthsTraded: number; monthsTotal: number }
interface Month extends S { month: string; thr: number | null; note: string; ic: number | null; exam: boolean; baseL: number; baseS: number }
interface Strat {
  id: string; name: string; kind: 'dir' | 'neutral'; desc: string;
  baseline: { long: number; short: number; longGross: number; shortGross: number };
  overall: P & { maxDrawdownR: number; inrPerMonth: number }; dev: P; exam: P;
  ic: { mean: number | null; positive: number; months: number };
  daily?: { tradingDays: number; daysWithTrades: number; perTradedDay: number; maxPerDay: number; at0935: number; greenDays: number; worstDayR: number; bestDayR: number; worstWeekR: number; greenWeeks: number } | null;
  costs?: { id: string; name: string; fill: number; overall: S; months: [number, number]; dev: S; devMonths: [number, number]; exam: S; examMonths: [number, number] }[];
  bySide: { long: S; short: S }; byHour: (S & { hour: string })[]; months: Month[];
  importance: { f: string; label: string; share: number }[];
  liked: { side: string; f: string; label: string; z: number; taken: number; all: number }[];
  recent: { day: string; sym: string; time: string; side: string; pred: number; net: number }[];
}
interface Ml {
  v: 1 | 2; iteration: number; changes: string[]; runId: string; code?: string | null; createdAt: number; period: { from: string; to: string }; examFrom: string;
  rows: number; stocks: number; days: number;
  setup: { trainMonths: number; valMonths: number; examMonths: number; maxPerDay: number; maxPerSide: number; riskInr: number; neutralTimes: string[]; neutralK: number };
  baselineTight: { long: number; short: number };
  best: string; strategies: Strat[];
}
interface Line { id: string; name: string; n: number; netR: number; gross: number | null; t: number; monthsGreen: number; monthsTraded: number; dev: number | null; exam: number | null; ic: number | null }
interface Head { runId: string; createdAt: number; iteration: number; code?: string | null; lines: Line[] }
const codeLink = (sha?: string | null) => (sha ? <a className="underline" href={`https://github.com/Niskarsh/tradereye/commit/${sha}`} target="_blank" rel="noreferrer">{sha.slice(0, 7)}</a> : null);

const inr = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${x < 0 ? '−' : '+'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`);
const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const mon = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const tone = (x: number | null | undefined, on = true) => (!on || x == null ? 'text-ink-3' : x > 0 ? 'text-data-green' : 'text-data-red-text');
const fx = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));

/** the honest one-line verdict for a strategy: judged on the earlier months, confirmed (or not) by the exam */
function verdict(s: Strat): { text: string; cls: string } {
  const { dev, exam, overall: o } = s;
  const green = 'border-data-green/60 bg-data-green/10 text-data-green', amber = 'border-brand-accent/60 bg-brand-accent/10 text-brand-accent', red = 'border-data-red/60 bg-data-red/10 text-data-red-text';
  if (o.n < 100) return { text: 'Not enough trades to judge.', cls: 'border-line-strong text-ink-2' };
  const devGood = dev.n >= 100 && dev.netR > 0 && dev.t >= 2 && dev.monthsGreen >= 0.6 * dev.monthsTraded;
  if (devGood && exam.n >= 30 && exam.netR > 0) return { text: 'Candidate edge: profitable after costs on the earlier months (sure enough, green most months) and it passed the exam months it never influenced. Paper-trade it next.', cls: green };
  if (devGood) return { text: 'Profitable on the earlier months but it failed (or has too few trades in) the exam months. Most likely luck; not tradeable yet.', cls: amber };
  if (o.netR > 0) return { text: 'Slightly profitable out of sample, but not sure enough (t under 2 or too many red months). Could be luck.', cls: amber };
  if (o.gross > 0) return { text: `Some signal before costs (${rr(o.gross)} a trade), but the charges eat it (${rr(o.netR)} after). Close, not there.`, cls: amber };
  return { text: 'No edge: out of sample, these trades lose money even before costs.', cls: red };
}

function Tiles({ items }: { items: [string, string, string?][] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map(([k, val, cls]) => (
        <div key={k} className="rounded-xl border border-line bg-brand-card px-3 py-2">
          <p className="text-[10px] font-black uppercase tracking-widest text-ink-3">{k}</p>
          <p className={`font-mono text-sm font-bold ${cls ?? ''}`}>{val}</p>
        </div>
      ))}
    </div>
  );
}

const TH = 'px-2 py-1.5 text-right';
const HEAD = 'border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3';

function History({ history }: { history: Head[] }) {
  if (!history.length) return null;
  return (
    <Card title="Iterations so far" sub="Every run of the Algo Lab, newest first. From iteration 5 on, each one is kept for good (its results, every trade, and its code version), so we can always go back. Earlier months decide the next step; the exam months (the last 6) only confirm. If we try many things, one will look green by luck: a real edge stays green on both.">
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead><tr className={HEAD}>
            <th className="px-2 py-1.5 text-left">#</th><th className="px-2 py-1.5 text-left">Run</th><th className="px-2 py-1.5 text-left">Strategy</th>
            <th className={TH}>Trades</th><th className={TH}>Before costs</th><th className={TH}>After costs</th><th className={TH}>t</th>
            <th className={TH}>Months green</th><th className={TH}>Earlier months</th><th className={TH}>Exam</th><th className={TH}>Signal</th>
          </tr></thead>
          <tbody>
            {history.flatMap((h) => h.lines.map((l, i) => (
              <tr key={`${h.runId}${l.id}`} className="border-b border-line/60 font-mono tabular-nums">
                <td className="px-2 py-1.5 font-sans font-bold">{i === 0 ? h.iteration : ''}</td>
                <td className="px-2 py-1.5 font-sans text-ink-3">{i === 0 ? <>{new Date(h.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} {codeLink(h.code)}</> : ''}</td>
                <td className="px-2 py-1.5 font-sans">{l.name}</td>
                <td className={TH}>{l.n}</td>
                <td className={`${TH} ${tone(l.gross)}`}>{rr(l.gross)}</td>
                <td className={`${TH} font-bold ${tone(l.netR, l.n > 0)}`}>{l.n ? rr(l.netR) : '–'}</td>
                <td className={TH}>{l.n ? fx(l.t) : '–'}</td>
                <td className={TH}>{l.monthsGreen} / {l.monthsTraded}</td>
                <td className={`${TH} ${tone(l.dev)}`}>{rr(l.dev)}</td>
                <td className={`${TH} ${tone(l.exam)}`}>{rr(l.exam)}</td>
                <td className={TH}>{fx(l.ic, 3)}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-ink-3">Signal = how well the model&apos;s ranking of moments lined up with what actually happened, on months it had not seen (rank correlation: 0 = it knows nothing, 0.03–0.05 is already useful across many stocks). It can show a model knows something even when the charges eat the profit.</p>
    </Card>
  );
}

function StrategyView({ s, ml }: { s: Strat; ml: Ml }) {
  const v = verdict(s);
  const o = s.overall;
  const neutral = s.kind === 'neutral';
  return (
    <>
      <p className="text-xs text-ink-2">{s.desc}</p>
      <p className={`rounded-xl border px-3 py-2 text-sm font-bold ${v.cls}`}>{v.text}</p>
      <Tiles items={[
        ['Out-of-sample trades', o.n.toLocaleString('en-IN')],
        ['R per trade after costs', rr(o.netR), tone(o.netR, o.n > 0)],
        ['R per trade before costs', rr(o.gross), tone(o.gross, o.n > 0)],
        ['How sure (t)', fx(o.t)],
        ['Earlier months (decides)', s.dev.n ? `${rr(s.dev.netR)} · ${s.dev.monthsGreen}/${s.dev.monthsTraded} green` : '–', tone(s.dev.netR, s.dev.n > 0)],
        [`Exam: from ${mon(ml.examFrom)}`, s.exam.n ? `${rr(s.exam.netR)} · ${s.exam.monthsGreen}/${s.exam.monthsTraded} green` : '–', tone(s.exam.netR, s.exam.n > 0)],
        ['Per month, at ₹300 risk', inr(o.inrPerMonth), tone(o.inrPerMonth, o.n > 0)],
        ['Signal (does it know anything?)', s.ic.mean == null ? '–' : `${fx(s.ic.mean, 3)} · ${s.ic.positive}/${s.ic.months} months +`, tone(s.ic.mean)],
        ['Made money after costs', o.n ? pct(o.hit) : '–'],
        ['Worst drop (R)', `−${o.maxDrawdownR}R`],
      ]} />
      <p className="text-[11px] text-ink-3">
        Taking every moment blindly with this trade makes {rr(s.baseline.long)} long / {rr(s.baseline.short)} short after costs
        ({rr(s.baseline.longGross)} / {rr(s.baseline.shortGross)} before): that is what the model has to beat.
        {neutral && ` Baskets at ${ml.setup.neutralTimes.join(', ')}: ${ml.setup.neutralK} longs + ${ml.setup.neutralK} shorts, each stock once a day.`}
      </p>

      {s.daily && (
        <Card title="Your day, if you traded it by hand" sub="All tested months, after costs at ₹300 risk. What paper-trading this would feel like.">
          <Tiles items={[
            ['Days with a trade', `${s.daily.daysWithTrades} of ${s.daily.tradingDays} (${pct(s.daily.daysWithTrades / Math.max(1, s.daily.tradingDays))})`],
            ['Trades on those days', `${s.daily.perTradedDay} avg · ${s.daily.maxPerDay} max`],
            ['Fired at 09:35', pct(s.daily.at0935)],
            ['Green days', pct(s.daily.greenDays)],
            ['Worst day', `${s.daily.worstDayR}R (${inr(s.daily.worstDayR * 300)})`, 'text-data-red-text'],
            ['Best day', `+${s.daily.bestDayR}R (${inr(s.daily.bestDayR * 300)})`, 'text-data-green'],
            ['Worst week', `${s.daily.worstWeekR}R (${inr(s.daily.worstWeekR * 300)})`, 'text-data-red-text'],
            ['Green weeks', pct(s.daily.greenWeeks)],
          ]} />
        </Card>
      )}

      {s.costs && (
        <Card title="The same trades at different position sizes" sub="Which trades are taken does not change; only how big they are. Dhan's brokerage is capped at ₹20 an order, so bigger positions pay less in charges per R. A bigger position risks far more than ₹300 per trade (about ₹1,800 at ₹1 lakh and ₹5,500 at ₹3 lakh with this stop): compare R, not rupees. (Iteration 4 showed limit orders at the close lose: the ones that never fill are the winners.)">
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full min-w-[620px] text-xs">
              <thead><tr className={HEAD}>
                <th className="px-2 py-1.5 text-left">Execution</th><th className={TH}>Filled</th><th className={TH}>Trades</th><th className={TH}>R after costs</th><th className={TH}>t</th>
                <th className={TH}>Months green</th><th className={TH}>Earlier months</th><th className={TH}>Exam</th>
              </tr></thead>
              <tbody>
                {s.costs.map((c) => (
                  <tr key={c.id} className="border-b border-line/60 font-mono tabular-nums">
                    <td className="px-2 py-1.5 font-sans">{c.name}</td>
                    <td className={TH}>{pct(c.fill)}</td>
                    <td className={TH}>{c.overall.n}</td>
                    <td className={`${TH} font-bold ${tone(c.overall.netR, c.overall.n > 0)}`}>{c.overall.n ? rr(c.overall.netR) : '–'}</td>
                    <td className={TH}>{c.overall.n ? fx(c.overall.t) : '–'}</td>
                    <td className={TH}>{c.months[0]} / {c.months[1]}</td>
                    <td className={`${TH} ${tone(c.dev.netR, c.dev.n > 0)}`}>{c.dev.n ? `${rr(c.dev.netR)} · ${c.devMonths[0]}/${c.devMonths[1]}` : '–'}</td>
                    <td className={`${TH} ${tone(c.exam.netR, c.exam.n > 0)}`}>{c.exam.n ? `${rr(c.exam.netR)} · ${c.examMonths[0]}/${c.examMonths[1]}` : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Month by month (every month traded blind)" sub="A real edge is green most months, not just one big month. Exam months are marked; the bar to trade and 'stood aside' were decided on the months just before each month.">
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full min-w-[620px] text-xs">
            <thead><tr className={HEAD}>
              <th className="px-2 py-1.5 text-left">Month</th><th className={TH}>Trades</th><th className={TH}>Made money</th><th className={TH}>Before costs</th>
              <th className={TH}>R per trade</th><th className={TH}>Total R</th><th className={TH}>₹ at ₹300 risk</th><th className={TH}>Signal</th><th className="px-2 py-1.5 text-left"></th>
            </tr></thead>
            <tbody>
              {s.months.map((m) => (
                <tr key={m.month} className={`border-b border-line/60 font-mono tabular-nums ${m.exam ? 'bg-brand-accent/5' : ''}`}>
                  <td className="px-2 py-1.5 font-sans">{mon(m.month)}{m.exam && <span className="ml-1 text-[9px] font-black uppercase text-brand-accent">exam</span>}</td>
                  <td className={TH}>{m.n}</td>
                  <td className={TH}>{m.n ? pct(m.hit) : '–'}</td>
                  <td className={`${TH} ${tone(m.gross, m.n > 0)}`}>{m.n ? rr(m.gross) : '–'}</td>
                  <td className={`${TH} ${tone(m.netR, m.n > 0)}`}>{m.n ? rr(m.netR) : '–'}</td>
                  <td className={`${TH} ${tone(m.sumR, m.n > 0)}`}>{m.n ? `${m.sumR > 0 ? '+' : ''}${m.sumR.toFixed(1)}R` : '–'}</td>
                  <td className={`${TH} font-bold ${tone(m.inr, m.n > 0)}`}>{m.n ? inr(m.inr) : '–'}</td>
                  <td className={`${TH} ${tone(m.ic)}`}>{fx(m.ic, 3)}</td>
                  <td className="px-2 py-1.5 font-sans text-[10px] text-ink-3">{m.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="By side and time of day" sub="Earlier months only (the exam months never steer the next step). Where the trades made or lost money.">
          <table className="w-full text-xs">
            <thead><tr className={HEAD}><th className="px-2 py-1.5 text-left"></th><th className={TH}>Trades</th><th className={TH}>Before costs</th><th className={TH}>After costs</th><th className={TH}>t</th><th className={TH}>₹</th></tr></thead>
            <tbody>
              {([['Longs', s.bySide.long], ['Shorts', s.bySide.short], ...s.byHour.map((h) => [`From ${h.hour}`, h])] as [string, S][]).map(([k, x]) => (
                <tr key={k} className="border-b border-line/60 font-mono tabular-nums">
                  <td className="px-2 py-1.5 font-sans">{k}</td><td className={TH}>{x.n}</td>
                  <td className={`${TH} ${tone(x.gross, x.n > 0)}`}>{x.n ? rr(x.gross) : '–'}</td>
                  <td className={`${TH} ${tone(x.netR, x.n > 0)}`}>{x.n ? rr(x.netR) : '–'}</td>
                  <td className={TH}>{fx(x.t)}</td><td className={TH}>{inr(x.inr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="What the model leans on" sub="Each fact's share of how much the model's trees improved their predictions.">
          <ol className="space-y-1 text-xs">
            {s.importance.map((x, i) => (
              <li key={x.f} className="flex items-center gap-2">
                <span className="w-5 text-right font-mono text-ink-3">{i + 1}</span>
                <span className="flex-1">{x.label}</span>
                <span className="h-1.5 rounded-full bg-brand-accent" style={{ width: `${Math.round(x.share * 300)}px` }} />
                <span className="w-12 text-right font-mono text-ink-3">{pct(x.share)}</span>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Card title="What its trades look like" sub="How the moments the model chose differ from all moments (in standard deviations; + = higher than usual). This is the pattern in plain facts.">
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full min-w-[520px] text-xs">
            <thead><tr className={HEAD}><th className="px-2 py-1.5 text-left">Side</th><th className="px-2 py-1.5 text-left">Fact</th><th className={TH}>Difference</th><th className={TH}>Its trades (median)</th><th className={TH}>All moments (median)</th></tr></thead>
            <tbody>
              {s.liked.map((x) => (
                <tr key={`${x.side}${x.f}`} className="border-b border-line/60 font-mono tabular-nums">
                  <td className="px-2 py-1.5 font-sans">{x.side}</td><td className="px-2 py-1.5 font-sans">{x.label}</td>
                  <td className={`${TH} ${x.z > 0 ? 'text-data-green' : 'text-data-red-text'}`}>{x.z > 0 ? '+' : ''}{x.z.toFixed(2)}</td>
                  <td className={TH}>{x.taken}</td><td className={`${TH} text-ink-3`}>{x.all}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Its latest trades" sub="Check them on your chart: these were picked by a model that had not seen that month.">
        <table className="w-full text-[11px]"><tbody>
          {s.recent.slice().reverse().map((t, i) => (
            <tr key={i} className="border-b border-line/40 font-mono">
              <td className="px-1 py-1 text-ink-3">{t.day} {t.time}</td><td className="px-1 py-1 font-bold">{t.sym}</td>
              <td className={`px-1 py-1 ${t.side === 'LONG' ? 'text-data-green' : 'text-data-red-text'}`}>{t.side}</td>
              <td className="px-1 py-1 text-ink-3">{neutral ? `rated ${t.pred > 0 ? '+' : ''}${t.pred.toFixed(2)}% vs the others` : `predicted ${rr(t.pred)}`}</td>
              <td className={`px-1 py-1 text-right ${tone(t.net)}`}>{rr(t.net)}</td>
            </tr>
          ))}
        </tbody></table>
      </Card>
    </>
  );
}

export default function AlgoPage() {
  const [ml, setMl] = useState<Ml | null | undefined>(undefined);
  const [history, setHistory] = useState<Head[]>([]);
  const [pick, setPick] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/algo').then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setMl(j.ml); setHistory(j.history ?? []);
    }).catch((e) => setErr((e as Error).message));
  }, []);
  const v2 = ml && ml.v === 2 ? ml : undefined;
  const s = v2 ? v2.strategies.find((x) => x.id === (pick || v2.best)) ?? v2.strategies[0] : undefined;
  return (
    <div className="min-h-screen bg-brand-bg text-ink font-sans pb-24">
      <div className="page-shell pt-6 space-y-4">
        <header className="border-b border-line pb-3">
          <h1 className="text-2xl font-black tracking-tighter">Algo Lab</h1>
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-ink-3">Machine learning on every stock, every 10 minutes · trained on the past, tested month by month on what it had not seen</p>
        </header>
        {err && <p className="text-xs text-data-red-text">{err}</p>}
        {ml === undefined && !err && <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>}
        {ml === null && <Card title="No results yet" sub="Made by the backtest run: press Re-run on My Analysis → My Setups. The model step adds about an hour after the backtest."><span /></Card>}
        {ml && !v2 && <Card title="This run was made by iteration 1" sub="Press Re-run on My Analysis → My Setups to run iteration 2. Its headline is in the table below."><span /></Card>}
        {v2 && s && (
          <>
            <Card title={`Iteration ${v2.iteration}: what changed`} sub={`${fmtDate(v2.period.from)} – ${fmtDate(v2.period.to)} · ${v2.stocks} stocks · ${v2.rows.toLocaleString('en-IN')} moments (every 10-min close 09:35–14:45) · exam months from ${mon(v2.examFrom)}`}>
              <ul className="list-disc space-y-1 pl-4 text-xs text-ink-2">{v2.changes.map((c) => <li key={c}>{c}</li>)}</ul>
              {v2.code && <p className="mt-1 text-[11px] text-ink-3">Code version {codeLink(v2.code)} (also tagged algo-iter-{v2.iteration}-{v2.runId} on GitHub).</p>}
              <p className="mt-2 text-[11px] text-ink-3">
                Every trade: entry 1 tick worse than the 10-min close, stops fill 1 tick worse, targets only when traded through, Dhan&apos;s charges at ₹{v2.setup.riskInr} risk.
                Each month: models trained on up to {v2.setup.trainMonths} months before it, the bar to trade set on the {v2.setup.valMonths} months just before (with models that never saw them), then the month traded blind.
                At most one trade per stock a day, {v2.setup.maxPerSide} a side and {v2.setup.maxPerDay} a day. For reference, iteration 1&apos;s tight bracket taken blindly: {rr(v2.baselineTight.long)} long / {rr(v2.baselineTight.short)} short.
              </p>
            </Card>
            <div className="flex flex-wrap gap-2">
              {v2.strategies.map((x) => (
                <button key={x.id} onClick={() => setPick(x.id)}
                  className={`rounded-full border px-3 py-1 text-xs font-bold ${x.id === s.id ? 'border-brand-accent bg-brand-accent/15 text-brand-accent' : 'border-line text-ink-2'}`}>
                  {x.name} <span className={`font-mono ${tone(x.overall.netR, x.overall.n > 0)}`}>{x.overall.n ? rr(x.overall.netR) : '–'}</span>
                </button>
              ))}
            </div>
            <StrategyView s={s} ml={v2} />
          </>
        )}
        <History history={history} />
      </div>
    </div>
  );
}
