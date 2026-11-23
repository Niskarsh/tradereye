"use client";
import React from 'react';
import { Card, rr } from '@/components/setups/parts';

/** Iteration 17's result block (scripts/ml_iter17_layers.py `iter17`) */
interface P { n: number; netR: number; t: number; monthsGreen?: number; monthsTraded?: number; pass?: boolean | null }
interface Row {
  id: string; version: string; be: number; name: string; dev: P; exam: P; shadow?: P; untouched: (P & { lessons?: string[] }) | null;
  draws: Record<string, { n: number; netR: number; sizeR: number }>; atSize: { position: number; dev: P; exam: P };
}
interface Check { cases: number; stocks: number; maxShare: number | null; quarters: [number, number] | null; looMin: number | null; total: number; pass: boolean }
export interface Iter17 {
  table: Row[];
  placeboC: { id: string; name: string; dev: P; devNetR: number } | null;
  placebo: { dev: P } | null;
  oldFills: { dev: P; exam: P } | null;
  lessons: Record<string, { final: Record<string, Check>; active: { month: string; active: string[] }[] }>;
  losses: Record<string, Record<string, number>>;
  verdict: {
    pick: string | null; outcome: string; message: string; placeboClean: boolean; placeboCGap: number | null;
    versions: { id: string; name: string; gain: number; checks: { label: string; ok: boolean }[]; pass: boolean }[];
    breakEven: { id: string; version: string; at: number; dev: number; exam: number; untouched: number | null; pass: boolean }[];
  };
  data?: { sectors?: { ok: boolean; indices?: string[]; missingIndustries?: string[]; stockDaysWithSector?: number; stockDays?: number; error?: string }; results?: { ok: boolean; meetings?: number; stocks?: number; flaggedStockDays?: number; error?: string } };
  structureFacts?: Record<string, { inTop15: { f: string; label: string; share: number }[] }>;
}

const TH = 'px-2 py-1.5 text-right';
const HEAD = 'border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3';
const tone = (x: number | null | undefined, on = true) => (!on || x == null ? 'text-ink-3' : x > 0 ? 'text-data-green' : 'text-data-red-text');
const fx = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));
const pass = (p: boolean | null | undefined) => (p == null ? '–' : p ? 'Pass' : 'Fail');
const VERS = ['A', 'B', 'C', 'D', 'BC', 'BD', 'CD', 'BCD'];
const LESSON_NAMES: Record<string, string> = { veto: 'Skip trades the loss model expects to lose', exit1: 'Exit early after the 1st candle', exit2: 'Exit early after the 2nd candle', exit3: 'Exit early after the 3rd candle' };
const LOSS_NAMES: Record<string, string> = { win: 'Winners', fast: 'Fast stop (≤30 min)', nearTarget: 'Turned near target (70%+)', stopped: 'Other stops', drift: 'Drift to 15:15', shock: 'Shock (3+ ATR candle)' };

export function Iter17Card({ it, onPick }: { it: Iter17; onPick?: (id: string) => void }) {
  const by = Object.fromEntries(it.table.map((r) => [r.id, r]));
  const a = by.A;
  const v = it.verdict;
  const yes = (ok: boolean) => (ok ? '✓' : '✗');
  const be = (ver: string, at: number) => v.breakEven.find((x) => x.version === ver && x.at === at);
  const ds = it.data;
  return (
    <>
      <Card title="Iteration 17: does anything beat iteration 10?" sub="Decide months, Algo Live's realistic fills, after costs at ₹300 risk. Every version is judged against the control (A) in the same run. Algo Live is not affected by this run.">
        <p className={`text-sm font-bold ${v.outcome === 'better' ? 'text-data-green' : 'text-data-red-text'}`}>{v.message}</p>
        <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[860px] text-xs"><thead><tr className={HEAD}>
          <th className="px-2 py-1.5 text-left">Version</th><th className={TH}>Trades</th><th className={TH}>R / trade</th><th className={TH}>t</th><th className={TH}>vs A</th>
          <th className={TH}>Months green</th><th className={TH}>Untouched</th><th className={TH}>Exam</th><th className={TH}>5 draws</th><th className={TH}>₹10 lakh</th>
          <th className={TH}>BE 80%</th><th className={TH}>BE 90%</th>
        </tr></thead><tbody>
          {VERS.filter((x) => by[x]).map((x) => {
            const r = by[x], b8 = be(x, 80), b9 = be(x, 90);
            const draws = Object.values(r.draws).map((d) => d.netR);
            return (
              <tr key={x} onClick={() => onPick?.(x)} className={`cursor-pointer border-b border-line/60 font-mono tabular-nums ${v.pick === x ? 'bg-data-green/10' : ''}`}>
                <td className="px-2 py-1.5 font-sans">{r.name.split(' · ')[0]}</td><td className={TH}>{r.dev.n}</td>
                <td className={`${TH} font-bold ${tone(r.dev.netR, r.dev.n > 0)}`}>{r.dev.n ? rr(r.dev.netR) : '–'}</td><td className={TH}>{fx(r.dev.t)}</td>
                <td className={`${TH} ${x === 'A' ? 'text-ink-3' : tone(r.dev.netR - a.dev.netR)}`}>{x === 'A' ? '–' : rr(r.dev.netR - a.dev.netR)}</td>
                <td className={TH}>{r.dev.monthsGreen}/{r.dev.monthsTraded}</td>
                <td className={`${TH} ${tone(r.untouched?.netR, !!r.untouched?.n)}`}>{r.untouched?.n ? `${rr(r.untouched.netR)} (t ${fx(r.untouched.t)})` : '–'}</td>
                <td className={TH}>{pass(r.exam.pass)}</td>
                <td className={TH}>{draws.length ? `${rr(Math.min(...draws))} to ${rr(Math.max(...draws))}` : '–'}</td>
                <td className={`${TH} ${tone(r.atSize.dev.netR, r.atSize.dev.n > 0)}`}>{rr(r.atSize.dev.netR)}</td>
                <td className={`${TH} ${b8?.pass ? 'font-bold text-data-green' : tone(b8?.dev)}`}>{b8 ? rr(b8.dev) : '–'}</td>
                <td className={`${TH} ${b9?.pass ? 'font-bold text-data-green' : tone(b9?.dev)}`}>{b9 ? rr(b9.dev) : '–'}</td>
              </tr>
            );
          })}
        </tbody></table></div>
        <p className="text-[11px] text-ink-3">BE columns: what moving the stop to break-even after costs at 80% / 90% of the way to the target adds to that version on the decide months (green and bold = better on the decide, exam and untouched months alike). ₹10 lakh: R a trade with a ₹10 lakh position&apos;s charges and market impact. Click a row for its full detail below.</p>
        {it.oldFills && a && <p className="text-[11px] text-ink-2">The control at iteration 10&apos;s old fills: {rr(it.oldFills.dev.netR)} a trade (t {fx(it.oldFills.dev.t)}) against {rr(a.dev.netR)} on Algo Live&apos;s realistic fills.</p>}
      </Card>

      <Card title="The rule, version by version" sub="Fixed before the run. A version passes only if every check holds.">
        <div className="space-y-2">
          {v.versions.map((x) => (
            <p key={x.id} className="text-xs text-ink-2">
              <span className={`font-black ${x.pass ? 'text-data-green' : 'text-ink-1'}`}>{x.name.split(' · ')[0]} ({rr(x.gain)} vs A): </span>
              {x.checks.map((c) => `${yes(c.ok)} ${c.label}`).join(' · ')}
            </p>
          ))}
        </div>
        <p className="text-[11px] text-ink-3">
          Random lines (C&apos;s placebo): {it.placeboC ? `${rr(it.placeboC.dev.netR)} a trade (${it.placeboC.dev.n} trades); C beats it by ${v.placeboCGap == null ? '–' : rr(v.placeboCGap)}` : 'did not run'} · shuffled-outcome placebo: {it.placebo ? `${rr(it.placebo.dev.netR)} (t ${fx(it.placebo.dev.t)}), ${v.placeboClean ? 'clean' : 'NOT clean'}` : '–'}.
        </p>
      </Card>

      {Object.keys(it.lessons).length > 0 && (
        <Card title="What the losses taught (B)" sub="Each lesson's record on the decide months, from models trained only on earlier months. A lesson acts in a month only after its record so far passes all four checks: 20+ stocks and none over 10%, the same direction in 70%+ of quarters, still positive with its best stock left out, more net R after the winners it cuts.">
          {['B', 'BC', 'BD', 'BCD'].filter((k) => it.lessons[k]).map((k) => {
            const L = it.lessons[k];
            return (
              <div key={k} className="overflow-x-auto">
                <p className="text-[11px] font-black text-ink-1">{by[k]?.name.split(' · ')[0] ?? k}</p>
                <table className="w-full min-w-[640px] text-xs"><thead><tr className={HEAD}>
                  <th className="px-2 py-1.5 text-left">Lesson</th><th className={TH}>Trades changed</th><th className={TH}>Stocks</th><th className={TH}>Top stock share</th><th className={TH}>Quarters +</th><th className={TH}>Best stock out</th><th className={TH}>Net R added</th><th className={TH}>Months acting</th><th className={TH}>Passes</th>
                </tr></thead><tbody>
                  {Object.entries(L.final).map(([name, c]) => (
                    <tr key={name} className="border-b border-line/60 font-mono tabular-nums">
                      <td className="px-2 py-1.5 font-sans">{LESSON_NAMES[name] ?? name}</td><td className={TH}>{c.cases}</td><td className={TH}>{c.stocks}</td>
                      <td className={TH}>{c.maxShare == null ? '–' : `${Math.round(c.maxShare * 100)}%`}</td><td className={TH}>{c.quarters ? `${c.quarters[0]}/${c.quarters[1]}` : '–'}</td>
                      <td className={`${TH} ${tone(c.looMin)}`}>{c.looMin == null ? '–' : `${c.looMin > 0 ? '+' : ''}${c.looMin}R`}</td>
                      <td className={`${TH} ${tone(c.total)}`}>{`${c.total > 0 ? '+' : ''}${c.total}R`}</td>
                      <td className={TH}>{L.active.filter((m) => m.active.includes(name)).length}/{L.active.length}</td>
                      <td className={`${TH} font-bold ${c.pass ? 'text-data-green' : 'text-data-red-text'}`}>{c.pass ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody></table>
              </div>
            );
          })}
          {it.losses.A && (
            <p className="text-[11px] text-ink-2">The control&apos;s trades on the decide months: {Object.entries(it.losses.A).map(([k, n]) => `${LOSS_NAMES[k] ?? k} ${n}`).join(' · ')}. Shocks never teach.</p>
          )}
        </Card>
      )}

      <Card title="Data behind C and D" sub="Where the new facts came from in this run.">
        <p className="text-xs text-ink-2">
          <b>Sector:</b> {ds?.sectors?.ok ? `${ds.sectors.indices?.length ?? 0} NSE sector indices (${ds.sectors.indices?.join(', ')}); a sector on ${ds.sectors.stockDaysWithSector ?? 0} of ${ds.sectors.stockDays ?? 0} stock-days (stocks outside the Nifty 500 have none)${ds.sectors.missingIndustries?.length ? `; no index for ${ds.sectors.missingIndustries.join(', ')}` : ''}.` : `not available (${ds?.sectors?.error ?? 'unknown'}).`}
        </p>
        <p className="text-xs text-ink-2">
          <b>Results days:</b> {ds?.results?.ok ? `${ds.results.meetings} results meetings for ${ds.results.stocks} companies (NSE board meetings); ${ds.results.flaggedStockDays} stock-days skipped by D.` : `not available (${ds?.results?.error ?? 'unknown'}): D ran on the sector alone.`}
        </p>
        {it.structureFacts?.C && <p className="text-xs text-ink-2"><b>Chart structures in C&apos;s top 15 facts:</b> {it.structureFacts.C.inTop15.length ? it.structureFacts.C.inTop15.map((x) => `${x.label} ${Math.round(x.share * 100)}%`).join(' · ') : 'none'}.</p>}
      </Card>
    </>
  );
}
