"use client";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { TokenBar } from '@/components/auth/TokenBar';
import { ProgressBar } from '@/components/ui/progress';
import { Card, rr } from '@/components/setups/parts';
import { MeVsAlgoCard } from '@/components/algo/MeVsAlgoCard';
import type { Summary } from '@/lib/setups/stats';
import type { RunIndexItem, RunStatus } from '@/lib/setups/store';

/**
 * My Setups: the backtest Re-run (it feeds the Algo Lab and each month's Algo Live model), and below it what matters
 * after a run: whether its data is complete enough to make this month's model, and whether Algo Live has been trading
 * what the backtest says it should. Re-run fetches only what is new (a finished month of candles is never fetched again).
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

  const s = data?.summary ?? null;

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

        {!!data?.runs.length && <DataCheckCard runId={run || data.runs[0].runId} />}
        {!!data?.runs.length && <LiveCheckCard key={data.runs[0].runId} />}
        <MeVsAlgoCard token={token} />

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

/* ---------- after a run: is its data complete enough for this month's model? ---------- */

interface CheckMonth { month: string; sessions: number; niftyDays: number; planned: number; done: number; noCandles: number; noNifty: number; stocks: number; cover: number | null; ok: boolean }
interface Check {
  runId: string; createdAt: number; from: string; to: string; detailed: boolean; before: { runId: string; createdAt: number; to: string } | null;
  forMonth: string; tone: 'good' | 'warn' | 'bad'; verdict: string; issues: { month: string; text: string; recent: boolean }[]; months: CheckMonth[];
}
const monShort = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const TONE = { good: 'border-data-green/50 bg-data-green/10 text-data-green', warn: 'border-data-caution/50 bg-data-caution/10 text-data-caution', bad: 'border-data-red/50 bg-data-red/10 text-data-red-text' };

function DataCheckCard({ runId }: { runId: string }) {
  const [c, setC] = useState<Check | null | undefined>(undefined);
  const [err, setErr] = useState('');
  const [all, setAll] = useState(false);
  useEffect(() => {
    setC(undefined); setErr('');
    fetch(`/api/setups/check?run=${encodeURIComponent(runId)}`, { cache: 'no-store' }).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setC(j.check);
    }).catch((e) => setErr((e as Error).message));
  }, [runId]);
  const shown = c ? (all ? c.months : c.months.slice(0, 4)) : [];
  return (
    <Card title="This run's data" sub="Is it complete enough to make this month's Algo Live model? The model learns from the last 33 months; the last 3 set its bar.">
      {err && <p className="text-xs text-data-red-text">{err}</p>}
      {c === undefined && !err && <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-4 w-4 animate-spin" />Checking…</p>}
      {c && (
        <>
          <p className={`rounded-xl border px-3 py-2 text-sm font-bold ${TONE[c.tone]}`}>{c.verdict}</p>
          <p className="text-xs text-ink-2">
            {fmtDate(c.from)} – {fmtDate(c.to)}
            {c.before && (c.before.to < c.to ? <> · new since the run of {fmtTime(c.before.createdAt)}: {fmtDate(c.before.to)} → {fmtDate(c.to)}</> : <> · no new days since the run of {fmtTime(c.before.createdAt)}</>)}
          </p>
          {c.issues.length > 0 && (
            <ul className="space-y-1 text-xs">
              {c.issues.map((x) => <li key={x.month} className={x.recent ? 'text-data-red-text' : 'text-data-caution'}><b>{monShort(x.month)}{x.recent ? ' (bar month)' : ''}:</b> {x.text}</li>)}
            </ul>
          )}
          {!c.detailed && <p className="text-[11px] text-ink-3">This run was made before the month-by-month check existed: the verdict comes from its dates only. The next Re-run adds the full check.</p>}
          {c.detailed && (
            <>
              <div className="-mx-2 overflow-x-auto">
                <table className="w-full min-w-[420px] text-xs">
                  <thead><tr className="border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3">
                    <th className="px-2 py-1.5 text-left">Month</th><th className="px-2 py-1.5 text-right">Days</th><th className="px-2 py-1.5 text-right">Stocks</th><th className="px-2 py-1.5 text-right">Stock-days</th><th className="px-2 py-1.5 text-right">Complete</th>
                  </tr></thead>
                  <tbody>
                    {shown.map((m) => (
                      <tr key={m.month} className="border-b border-line/60 font-mono tabular-nums">
                        <td className="px-2 py-1.5 font-sans font-bold">{monShort(m.month)}</td>
                        <td className={`px-2 py-1.5 text-right ${m.niftyDays < m.sessions ? 'text-data-red-text' : ''}`}>{m.sessions}{m.niftyDays < m.sessions ? ` (${m.sessions - m.niftyDays} no Nifty)` : ''}</td>
                        <td className="px-2 py-1.5 text-right">{m.stocks}</td>
                        <td className="px-2 py-1.5 text-right">{m.done.toLocaleString('en-IN')}</td>
                        <td className={`px-2 py-1.5 text-right font-bold ${m.ok ? 'text-data-green' : 'text-data-red-text'}`}>{m.cover === null ? '–' : `${(Math.floor(m.cover * 1000) / 10).toFixed(1)}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-ink-3">Days = trading days · Stocks = stocks in your ₹250–340, 5-lakh universe that month · Complete = share of their stock-days replayed with full 1-minute candles (97%+ counts as complete).</p>
              {c.months.length > 4 && <button className="text-[11px] font-bold text-brand-accent underline" onClick={() => setAll(!all)}>{all ? 'Show the last 4 months' : `Show all ${c.months.length} months the model learns from`}</button>}
            </>
          )}
        </>
      )}
    </Card>
  );
}

/* ---------- is Algo Live trading what the backtest says it should? ---------- */

type Kind = 'same' | 'other-time' | 'missed' | 'extra';
interface LRow { symbol: string; kind: Kind; btTime?: string; liveTime?: string; btR?: number; liveR?: number | null; exit?: string; why: string }
interface LDay { date: string; inBacktest: boolean; ran: boolean; bar: number | null; rows: LRow[] }
interface LTotals { days: number; btTrades: number; liveTrades: number; same: number; missed: number; extra: number; btR: number; liveR: number; liveClosed: number }
interface LResult { days: LDay[]; totals: LTotals; dataTo: string; run: { runId: string; iteration: number } }
const KIND: Record<Kind, { label: string; cls: string }> = {
  same: { label: 'Same', cls: 'bg-data-green/15 text-data-green' },
  'other-time': { label: 'Other time', cls: 'bg-data-caution/15 text-data-caution' },
  missed: { label: 'Missed live', cls: 'bg-data-red/15 text-data-red-text' },
  extra: { label: 'Live only', cls: 'bg-brand-accent/15 text-brand-accent' },
};
const tone = (x: number | null | undefined) => (x == null || x === 0 ? 'text-ink-2' : x > 0 ? 'text-data-green' : 'text-data-red-text');

function LiveCheckCard() {
  const [res, setRes] = useState<LResult | null | undefined>(undefined);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/setups/live-check', { cache: 'no-store' }).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setRes(j.result); if (!j.result) setMsg(j.message ?? '');
    }).catch((e) => { setRes(null); setMsg((e as Error).message); });
  }, []);
  const t = res?.totals;
  const verdict = !t || !t.btTrades ? null
    : t.missed === 0 && t.extra === 0 ? { cls: TONE.good, text: `Live took exactly the backtest's trades on all ${t.days} days.` }
      : t.missed + t.extra <= Math.max(1, Math.round(t.btTrades * 0.2)) ? { cls: TONE.warn, text: `Mostly the same: ${t.same} of ${t.btTrades} backtest trades taken live, ${t.missed} missed, ${t.extra} live only. Check the reasons below.` }
        : { cls: TONE.bad, text: `Live is not trading the tested system: ${t.missed} of ${t.btTrades} backtest trades missed and ${t.extra} live only. Until this closes, the backtest's numbers don't describe your results.` };
  return (
    <Card title="Backtest vs live" sub="Every day Algo Live has run: the trades the backtest's F took that day next to what Algo Live actually took, and why they differ. R is before charges on both sides.">
      {res === undefined && <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-4 w-4 animate-spin" />Comparing…</p>}
      {res === null && <p className="text-xs text-ink-3">{msg || 'Nothing to compare yet.'}</p>}
      {res && t && (
        <>
          {verdict ? <p className={`rounded-xl border px-3 py-2 text-sm font-bold ${verdict.cls}`}>{verdict.text}</p>
            : <p className="text-xs text-ink-3">No backtest trades on the live days yet.</p>}
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div><p className="text-[10px] uppercase tracking-widest text-ink-3">Days compared</p><p className="font-mono font-bold">{t.days}</p></div>
            <div><p className="text-[10px] uppercase tracking-widest text-ink-3">Same trades</p><p className="font-mono font-bold">{t.same} / {t.btTrades}</p></div>
            <div><p className="text-[10px] uppercase tracking-widest text-ink-3">Backtest R</p><p className={`font-mono font-bold ${tone(t.btR)}`}>{rr(t.btR)}</p></div>
            <div><p className="text-[10px] uppercase tracking-widest text-ink-3">Live R</p><p className={`font-mono font-bold ${tone(t.liveR)}`}>{rr(t.liveR)}{t.liveClosed < t.liveTrades ? <span className="text-[10px] font-normal text-ink-3"> ({t.liveClosed} of {t.liveTrades} closed)</span> : null}</p></div>
          </div>
          <p className="text-[11px] text-ink-3">Backtest: iteration {res.run.iteration}&apos;s run, data to {fmtDate(res.dataTo)}. Later days show live trades only until the next Re-run. Live R comes from your journal&apos;s exits.</p>
          <ul>
            {res.days.map((d) => {
              const bad = d.rows.filter((r) => r.kind !== 'same').length;
              return (
                <li key={d.date} className="border-b border-line/60">
                  <button className="flex w-full items-center gap-2 py-2 text-left text-xs" onClick={() => setOpen(open === d.date ? null : d.date)}>
                    <span className="w-24 shrink-0 font-bold">{fmtDate(d.date).replace(/ \d{4}$/, '')}</span>
                    <span className="flex-1 text-ink-2">{!d.inBacktest ? 'not in the backtest yet' : !d.rows.length ? 'no trades either side' : bad ? `${bad} difference${bad > 1 ? 's' : ''}` : 'all the same'}</span>
                    <span className="text-ink-3">{d.rows.length} trade{d.rows.length === 1 ? '' : 's'}</span>
                    {open === d.date ? <ChevronDown className="h-3.5 w-3.5 text-ink-3" /> : <ChevronRight className="h-3.5 w-3.5 text-ink-3" />}
                  </button>
                  {open === d.date && (
                    <div className="space-y-2 pb-3">
                      {!d.ran && <p className="text-[11px] text-ink-3">Algo Live did not run that day (no day list).</p>}
                      {d.rows.map((r, i) => (
                        <div key={i} className="rounded-lg border border-line px-3 py-2 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            <b>{r.symbol}</b>
                            <span className={`rounded px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest ${KIND[r.kind].cls}`}>{KIND[r.kind].label}</span>
                            <span className="ml-auto font-mono text-[11px] text-ink-3">
                              {r.btTime && <>BT {r.btTime} <span className={tone(r.btR)}>{rr(r.btR)}</span></>}
                              {r.btTime && r.liveTime && ' · '}
                              {r.liveTime && <>Live {r.liveTime} <span className={tone(r.liveR)}>{r.liveR == null ? 'open' : rr(r.liveR)}</span>{r.exit && r.exit !== 'OPEN' ? ` (${r.exit.toLowerCase()})` : ''}</>}
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] text-ink-2">{r.why}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
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
          <p><b>Which stocks:</b> each day, every NSE stock with a previous close of ₹250–340 and a 10-day average volume of 5 lakh shares or more (so the trades could actually be filled). Stocks that were delisted in the last two years are not in Dhan&apos;s list and are missed. &quot;In play&quot; = the 20 busiest of them in the first 10 minutes vs their usual (1.5x or more); it is a slice you can pick, not a filter.</p>
          <p><b>Research cases:</b> last-half-hour momentum and the end-of-day reversal are decided at 15:00 and held to the 15:29 close; the breakout fade takes every breakout the other way; the 5-day reversal is a delivery trade (bought at the close, sold 5 sessions later, delivery charges). No opening range breakout: nothing is entered before the 09:25 close.</p>
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
