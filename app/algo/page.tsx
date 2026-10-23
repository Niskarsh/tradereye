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
  overall: P & { maxDrawdownR: number; inrPerMonth: number }; dev: P; exam: P & { pass?: boolean | null };
  ic: { mean: number | null; positive: number; months: number };
  daily?: { tradingDays: number; daysWithTrades: number; perTradedDay: number; maxPerDay: number; at0935: number; greenDays: number; worstDayR: number; bestDayR: number; worstWeekR: number; greenWeeks: number } | null;
  money?: Money | null;
  shadow?: P & { from?: string };
  costs?: { id: string; name: string; fill: number; overall: S; months: [number, number]; dev: S; devMonths: [number, number]; exam: S; examMonths: [number, number] }[];
  bySide: { long: S; short: S }; byHour: (S & { hour: string })[]; months: Month[];
  importance: { f: string; label: string; share: number }[];
  liked: { side: string; f: string; label: string; z: number; taken: number; all: number }[];
  recent: { day: string; sym: string; time: string; side: string; pred: number; net: number }[];
  oldFills?: S | null; minVol?: number | null;
  bands?: (S & { band: string; old: number })[] | null;
}
interface Ml {
  v: 1 | 2; iteration: number; changes: string[]; runId: string; code?: string | null; createdAt: number; period: { from: string; to: string }; examFrom: string;
  rows: number; stocks: number; days: number;
  setup: { trainMonths: number; valMonths: number; examMonths: number; maxPerDay: number; maxPerSide: number; riskInr: number; neutralTimes: string[]; neutralK: number };
  baselineTight: { long: number; short: number };
  best: string; strategies: Strat[];
  locked?: string;
  untouched?: Untouched | Untouched[] | null;
  shadowFrom?: string;
  confirm?: Confirmed[];
  noise?: { strategy: string; draws: { draw: string; n: number; netR: number; t: number; devNetR: number; devT: number; devGreen: [number, number] }[]; devMin: number; devMax: number; devMean: number };
  management?: Mgmt[]; managementError?: string;
  noiseAll?: Noise[];
  volChoice?: { id: string | null; name: string | null; rule: { netR: number; t: number; n: number }; order: string[]; tried: { id: string; name: string; netR: number; t: number; n: number; perMonth?: number | null; ok: boolean }[] } | null;
  capChoice?: { id: string | null; name: string | null; rule: { netR: number; t: number }; order: string[]; tried: { id: string; name: string; netR: number; t: number; n: number; ok: boolean }[] } | null;
}
interface Noise { strategy: string; draws: { draw: string; devNetR: number; devT: number }[]; devMin: number; devMax: number; devMean: number }

/** iteration 10: F's versions side by side (same models, different daily caps / entry window), the rule fixed in advance, and the placebo */
function CapCard({ ml }: { ml: Ml }) {
  const order = ['shortNear', 'f1055', 'fCap3', 'fCap2', 'fStrict'];
  const rows = order.map((id) => ml.strategies.find((x) => x.id === id)).filter((x): x is Strat => !!x);
  if (rows.length < 3) return null;
  const un = Array.isArray(ml.untouched) ? ml.untouched : ml.untouched ? [ml.untouched] : [];
  const pb = ml.strategies.find((x) => x.id === 'placebo');
  const c = ml.capChoice;
  const inr = (x: number) => `${x < 0 ? '−' : '+'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;
  return (
    <Card title="How many trades a day?" sub="The same models and the same predictions; only which trades are taken differs (all but the first stop new entries at 10:55). Decide months, after costs, at ₹300 risk.">
      <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-xs"><thead><tr className={HEAD}>
        <th className="px-2 py-1.5 text-left">Version</th><th className={TH}>Trades / month</th><th className={TH}>Per day (max)</th><th className={TH}>R / trade</th><th className={TH}>t</th><th className={TH}>Months green</th>
        <th className={TH}>Worst day</th><th className={TH}>Worst week</th><th className={TH}>Deepest run</th><th className={TH}>₹ / month</th><th className={TH}>Capital</th><th className={TH}>% / month</th><th className={TH}>5 draws</th><th className={TH}>Untouched</th><th className={TH}>Exam</th>
      </tr></thead><tbody>
        {rows.map((s) => {
          const nz = ml.noiseAll?.find((x) => x.strategy === s.id), u = un.find((x) => x.id === s.id), m = s.money, d = s.daily;
          return (
            <tr key={s.id} className={`border-b border-line/60 font-mono tabular-nums ${c?.id === s.id ? 'bg-data-green/10' : ''}`}>
              <td className="px-2 py-1.5 font-sans">{s.name}</td>
              <td className={TH}>{m ? m.tradesPerMonth : '–'}</td><td className={TH}>{d ? `${d.perTradedDay} (${d.maxPerDay})` : '–'}</td>
              <td className={`${TH} font-bold ${tone(s.dev.netR, s.dev.n > 0)}`}>{rr(s.dev.netR)}</td><td className={TH}>{fx(s.dev.t)}</td><td className={TH}>{s.dev.monthsGreen}/{s.dev.monthsTraded}</td>
              <td className={TH}>{d ? rr(d.worstDayR) : '–'}</td><td className={TH}>{d ? rr(d.worstWeekR) : '–'}</td><td className={TH}>{m ? `−${m.maxDrawdownR}R` : '–'}</td>
              <td className={`${TH} ${tone(m?.perMonth ?? 0)}`}>{m ? inr(m.perMonth) : '–'}</td><td className={TH}>{m ? `₹${m.capital.toLocaleString('en-IN')}` : '–'}</td><td className={TH}>{m ? `${m.pct}%` : '–'}</td>
              <td className={TH}>{nz ? `${rr(nz.devMin)} to ${rr(nz.devMax)}` : '–'}</td>
              <td className={TH}>{u && u.overall.n ? `${rr(u.overall.netR)} (t ${fx(u.overall.t)}, ${u.overall.n})` : '–'}</td><td className={TH}>{passText(examPass(s.exam))}</td>
            </tr>
          );
        })}
      </tbody></table></div>
      {c && (
        <p className="mt-2 text-sm">
          Rule fixed before this run: the smallest daily risk ({c.order.map((id) => ml.strategies.find((x) => x.id === id)?.name ?? id).join(' → ')}) that keeps at least {rr(c.rule.netR)} a trade with t of at least {c.rule.t}.{' '}
          {c.id ? <b className="text-data-green">Pick: {c.name}.</b> : <b className="text-brand-accent">No capped version passes: keep F to 10:55 as it is, with a daily loss stop.</b>}
          <span className="block text-[11px] text-ink-3">{c.tried.map((x) => `${x.name}: ${rr(x.netR)}, t ${fx(x.t)} ${x.ok ? '✓' : '✗'}`).join(' · ')}</span>
        </p>
      )}
      {pb && (
        <p className="mt-2 text-[11px] text-ink-2">
          Placebo (models trained on shuffled outcomes, traded on the real ones): {pb.dev.n} trades, <b className={tone(pb.dev.netR, pb.dev.n > 0)}>{pb.dev.n ? rr(pb.dev.netR) : '–'}</b> a trade (t {fx(pb.dev.t)}), signal {pb.ic.mean ?? '–'}.{' '}
          {pb.dev.n >= 100 && pb.dev.t >= 2 && pb.dev.netR > 0 ? <b className="text-data-red-text">It shows an edge: something leaks. Do not trust this run.</b> : 'No edge, as it should be: the pipeline does not invent one.'}
        </p>
      )}
      <p className="mt-1 text-[11px] text-ink-3">Untouched months: F was already shown them in iterations 8 and 9, so this is a second look, not a clean test. 5 draws: the same version trained five times; differences between versions smaller than this spread are luck.</p>
    </Card>
  );
}
/** iteration 11: F as live, re-scored with fills by liquidity, at five liquidity floors (same models, same predictions) */
function LiquidityCard({ ml }: { ml: Ml }) {
  const order = ['fCap2', 'vAll', 'v3m', 'v5m', 'v7m', 'v10m'];
  const rows = order.map((id) => ml.strategies.find((x) => x.id === id)).filter((x): x is Strat => !!x);
  if (rows.length < 3) return null;
  const un = Array.isArray(ml.untouched) ? ml.untouched : ml.untouched ? [ml.untouched] : [];
  const pb = ml.strategies.find((x) => x.id === 'placebo');
  const all = ml.strategies.find((x) => x.id === 'vAll');
  const c = ml.volChoice;
  const inr = (x: number) => `${x < 0 ? '−' : '+'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;
  return (
    <Card title="Real fills and liquidity" sub="F as Algo Live trades it (short, 09:35–10:55, first 2 a day). The same models and predictions; the first row keeps the old 1-tick fills, the rest are filled the way a stock of that liquidity really fills and only trade stocks above their floor. Decide months, after costs, at ₹300 risk.">
      <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-xs"><thead><tr className={HEAD}>
        <th className="px-2 py-1.5 text-left">Version</th><th className={TH}>Trades / month</th><th className={TH}>R / trade</th><th className={TH}>Same trades, old fills</th><th className={TH}>t</th><th className={TH}>Months green</th>
        <th className={TH}>Worst day</th><th className={TH}>Deepest run</th><th className={TH}>₹ / month</th><th className={TH}>5 draws</th><th className={TH}>Untouched</th><th className={TH}>Exam</th>
      </tr></thead><tbody>
        {rows.map((s) => {
          const nz = ml.noiseAll?.find((x) => x.strategy === s.id), u = un.find((x) => x.id === s.id), m = s.money, d = s.daily;
          return (
            <tr key={s.id} className={`border-b border-line/60 font-mono tabular-nums ${c?.id === s.id ? 'bg-data-green/10' : ''}`}>
              <td className="px-2 py-1.5 font-sans">{s.name}</td>
              <td className={TH}>{m ? m.tradesPerMonth : '–'}</td>
              <td className={`${TH} font-bold ${tone(s.dev.netR, s.dev.n > 0)}`}>{rr(s.dev.netR)}</td>
              <td className={TH}>{s.oldFills ? rr(s.oldFills.netR) : '–'}</td>
              <td className={TH}>{fx(s.dev.t)}</td><td className={TH}>{s.dev.monthsGreen}/{s.dev.monthsTraded}</td>
              <td className={TH}>{d ? rr(d.worstDayR) : '–'}</td><td className={TH}>{m ? `−${m.maxDrawdownR}R` : '–'}</td>
              <td className={`${TH} ${tone(m?.perMonth ?? 0)}`}>{m ? inr(m.perMonth) : '–'}</td>
              <td className={TH}>{nz ? `${rr(nz.devMin)} to ${rr(nz.devMax)}` : '–'}</td>
              <td className={TH}>{u && u.overall.n ? `${rr(u.overall.netR)} (t ${fx(u.overall.t)}, ${u.overall.n})` : '–'}</td><td className={TH}>{passText(examPass(s.exam))}</td>
            </tr>
          );
        })}
      </tbody></table></div>
      {c && (
        <p className="mt-2 text-sm">
          Rule fixed before this run: the highest floor that keeps at least {rr(c.rule.netR)} a trade, t of at least {c.rule.t} and {c.rule.n}+ trades.{' '}
          {c.id ? <b className="text-data-green">Pick: {c.name}.</b> : <b className="text-data-red-text">No floor passes at real fills: do not scale up F until this is understood.</b>}
          <span className="block text-[11px] text-ink-3">{c.tried.map((x) => `${x.name}: ${rr(x.netR)}, t ${fx(x.t)}, ${x.n} ${x.ok ? '✓' : '✗'}`).join(' · ')}</span>
        </p>
      )}
      {all?.bands && all.bands.length > 0 && (
        <div className="mt-3 overflow-x-auto"><p className="mb-1 text-[11px] font-bold uppercase tracking-[0.15em] text-ink-3">Where it comes from: F as live, every stock, by liquidity</p>
          <table className="w-full min-w-[520px] text-xs"><thead><tr className={HEAD}>
            <th className="px-2 py-1.5 text-left">Average volume</th><th className={TH}>Trades</th><th className={TH}>R / trade (real fills)</th><th className={TH}>Old fills</th><th className={TH}>Slippage cost</th><th className={TH}>t</th>
          </tr></thead><tbody>
            {all.bands.map((b) => (
              <tr key={b.band} className="border-b border-line/60 font-mono tabular-nums">
                <td className="px-2 py-1.5 font-sans">{b.band}</td><td className={TH}>{b.n}</td>
                <td className={`${TH} font-bold ${tone(b.netR, b.n > 0)}`}>{b.n ? rr(b.netR) : '–'}</td><td className={TH}>{b.n ? rr(b.old) : '–'}</td>
                <td className={TH}>{b.n ? rr(b.netR - b.old) : '–'}</td><td className={TH}>{b.n ? fx(b.t) : '–'}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
      {pb && (
        <p className="mt-2 text-[11px] text-ink-2">
          Placebo (models trained on shuffled outcomes, traded on the real ones): {pb.dev.n} trades, <b className={tone(pb.dev.netR, pb.dev.n > 0)}>{pb.dev.n ? rr(pb.dev.netR) : '–'}</b> a trade (t {fx(pb.dev.t)}).{' '}
          {pb.dev.n >= 100 && pb.dev.t >= 2 && pb.dev.netR > 0 ? <b className="text-data-red-text">It shows an edge: something leaks. Do not trust this run.</b> : 'No edge, as it should be.'}
        </p>
      )}
      <p className="mt-1 text-[11px] text-ink-3">Real fills: 5 lakh–3M shares a day 3 ticks worse in and out (target must trade through by 3), stops slip 0.20% of price; 3–5M 2 ticks, 0.10%; 5–7M 1 tick, 0.06%; 7–10M 1 tick, 0.05%; 10M+ 1 tick, 0.04%; a stop in a fast candle slips at least 10% of that 10-min candle. Untouched months are a second look, not a clean test.</p>
    </Card>
  );
}
/** Algo Live's real fills next to what the backtest assumed (read only: lib/algoLive/fills.ts, /api/algo/fills) */
interface FillRow { date: string; symbol: string; time: string; avgVol?: number; signal: number; entry: number; stop: number; target: number; exit: number | null; exitType: string; entryTicks: number; stopTicks: number | null; stopPct: number | null; targetTicks: number | null; extraR: number; matched: boolean }
interface FillSum { trades: number; matched: number; entryTicks: number | null; stopsHit: number; stopTicks: number | null; stopPct: number | null; targetsHit: number; targetTicks: number | null; manual: number; extraR: number | null }
const FILLS_NEEDED = 20, STOPS_NEEDED = 8;
function LiveFillsCard({ ml }: { ml: Ml }) {
  const [f, setF] = useState<{ rows: FillRow[]; summary: FillSum } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/algo/fills', { cache: 'no-store' }).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setF(j);
    }).catch((e) => setErr((e as Error).message));
  }, []);
  const old = ml.strategies.find((x) => x.id === 'fCap2')?.dev.netR, est = ml.strategies.find((x) => x.id === 'vAll')?.dev.netR;
  const s = f?.summary;
  const done = s ? s.trades - (f!.rows.filter((r) => r.exitType === 'OPEN').length) : 0;
  const proj = s && s.extraR !== null && old !== undefined ? old - s.extraR : null;
  let verdict: React.ReactNode = null;
  if (s && done < FILLS_NEEDED) verdict = <b className="text-ink-2">Too few trades yet: {done} of {FILLS_NEEDED}. Keep F at ₹300 risk.</b>;
  else if (proj !== null && old !== undefined && est !== undefined) {
    const stopsOk = s!.stopsHit >= STOPS_NEEDED;
    if (proj >= old - 0.015 && stopsOk) verdict = <b className="text-data-green">Fills are close to the backtest&apos;s own: F is about {rr(proj)} a trade. Scaling up can be considered.</b>;
    else if (proj <= est + 0.01) verdict = <b className="text-data-red-text">Fills are as bad as the estimate or worse: F is about {rr(proj)} a trade. Stay at ₹300 risk.</b>;
    else verdict = <b className="text-brand-accent">In between: F is about {rr(proj)} a trade{stopsOk ? '' : ` (only ${s!.stopsHit} stops so far, ${STOPS_NEEDED} needed to judge stops)`}. Stay at ₹300 risk for now.</b>;
  }
  return (
    <Card title="Live fills vs the backtest" sub={`Algo Live's real entries and exits (its orders and your journal) against what the backtest assumed: 1 tick worse in, 1 tick worse on a stop, targets at their price. Exits by hand count only for the entry. Backtest F as live: ${old !== undefined ? rr(old) : '–'} a trade with those fills, ${est !== undefined ? rr(est) : '–'} with iteration 11's estimate.`}>
      {err && <p className="text-xs text-data-red-text">{err}</p>}
      {!f && !err && <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-4 w-4 animate-spin" />Reading fills…</p>}
      {s && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-sm">
            <div><p className="text-[10px] uppercase tracking-widest text-ink-3">Entry, ticks worse</p><p className="font-mono font-bold">{fx(s.entryTicks)} <span className="text-[11px] font-normal text-ink-3">(backtest 1, est. up to 3)</span></p></div>
            <div><p className="text-[10px] uppercase tracking-widest text-ink-3">Stops hit</p><p className="font-mono font-bold">{s.stopsHit}{s.stopsHit ? ` · ${fx(s.stopTicks)} ticks (${fx(s.stopPct, 2)}%)` : ''} <span className="text-[11px] font-normal text-ink-3">(backtest 1 tick, est. up to 0.20%)</span></p></div>
            <div><p className="text-[10px] uppercase tracking-widest text-ink-3">Targets hit</p><p className="font-mono font-bold">{s.targetsHit}{s.targetsHit ? ` · ${fx(s.targetTicks)} ticks` : ''}</p></div>
            <div><p className="text-[10px] uppercase tracking-widest text-ink-3">R lost vs backtest</p><p className={`font-mono font-bold ${tone(s.extraR === null ? null : -s.extraR, s.extraR !== null)}`}>{s.extraR === null ? '–' : rr(-s.extraR)} <span className="text-[11px] font-normal text-ink-3">a trade</span></p></div>
          </div>
          <p className="mt-2 text-sm">{verdict}</p>
          {f!.rows.length > 0 && (
            <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[720px] text-xs"><thead><tr className={HEAD}>
              <th className="px-2 py-1.5 text-left">Day</th><th className="px-2 py-1.5 text-left">Stock</th><th className={TH}>Signal</th><th className={TH}>Entry</th><th className={TH}>In (ticks)</th><th className={TH}>Exit</th><th className={TH}>How</th><th className={TH}>Out (ticks)</th><th className={TH}>R lost</th>
            </tr></thead><tbody>
              {f!.rows.slice().reverse().map((r) => (
                <tr key={`${r.date}-${r.symbol}`} className="border-b border-line/60 font-mono tabular-nums">
                  <td className="px-2 py-1.5">{r.date.slice(5)} {r.time}</td><td className="px-2 py-1.5 font-sans">{r.symbol}</td>
                  <td className={TH}>{r.signal.toFixed(2)}</td><td className={TH}>{r.entry.toFixed(2)}</td><td className={TH}>{fx(r.entryTicks)}</td>
                  <td className={TH}>{r.exit ? r.exit.toFixed(2) : '–'}</td><td className={TH}>{r.matched ? r.exitType : 'not in journal yet'}</td>
                  <td className={TH}>{r.stopTicks !== null ? fx(r.stopTicks) : r.targetTicks !== null ? fx(r.targetTicks) : '–'}</td>
                  <td className={`${TH} ${tone(-r.extraR, r.exitType !== 'OPEN')}`}>{rr(-r.extraR)}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
          {f!.rows.length === 0 && <p className="text-xs text-ink-3">No filled Algo Live orders yet.</p>}
        </>
      )}
    </Card>
  );
}
interface Untouched { id: string; name: string; from?: string; to?: string; note?: string; overall: P; months?: (S & { month: string })[]; trainMonths?: [string, string]; valMonths?: [string, string] }
interface CPart { n: number; base: number; rule: number; diff: number; t: number; monthsGreenBase: number; monthsGreenRule: number; months: number; addRate: number }
interface Confirmed { strategy: string; rule: string; label: string; decide: CPart; exam: { pass: boolean | null; n: number }; untouched: CPart | null; shadow: CPart | null; baseMismatch: number }
interface Money { stopPct: number; position: number; margin: number; maxPerDay: number; tradesPerMonth: number; perTrade: number; perMonth: number; worstMonth: number; bestMonth: number; maxDrawdownR: number; capital: number; pct: number; bigger: { position: number; risk: number; netR: number; perMonth: number; capital: number; pct: number }[] }

function UntouchedCard({ u }: { u: Untouched }) {
  return (
    <Card title={`Untouched test: ${u.name}`} sub={u.from ? `${mon(u.from)}–${mon(u.to!)}: months no iteration ever trained or decided on. The models learned from ${mon(u.trainMonths![0])}–${mon(u.trainMonths![1])} and the bar to trade was set on ${mon(u.valMonths![0])}–${mon(u.valMonths![1])} (no older data exists); every fact is still only what was known at that minute.` : u.note}>
      <Tiles items={[
        ['Trades', u.overall.n.toLocaleString('en-IN')],
        ['R per trade after costs', rr(u.overall.netR), tone(u.overall.netR, u.overall.n > 0)],
        ['How sure (t)', fx(u.overall.t)],
        ['Months green', `${u.overall.monthsGreen} of ${u.overall.monthsTraded}`],
      ]} />
      {!!u.months?.length && <p className="mt-2 font-mono text-[11px] text-ink-2">{u.months.map((m) => `${mon(m.month)} ${m.n ? rr(m.netR) : '–'}`).join(' · ')}</p>}
    </Card>
  );
}

function ConfirmCard({ c }: { c: Confirmed }) {
  const row = (name: string, p: CPart | null, note?: string) => (
    <tr key={name} className="border-b border-line/60 font-mono tabular-nums">
      <td className="px-2 py-1.5 font-sans">{name}</td>
      {p ? <>
        <td className={TH}>{p.n}</td><td className={`${TH} ${tone(p.base)}`}>{rr(p.base)}</td><td className={`${TH} font-bold ${tone(p.rule)}`}>{rr(p.rule)}</td>
        <td className={`${TH} ${tone(p.diff)}`}>{rr(p.diff)}</td><td className={TH}>{fx(p.t)}</td><td className={TH}>{p.monthsGreenBase} → {p.monthsGreenRule} of {p.months}</td><td className={TH}>{pct(p.addRate)}</td>
      </> : <td className="px-2 py-1.5 text-ink-3" colSpan={7}>{note ?? 'no trades yet'}</td>}
    </tr>
  );
  return (
    <Card title="Adding to winners: the rule fixed in advance" sub={`${c.label}. Picked in iteration 8; nothing is chosen here. "As now" replays the model's own results exactly (${c.baseMismatch} mismatches).`}>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead><tr className={HEAD}><th className="px-2 py-1.5 text-left">Months</th><th className={TH}>Trades</th><th className={TH}>As now</th><th className={TH}>With adding</th><th className={TH}>Difference</th><th className={TH}>t</th><th className={TH}>Months green</th><th className={TH}>Added on</th></tr></thead>
          <tbody>
            {row('Untouched (Jan–Sep 2022): the one shot', c.untouched, 'no untouched trades')}
            {row('Decide months', c.decide)}
            {row('Shadow (new months)', c.shadow)}
            <tr><td className="px-2 py-1.5 font-sans" colSpan={8}>Exam months: {c.exam.pass == null ? '–' : c.exam.pass ? 'Pass (adding did better and made money)' : 'Fail'}</td></tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function MoneyCard({ m }: { m: Money }) {
  return (
    <Card title="What it means in money" sub={`Decide months, after charges, at ₹300 risk a trade. The stop is about ${m.stopPct}% of the price, so ₹300 risk buys about ₹${m.position.toLocaleString('en-IN')} of stock: ₹${m.margin.toLocaleString('en-IN')} of margin at 5×, up to ${m.maxPerDay} at once. Capital = that margin for ${m.maxPerDay} trades + the deepest run of losses (${m.maxDrawdownR}R). Before income tax.`}>
      <Tiles items={[
        ['Per trade, average', inr(m.perTrade)],
        ['Trades a month', String(m.tradesPerMonth)],
        ['Per month, average', inr(m.perMonth), tone(m.perMonth)],
        ['Capital it needs', `₹${m.capital.toLocaleString('en-IN')}`],
        ['% a month on that capital', `${m.pct}%`, tone(m.pct)],
        ['Worst month', inr(m.worstMonth), 'text-data-red-text'],
        ['Best month', inr(m.bestMonth), 'text-data-green'],
        ['Deepest run of losses', `−${m.maxDrawdownR}R (${inr(-m.maxDrawdownR * 300)})`],
      ]} />
      {!!m.bigger.length && (
        <p className="mt-2 text-[11px] text-ink-2">Bigger positions (cheaper charges per R): {m.bigger.map((b) => `₹${(b.position / 1e5).toFixed(0)} lakh positions risk ~₹${b.risk.toLocaleString('en-IN')} a trade → ${inr(b.perMonth)} a month on ~₹${b.capital.toLocaleString('en-IN')} capital (${b.pct}%)`).join(' · ')}.</p>
      )}
    </Card>
  );
}

interface MLine { id: string; family: string; label: string; n: number; netR: number; diff: number; t: number; hit: number; addRate: number }
interface Mgmt { strategy: string; variantsTested: number; trades: number; baseChecked: number; baseMismatch: number; skippedNoData: number; half1: [string, string]; half2: [string, string]; nHalf1: number; nHalf2: number; stage1: MLine[]; picked: string[]; stage2: MLine[]; winner: string; winnerBeatsBase: boolean }

function MgmtTable({ rows, best }: { rows: MLine[]; best?: string }) {
  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="w-full min-w-[640px] text-xs">
        <thead><tr className={HEAD}>
          <th className="px-2 py-1.5 text-left">How the trade is managed</th><th className={TH}>R / trade</th><th className={TH}>vs as now</th><th className={TH}>t</th><th className={TH}>Made money</th><th className={TH}>Added on</th>
        </tr></thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.id} className={`border-b border-line/60 font-mono tabular-nums ${l.id === best ? 'bg-data-green/10' : ''}`}>
              <td className="px-2 py-1.5 font-sans">{l.label}</td>
              <td className={`${TH} font-bold ${tone(l.netR)}`}>{rr(l.netR)}</td>
              <td className={`${TH} ${l.id === 'base' ? 'text-ink-3' : tone(l.diff)}`}>{l.id === 'base' ? '–' : rr(l.diff)}</td>
              <td className={TH}>{l.id === 'base' ? '–' : fx(l.t)}</td>
              <td className={TH}>{pct(l.hit)}</td>
              <td className={TH}>{l.family === 'add1' || l.family === 'add2' || l.family === 'combo' ? pct(l.addRate) : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Management({ m }: { m: Mgmt }) {
  const fam = (f: string, k: number) => m.stage1.filter((l) => l.family === f).sort((a, b) => b.netR - a.netR).slice(0, k);
  const base1 = m.stage1.find((l) => l.id === 'base');
  const win = m.stage2.find((l) => l.id === m.winner);
  return (
    <Card title="Managing the same trades: break-even and adding" sub={`The same ${m.trades.toLocaleString('en-IN')} trades (decide months), replayed minute by minute ${m.variantsTested} ways. "As now" replays the model's own result exactly for ${m.baseChecked - m.baseMismatch} of ${m.baseChecked} trades. Stage 1 picks on ${mon(m.half1[0])}–${mon(m.half1[1])}; stage 2 judges on ${mon(m.half2[0])}–${mon(m.half2[1])}, which played no part in picking.`}>
      <p className={`mb-3 rounded-xl border px-3 py-2 text-sm font-bold ${m.winnerBeatsBase ? 'border-data-green/60 bg-data-green/10 text-data-green' : 'border-line-strong text-ink-2'}`}>
        {m.winnerBeatsBase && win
          ? `Winner on the second half: ${win.label}: ${rr(win.netR)} a trade vs ${rr(win.netR - win.diff)} as now (+${win.diff.toFixed(3)}R, t ${fx(win.t)}). It gets one shot at the untouched months next.`
          : 'Nothing beat "as now" clearly (t ≥ 2) on the second half. Stop and target only stays.'}
      </p>
      <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-ink-3">Stage 2: the picks and their combinations, second half only</p>
      <MgmtTable rows={[...m.stage2].sort((a, b) => b.netR - a.netR)} best={m.winnerBeatsBase ? m.winner : undefined} />
      <details className="mt-3">
        <summary className="cursor-pointer text-[11px] font-bold text-ink-2">Stage 1: each family on its own, first half (best of each)</summary>
        <div className="mt-2 space-y-3">
          {base1 && <MgmtTable rows={[base1]} />}
          <MgmtTable rows={fam('be', 3)} />
          <MgmtTable rows={fam('add1', 8)} />
          <MgmtTable rows={fam('add2', 8)} />
        </div>
      </details>
    </Card>
  );
}
interface Line { id: string; name: string; n: number; netR: number; gross: number | null; t: number; monthsGreen: number; monthsTraded: number; dev: number | null; exam: number | null; ic: number | null }
interface Head { runId: string; createdAt: number; iteration: number; code?: string | null; lines: Line[] }
const codeLink = (sha?: string | null) => (sha ? <a className="underline" href={`https://github.com/Niskarsh/tradereye/commit/${sha}`} target="_blank" rel="noreferrer">{sha.slice(0, 7)}</a> : null);

const inr = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${x < 0 ? '−' : '+'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`);
const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const mon = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const tone = (x: number | null | undefined, on = true) => (!on || x == null ? 'text-ink-3' : x > 0 ? 'text-data-green' : 'text-data-red-text');
const fx = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));

/** the exam as Pass / Fail only (its numbers never steer anything) */
const examPass = (e: { n: number; netR: number; pass?: boolean | null }) => (e.pass !== undefined ? e.pass : e.n >= 30 ? e.netR > 0 : null);
const passText = (p: boolean | null | undefined) => (p == null ? '–' : p ? 'Pass' : 'Fail');

/** the honest one-line verdict for a strategy: judged on the decide months, confirmed (or not) by the exam's Pass / Fail */
function verdict(s: Strat): { text: string; cls: string } {
  const { dev } = s;
  const green = 'border-data-green/60 bg-data-green/10 text-data-green', amber = 'border-brand-accent/60 bg-brand-accent/10 text-brand-accent', red = 'border-data-red/60 bg-data-red/10 text-data-red-text';
  if (dev.n < 100) return { text: 'Not enough trades to judge.', cls: 'border-line-strong text-ink-2' };
  const devGood = dev.netR > 0 && dev.t >= 2 && dev.monthsGreen >= 0.6 * dev.monthsTraded;
  const pass = examPass(s.exam);
  if (devGood && pass) return { text: 'Candidate edge: profitable after costs on the decide months (sure enough, green most months), and it passes the exam.', cls: green };
  if (devGood) return { text: 'Profitable on the decide months but it does not pass the exam (or has too few exam trades). Treat with suspicion.', cls: amber };
  if (dev.netR > 0) return { text: 'Slightly profitable on the decide months, but not sure enough (t under 2 or too many red months). Could be luck.', cls: amber };
  if (dev.gross > 0) return { text: `Some signal before costs (${rr(dev.gross)} a trade), but the charges eat it (${rr(dev.netR)} after). Close, not there.`, cls: amber };
  return { text: 'No edge: these trades lose money even before costs.', cls: red };
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
            <th className={TH}>Trades</th><th className={TH}>Decide months (R / trade)</th><th className={TH}>Exam</th><th className={TH}>Signal</th>
          </tr></thead>
          <tbody>
            {history.flatMap((h) => h.lines.map((l, i) => (
              <tr key={`${h.runId}${l.id}`} className="border-b border-line/60 font-mono tabular-nums">
                <td className="px-2 py-1.5 font-sans font-bold">{i === 0 ? h.iteration : ''}</td>
                <td className="px-2 py-1.5 font-sans text-ink-3">{i === 0 ? <>{new Date(h.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} {codeLink(h.code)}</> : ''}</td>
                <td className="px-2 py-1.5 font-sans">{l.name}</td>
                <td className={TH}>{l.n}</td>
                <td className={`${TH} font-bold ${tone(l.dev ?? l.netR, l.n > 0)}`}>{rr(l.dev ?? l.netR)}</td>
                <td className={TH}>{passText(l.exam == null ? null : l.exam > 0)}</td>
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
  const mg = ml.management?.find((m) => m.strategy === s.id);
  const v = verdict(s);
  const o = s.overall;
  const neutral = s.kind === 'neutral';
  return (
    <>
      <p className="text-xs text-ink-2">{s.desc}</p>
      <p className={`rounded-xl border px-3 py-2 text-sm font-bold ${v.cls}`}>{v.text}</p>
      <Tiles items={[
        ['Trades (decide months)', s.dev.n.toLocaleString('en-IN')],
        ['R per trade after costs', rr(s.dev.netR), tone(s.dev.netR, s.dev.n > 0)],
        ['R per trade before costs', rr(s.dev.gross), tone(s.dev.gross, s.dev.n > 0)],
        ['How sure (t)', fx(s.dev.t)],
        ['Months green', `${s.dev.monthsGreen} of ${s.dev.monthsTraded}`],
        [`Exam (from ${mon(ml.examFrom)})`, passText(examPass(s.exam)), examPass(s.exam) == null ? undefined : examPass(s.exam) ? 'text-data-green' : 'text-data-red-text'],
        ['Per month, at ₹300 risk', inr(s.dev.monthsTotal ? s.dev.inr / s.dev.monthsTotal : null), tone(s.dev.inr, s.dev.n > 0)],
        ['Signal (does it know anything?)', s.ic.mean == null ? '–' : `${fx(s.ic.mean, 3)} · ${s.ic.positive}/${s.ic.months} months +`, tone(s.ic.mean)],
        ['Made money after costs', s.dev.n ? pct(s.dev.hit) : '–'],
      ]} />
      <p className="text-[11px] text-ink-3">Every number on this page is from the decide months ({o.n ? 'before ' + mon(ml.examFrom) : ''}). The exam months only show Pass / Fail, so they never steer the next step.</p>
      <p className="text-[11px] text-ink-3">
        Taking every moment blindly with this trade makes {rr(s.baseline.long)} long / {rr(s.baseline.short)} short after costs
        ({rr(s.baseline.longGross)} / {rr(s.baseline.shortGross)} before): that is what the model has to beat.
        {neutral && ` Baskets at ${ml.setup.neutralTimes.join(', ')}: ${ml.setup.neutralK} longs + ${ml.setup.neutralK} shorts, each stock once a day.`}
      </p>

      {s.money && <MoneyCard m={s.money} />}
      {s.shadow && (
        <Card title={`Shadow months (from ${mon(s.shadow.from ?? ml.shadowFrom ?? '2026-11')})`} sub="Months that did not exist when this code was written: the forward test. Never used for any decision. Re-run once a month to add the newest month.">
          {s.shadow.n ? <Tiles items={[
            ['Trades', String(s.shadow.n)], ['R per trade after costs', rr(s.shadow.netR), tone(s.shadow.netR)],
            ['Months green', `${s.shadow.monthsGreen} of ${s.shadow.monthsTraded}`], ['₹ at ₹300 risk', inr(s.shadow.inr), tone(s.shadow.inr)],
          ]} /> : <p className="text-xs text-ink-3">No shadow months yet: the first one is reported after it ends.</p>}
        </Card>
      )}
      {ml.confirm?.filter((c) => c.strategy === s.id).map((c) => <ConfirmCard key={c.rule} c={c} />)}
      {mg && <Management m={mg} />}
      {ml.managementError && <p className="text-xs text-data-red-text">Trade management did not run: {ml.managementError}</p>}

      {s.daily && (
        <Card title="Your day, if you traded it by hand" sub="Decide months, after costs at ₹300 risk. What paper-trading this would feel like.">
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
                <th className="px-2 py-1.5 text-left">Execution</th><th className={TH}>Trades</th><th className={TH}>R after costs</th><th className={TH}>t</th>
                <th className={TH}>Months green</th><th className={TH}>Exam</th>
              </tr></thead>
              <tbody>
                {s.costs.map((c) => (
                  <tr key={c.id} className="border-b border-line/60 font-mono tabular-nums">
                    <td className="px-2 py-1.5 font-sans">{c.name}</td>
                    <td className={TH}>{c.dev.n}</td>
                    <td className={`${TH} font-bold ${tone(c.dev.netR, c.dev.n > 0)}`}>{c.dev.n ? rr(c.dev.netR) : '–'}</td>
                    <td className={TH}>{c.dev.n ? fx(c.dev.t) : '–'}</td>
                    <td className={TH}>{c.devMonths[0]} / {c.devMonths[1]}</td>
                    <td className={TH}>{passText(examPass(c.exam))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Month by month (every month traded blind)" sub="Decide months. A real edge is green most months, not just one big month. The bar to trade and 'stood aside' were decided on the months just before each month. The exam months are one Pass / Fail line.">
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full min-w-[620px] text-xs">
            <thead><tr className={HEAD}>
              <th className="px-2 py-1.5 text-left">Month</th><th className={TH}>Trades</th><th className={TH}>Made money</th><th className={TH}>Before costs</th>
              <th className={TH}>R per trade</th><th className={TH}>Total R</th><th className={TH}>₹ at ₹300 risk</th><th className={TH}>Signal</th><th className="px-2 py-1.5 text-left"></th>
            </tr></thead>
            <tbody>
              {s.months.filter((m) => !m.exam).map((m) => (
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
              <tr className="border-b border-line/60 bg-brand-accent/5">
                <td className="px-2 py-1.5 font-sans" colSpan={9}>Exam months ({mon(ml.examFrom)} on): <b>{passText(examPass(s.exam))}</b></td>
              </tr>
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
            {(Array.isArray(v2.untouched) ? v2.untouched : v2.untouched ? [v2.untouched] : []).filter((u) => !['f1055', 'fCap3', 'fCap2', 'fStrict', 'vAll', 'v3m', 'v5m', 'v7m', 'v10m'].includes(u.id)).map((u) => <UntouchedCard key={u.id} u={u} />)}
            {v2.noise && v2.noise.draws.length > 1 && (
              <Card title="How much is luck in the training?" sub={`The locked strategy trained ${v2.noise.draws.length} times with different random draws (same data, same rules). The spread is the noise: differences smaller than this between iterations mean nothing.`}>
                <p className="text-sm">Decide months: <b className="font-mono">{rr(v2.noise.devMin)} to {rr(v2.noise.devMax)}</b> a trade (average {rr(v2.noise.devMean)}).</p>
                <p className="mt-1 font-mono text-[11px] text-ink-2">{v2.noise.draws.map((d) => `${d.draw}: ${rr(d.devNetR)} (t ${fx(d.devT)}, ${d.devGreen[0]}/${d.devGreen[1]} green)`).join(' · ')}</p>
              </Card>
            )}
            <CapCard ml={v2} />
            <LiquidityCard ml={v2} />
            <LiveFillsCard ml={v2} />
            <div className="flex flex-wrap gap-2">
              {v2.strategies.map((x) => (
                <button key={x.id} onClick={() => setPick(x.id)}
                  className={`rounded-full border px-3 py-1 text-xs font-bold ${x.id === s.id ? 'border-brand-accent bg-brand-accent/15 text-brand-accent' : 'border-line text-ink-2'}`}>
                  {x.name} <span className={`font-mono ${tone(x.dev.netR, x.dev.n > 0)}`}>{x.dev.n ? rr(x.dev.netR) : '–'}</span>
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
