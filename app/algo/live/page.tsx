"use client";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { Card, rr } from '@/components/setups/parts';

/**
 * Algo Live: the strategy an Algo Lab iteration picked (iteration 10 so far; the model says which: lib/algoLive/active.ts),
 * traded live (lib/algoLive/engine.ts).
 *   1. Day list (before the open): the stocks the backtest would look at today, comma separated for the Order Book.
 *   2. 09:25: the shortlist (the model's view after the first 10 minutes) to veto from.
 *   3. 09:35-10:55: at each 10-minute close the first 2 that clear the bar are shorted through trading-scaler
 *      (stop and target ½ the usual daily range, ₹300 risk), unless vetoed or not armed. trading-scaler closes
 *      whatever is still open at 15:15.
 * Keep this page open in the morning: it drives the closes.
 *
 * Which iteration it trades is switched at the top: iteration 10 (narrow: ₹250-340, 2 a day, sized by risk) or iteration
 * 15 (wide: ₹250-1000, ₹100 crore+ a day, 3 a day, the market gate, sized by position). Each has its own monthly model.
 */

interface Scored { symbol: string; pred: number | null; price?: number; adr?: number; above: boolean; note?: string; turnover?: number; thin?: boolean }
interface Tick { slot: number; at: number; scored: Scored[]; picked: string[]; note: string; missing: string[] }
interface Order { symbol: string; securityId?: string; slot: number; pred: number; price: number; adr: number; qty: number; stop: number; target: number; correlationId: string; sentAt: number; orderId?: string; status: string; error?: string; avgPrice?: number }
interface Item { symbol: string; securityId: string; prevClose: number; avgVol: number }
type Version = 'narrow' | 'wide';
interface Gate { move: number | null; bar: number | null; hot: boolean; history: number; stocks: number }
interface State { date: string; list: Item[]; listAt?: number; candidates?: number; vetoes: string[]; armed: boolean; ticks: Record<string, Tick>; orders: Order[]; log: { at: number; msg: string }[]; version?: Version; gate?: Gate }
interface ModelInfo { month: string; train: [string, string]; val: [string, string]; threshold: number | null; standAside: boolean; valTrades: number; valR: number | null; valDays: number; createdAt: number; trees: number; parityWorst: number | null; rules: { firstSlot: number; lastSlot: number; cap: number; riskInr: number; minTurnoverRs?: number };
  universe?: Version; gated?: boolean;
  active?: { iteration: number | null; name: string; runId: string | null; runAt: string | null; dataTo: string | null } }
interface Snap { now: number; date: string; state: State; levels?: Record<string, { at90: number; moveStop: number }>; record: string[]; model: ModelInfo | null; scaler: boolean; settings?: { riskInr: number; version?: Version; positionInr?: number };
  versions?: Record<Version, { month: string; iteration: number | null; name: string; standAside: boolean; threshold: number | null; valTrades: number; valR: number | null } | null> }
interface ModelRun { id: number; status: string; conclusion: string | null; createdAt: number; updatedAt: number; url: string }
interface Pos { symbol: string; netQty: number; realized: number; unrealized: number }

const SLOTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const IST = 19800_000;
const ist = (ms: number) => { const t = new Date(ms + IST); return { date: t.toISOString().slice(0, 10), sec: t.getUTCHours() * 3600 + t.getUTCMinutes() * 60 + t.getUTCSeconds() }; };
const hhmm = (k: number) => { const m = 555 + k; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const mon = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
/** a close is run this many seconds after it (Dhan needs a few seconds to serve the last minute) */
const AFTER = 6, LATEST = 4 * 60;
/** the bar and the predictions to 4 decimals: at 2, a stock just under the bar shows the same number as the bar */
const r4 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(4)}R`);
const btn = 'rounded-lg border px-3 py-1.5 text-xs font-bold disabled:opacity-40';
const lakh = (x: number) => `₹${(x / 100_000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} lakh`;
const crore = (x: number) => `₹${Math.round(x / 1e7).toLocaleString('en-IN')} cr`;
const VERSION_LABEL: Record<Version, string> = { narrow: 'Iteration 10 · narrow', wide: 'Iteration 15 · wide' };
const VERSION_DESC: Record<Version, string> = {
  narrow: '₹250–340 stocks · first 2 a day · sized by risk',
  wide: '₹250–1000 stocks (no ETFs) · ₹100 crore+ a day · first 3 a day · market gate · sized by position',
};

export default function AlgoLivePage() {
  const { token } = useAuth();
  const tokenRef = useRef(token); tokenRef.current = token;
  const api = useCallback(async (path: string, body?: unknown) => {
    const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'x-dhan-token': tokenRef.current ?? '' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
    return j;
  }, []);
  const [snap, setSnap] = useState<Snap | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState('');
  const [now, setNow] = useState(Date.now());
  const [positions, setPositions] = useState<Pos[] | null>(null);
  const [scalerMsg, setScalerMsg] = useState('');
  const [killOn, setKillOn] = useState(false);
  const [killMsg, setKillMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<number | null>(null);
  const running = useRef(new Set<number>());
  const lastTry = useRef(new Map<number, number>());
  const squaredOff = useRef(false);

  const refresh = useCallback(async (fresh = false) => { try { setSnap(await api(`/api/algo-live/state${fresh ? '?fresh=1' : ''}`)); } catch (e) { setErr((e as Error).message); } }, [api]);

  // this month's model: started from here (the "Algo Live model" GitHub workflow), its run followed until it finishes
  const [mrun, setMrun] = useState<ModelRun | null | undefined>(undefined);
  const [mmsg, setMmsg] = useState('');
  const [mstart, setMstart] = useState(0); // when it was started from here (0 = not)
  const readModelRun = useCallback(async () => {
    try { const j = await api('/api/algo-live/model'); setMrun(j.run); return j.run as ModelRun | null; }
    catch (e) { setMmsg((e as Error).message); return undefined; }
  }, [api]);
  useEffect(() => { readModelRun(); }, [readModelRun]);
  const following = mstart > 0 || (!!mrun && mrun.status !== 'completed');
  useEffect(() => {
    if (!following) return;
    const t = setInterval(async () => {
      const r = await readModelRun();
      if (r && r.status === 'completed' && (!mstart || r.createdAt >= mstart - 60_000)) {
        setMstart(0);
        if (r.conclusion === 'success') refresh(true);
      }
    }, 15_000);
    return () => clearInterval(t);
  }, [following, mstart, readModelRun, refresh]);
  const makeModel = async () => {
    if (snap?.model && snap.model.month === ist(Date.now()).date.slice(0, 7) && !window.confirm('This month already has its model. Make it again?')) return;
    setMmsg(''); setBusy('model');
    try { await api('/api/algo-live/model', {}); setMstart(Date.now()); setMmsg('Started on GitHub: it takes a few minutes. You can leave this page.'); }
    catch (e) { setMmsg((e as Error).message); }
    finally { setBusy(''); }
  };
  useEffect(() => { refresh(); const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [refresh]);

  const st = snap?.state, model = snap?.model;
  const today = ist(now);
  const stale = !!snap && snap.date !== today.date;
  useEffect(() => { if (stale) refresh(); }, [stale, refresh]);

  const makeList = async () => {
    setBusy('list'); setErr('');
    try {
      setProgress('Reading every NSE equity…');
      const a = await api('/api/algo-live/list', { phase: 'scan' });
      let from = 0;
      for (;;) {
        setProgress(`Checking daily candles: ${from} of ${a.candidates}`);
        const r = await api('/api/algo-live/list', { phase: 'screen', from, n: 25 });
        from = r.next;
        if (r.done) break;
      }
      setProgress('');
      await refresh();
    } catch (e) { setErr((e as Error).message); setProgress(''); } finally { setBusy(''); }
  };

  const runTick = useCallback(async (k: number) => {
    if (running.current.has(k)) return;
    running.current.add(k);
    lastTry.current.set(k, Date.now());
    setBusy(`tick${k}`);
    try { await api('/api/algo-live/tick', { slot: k }); setView(k); }
    catch (e) { setErr(`${hhmm(k)}: ${(e as Error).message}`); running.current.delete(k); }
    finally { setBusy(''); refresh(); }
  }, [api, refresh]);

  // the closes run themselves while this page is open: each one AFTER seconds after it, never later than LATEST
  useEffect(() => {
    if (!st || !model || !token || stale || !st.list.length) return;
    if ((st.version ?? 'narrow') !== (snap?.settings?.version ?? 'narrow')) return; // a list made for the other model: make it again first
    for (const k of SLOTS) {
      const at = (555 + k) * 60 + AFTER;
      // a failed close is tried again every 20 s until it is too late
      if (today.sec >= at && today.sec < at + LATEST && !st.ticks[String(k)] && !running.current.has(k) && Date.now() - (lastTry.current.get(k) ?? 0) > 20_000) { runTick(k); break; }
    }
  }, [today.sec, st, model, token, stale, runTick, snap?.settings?.version]);

  const risk = snap?.settings?.riskInr ?? 300;
  const [riskDraft, setRiskDraft] = useState('');
  const version: Version = snap?.settings?.version ?? 'narrow';
  const wide = version === 'wide';
  const position = snap?.settings?.positionInr ?? 150_000;
  const [posDraft, setPosDraft] = useState('');
  const listVersion: Version = st?.version ?? 'narrow';
  const otherList = !!st?.list.length && listVersion !== version;
  const control = async (b: Record<string, unknown>) => { try { await api('/api/algo-live/control', b); await refresh(); } catch (e) { setErr((e as Error).message); } };
  const switchTo = async (v: Version) => {
    if (v === version) return;
    const line = snap?.versions?.[v];
    const ok = window.confirm(`Switch Algo Live to ${VERSION_LABEL[v]}?\n\n${VERSION_DESC[v]}\n\n${line ? `Its model: ${mon(line.month)}${line.standAside ? ', standing aside' : ''}.` : 'It has no model yet: make it first.'}\n\nThis disarms the page; make the day list again before trading.${v === 'wide' ? '\n\ntrading-scaler must allow 3 orders a day and your position size (BOT_MAX_PER_DAY, BOT_MAX_NOTIONAL).' : ''}`);
    if (ok) { await control({ version: v }); setMrun(undefined); readModelRun(); }
  };
  const scalerCall = useCallback(async (action: 'ping' | 'status' | 'squareoff') => {
    setBusy(action); setErr('');
    try {
      const r = await api('/api/algo-live/scaler', { action });
      if (action === 'ping') setScalerMsg(`trading-scaler is up (its clock ${clock(r.now)}, at most ${r.maxPerDay} orders a day${r.ip ? `, IP ${r.ip}` : ''})`);
      else { setPositions(r.status.positions); setScalerMsg(action === 'squareoff' ? `Square-off: ${r.squareOff?.done?.join(', ') || 'nothing open'}${r.squareOff?.errors?.length ? ` · ${r.squareOff.errors.join('; ')}` : ''}` : `Read at ${clock(Date.now())}`); }
      await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }, [api, refresh]);

  // an order's missing stop and / or target, at this order's levels (trading-scaler places it as a linked pair)
  const pushExits = async (o: Order, which: 'sl' | 'tp') => {
    // the order carries its Dhan id; older saved orders may not: then the day list has it
    const securityId = o.securityId ?? st?.list.find((x) => x.symbol === o.symbol)?.securityId;
    if (!securityId) { setErr(`${o.symbol}: its Dhan id is not known`); return; }
    setBusy(`exits:${which}:${o.correlationId}`); setErr('');
    try {
      const r = await api('/api/chart/trade', { action: 'addstop', which, securityId, symbol: o.symbol, correlationId: o.correlationId });
      setScalerMsg(`${o.symbol}: ${r.done?.length ? `placed ${r.done.join(', ')}` : 'nothing placed'}${r.errors?.length ? ` · ${r.errors.join('; ')}` : ''}`);
      await scalerCall('status');
    } catch (e) { setErr(`${o.symbol}: ${(e as Error).message}`); } finally { setBusy(''); }
  };

  // Dhan's kill switch, as Dhan reports it (an older trading-scaler does not know the call: then it just stays unknown)
  useEffect(() => { if (token) api('/api/algo-live/scaler', { action: 'killstatus' }).then((r) => setKillOn(!!r.on)).catch(() => undefined); }, [api, token]);
  const killSwitch = async () => {
    if (!confirm('Disarm and turn on Dhan\'s kill switch?\n\nNo order can go through on your Dhan account for the rest of today, including ones you place by hand.\n\nDhan only allows this with no open position and no pending order.')) return;
    setBusy('kill'); setErr(''); setKillMsg('');
    try {
      const r = await api('/api/algo-live/scaler', { action: 'killswitch' });
      setKillOn(!!r.on);
      setKillMsg(r.on ? '' : `Disarmed, but the kill switch is NOT on${r.why ? `: ${r.why}` : ''}. If a trade is open, close it and try again.`);
      await refresh();
    } catch (e) { setErr((e as Error).message); setKillMsg('Could not confirm the kill switch: check it in Dhan.'); await refresh(); } finally { setBusy(''); }
  };

  // the orders' fate from Dhan every 2 minutes while anything is open; a backup square-off at 15:16 (trading-scaler does it at 15:15)
  const open = (st?.orders ?? []).some((o) => !['REJECTED', 'ERROR', 'CANCELLED', 'CLOSED', 'NOT_SENT'].includes(o.status));
  useEffect(() => {
    if (!open || !token || stale) return;
    if (today.sec % 120 === 0 && today.sec > 9 * 3600 + 35 * 60 && today.sec < 15 * 3600 + 31 * 60) scalerCall('status');
    if (!squaredOff.current && today.sec >= 15 * 3600 + 16 * 60 && today.sec < 15 * 3600 + 25 * 60) { squaredOff.current = true; scalerCall('squareoff'); }
  }, [today.sec, open, token, stale, scalerCall]);

  const shown = view ?? Math.max(-1, ...Object.keys(st?.ticks ?? {}).map(Number));
  const tick = st?.ticks[String(shown)];
  const shortlist = st?.ticks['10'];
  // a ticker opens Charts in a new tab, with what Algo Live saw that day
  const chartHref = (sym: string) => { const sid = st?.list.find((x) => x.symbol === sym)?.securityId; return `/chart?symbol=${encodeURIComponent(sym)}&algo=${st?.date ?? today.date}${sid ? `&sid=${sid}` : ''}`; };
  const vetoed = new Set(st?.vetoes ?? []);
  const nextSlot = SLOTS.find((k) => today.sec < (555 + k) * 60 + AFTER);
  const recordText = (snap?.record ?? []).join(',');

  return (
    <div className="min-h-screen bg-brand-bg text-ink font-sans pb-24">
      <div className="page-shell pt-6 space-y-4">
        <header className="border-b border-line pb-3">
          <h1 className="text-2xl font-black tracking-tighter">Algo Live</h1>
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-ink-3">F · short · 09:35–10:55 · first {model?.rules.cap ?? (wide ? 3 : 2)} a day · stop and target ½ the usual daily range · {wide ? `${lakh(position)} positions · ₹100 cr+ a day · market gate` : `₹${risk} risk`} · out by 15:15</p>
        </header>
        {err && <p className="rounded-lg border border-data-red/50 bg-data-red/10 px-3 py-2 text-xs text-data-red-text">{err}</p>}
        {!token && <p className="text-xs text-brand-accent">Log in on the Dhan login tab first: this page needs your Dhan token.</p>}
        {!snap && !err && <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>}
        {snap && (
          <>
            <Card title="Which iteration" sub="Each has its own model, made at the start of the month. Switch only before the day's first trade: the page disarms and the day list must be made again.">
              <div className="grid gap-2 sm:grid-cols-2">
                {(['narrow', 'wide'] as Version[]).map((v) => {
                  const line = snap.versions?.[v];
                  return (
                    <button key={v} disabled={!!busy || v === version} onClick={() => switchTo(v)}
                      className={`rounded-xl border-2 px-3 py-2 text-left disabled:cursor-default ${v === version ? 'border-data-green bg-data-green/10' : 'border-line hover:border-line-strong'}`}>
                      <p className="text-sm font-black">{VERSION_LABEL[v]}{v === version ? ' · trading' : ''}</p>
                      <p className="text-[11px] text-ink-2">{VERSION_DESC[v]}</p>
                      <p className="mt-0.5 text-[11px] text-ink-3">{line ? `Model for ${mon(line.month)} · ${line.standAside ? 'standing aside' : `bar ${r4(line.threshold)}, ${line.valTrades} trades on the 3 months before at ${rr(line.valR)}`}` : 'No model yet'}</p>
                    </button>
                  );
                })}
              </div>
            </Card>

            <Card title="The model" sub={model ? `Trades ${mon(model.month)} · learned from ${mon(model.train[0])}–${mon(model.train[1])} · bar set on ${mon(model.val[0])}–${mon(model.val[1])} · ${model.trees} trees · made ${new Date(model.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : 'No live model yet: press Make this month\'s model below.'}>
              {model?.active && (
                <div className="mb-2 rounded-lg border border-data-green/40 bg-data-green/10 px-3 py-2">
                  <p className="text-sm"><b>Active iteration: {model.active.iteration ?? '?'}</b> · {model.active.name}</p>
                  <p className="mt-0.5 text-[11px] text-ink-2">
                    Trained on the data of the {wide ? 'Algo Lab' : 'backtest'} run of {model.active.runAt ?? 'an unknown date'}{model.active.dataTo ? ` (data to ${new Date(`${model.active.dataTo}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })})` : ''}.{' '}
                    {model.active.runId && <a className="underline" href={`/algo?run=${encodeURIComponent(model.active.runId)}`}>See it in Algo Lab</a>}
                  </p>
                </div>
              )}
              {model && (
                <p className="text-sm">
                  {model.standAside ? <b className="text-brand-accent">Standing aside this month: no bar made money on the 3 months before.</b>
                    : <>Bar <b className="font-mono">{r4(model.threshold)}</b> predicted (a stock must be above it) · on the 3 months before: {model.valTrades} trades in {model.valDays} days, <b className="font-mono">{rr(model.valR)}</b> a trade.</>}
                  {model.month !== today.date.slice(0, 7) && <b className="block text-data-red-text">This model is for {mon(model.month)}: {wide ? 'run Algo Lab (it builds the dataset)' : 're-run the backtest on My Setups'}, then press Make this month&apos;s model below.</b>}
                </p>
              )}
              <div className="mt-2 rounded-lg border border-line px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button className={`${btn} ${!model || model.month !== today.date.slice(0, 7) ? 'border-brand-accent bg-brand-accent/15 text-brand-accent' : ''}`}
                    disabled={!!busy || following || mrun === undefined} onClick={makeModel}>
                    {busy === 'model' ? 'Starting…' : following ? 'Making the model…' : "Make this month's model"}
                  </button>
                  {following && <Loader2 className="h-4 w-4 animate-spin text-ink-3" />}
                </div>
                <p className="mt-1 text-[11px] text-ink-3">
                  {wide
                    ? <>Trains {mon(today.date.slice(0, 7))}&apos;s iteration 15 model from the latest Algo Lab dataset (press Run on Algo Lab first, once a month, outside 08:40–11:15; the dataset is kept 7 days). Takes 20–60 minutes on GitHub.</>
                    : <>Trains {mon(today.date.slice(0, 7))}&apos;s model from the latest finished backtest (run the backtest on My Setups first, once a month). Takes a few minutes on GitHub.</>}
                </p>
                {mrun && (
                  <p className="mt-1 text-[11px]">
                    {mrun.status !== 'completed' ? <span className="text-ink-2">Running on GitHub since {clock(mrun.createdAt)}…</span>
                      : mrun.conclusion === 'success' ? <span className="text-data-green">Last run done {new Date(mrun.updatedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })}.</span>
                        : <span className="text-data-red-text">Last run {mrun.conclusion ?? 'stopped'} ({new Date(mrun.updatedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })}): the old model stays.</span>}
                    {' '}<a className="underline text-ink-3" href={mrun.url} target="_blank" rel="noreferrer">See it on GitHub</a>
                  </p>
                )}
                {mmsg && <p className="mt-1 text-[11px] text-ink-2">{mmsg}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button className={btn} disabled={!token || !!busy} onClick={() => scalerCall('ping')}>Check trading-scaler</button>
                {!snap.scaler && <span className="text-[11px] text-data-red-text">TRADING_SCALER_URL / TE_SHARED_SECRET are not set on Vercel.</span>}
                {scalerMsg && <span className="text-[11px] text-ink-2">{scalerMsg}</span>}
              </div>
            </Card>

            <Card title="1 · Day list" sub={wide
              ? 'The stocks iteration 15 looked at: previous close ₹250–1000 (no ETFs) and 10-day average volume above 5 lakh shares (scaled to a ₹340 stock). All are scored; only those trading ₹100 crore+ a day can be traded. Make it between 08:30 and 09:10 (takes 5–15 minutes).'
              : 'The stocks the backtest looked at: previous close ₹250–340 and 10-day average volume above 5 lakh shares. Make it any time before 09:15 (takes a minute or two).'} right={<button className={btn} disabled={!token || !!busy} onClick={makeList}>{busy === 'list' ? 'Working…' : st?.list.length ? 'Make it again' : 'Make the day list'}</button>}>
              {progress && <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-4 w-4 animate-spin" />{progress}</p>}
              {otherList && <p className="text-xs font-bold text-data-red-text">Today&apos;s list was made for {VERSION_LABEL[listVersion]}: make it again for {VERSION_LABEL[version]}.</p>}
              {wide && !otherList && !!st?.listAt && (
                st.gate && st.gate.move !== null
                  ? <p className={`text-xs ${st.gate.hot ? 'font-bold text-brand-accent' : 'text-ink-2'}`}>Market gate: the market&apos;s 20-day move is {st.gate.move.toFixed(2)}% ({st.gate.stocks} stocks){st.gate.bar !== null ? `, the top third of its last ${st.gate.history} days starts at ${st.gate.bar.toFixed(2)}%` : ''}. {st.gate.hot ? 'HOT: no trades today.' : 'Not hot: trading as usual.'}</p>
                  : <p className="text-xs font-bold text-brand-accent">Market gate unknown: no trades today. Make the list again once the wide model is in place.</p>
              )}
              {!!st?.list.length && (
                <>
                  <p className="text-xs text-ink-2">{st.list.length} stocks{st.listAt ? ` · made ${clock(st.listAt)}` : ' · still being made'}{st.list.length > 50 ? ` · the 50 busiest below for the Order Book (all ${st.list.length} are scored)` : ''}. Paste into Order Book → Start recording.</p>
                  <div className="flex items-start gap-2">
                    <textarea readOnly value={recordText} className="h-20 flex-1 rounded-lg border border-line bg-brand-bg p-2 font-mono text-[11px]" />
                    <button className={btn} onClick={async () => { await navigator.clipboard.writeText(recordText); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy'}</button>
                  </div>
                </>
              )}
            </Card>

            <Card title="2 · Armed?" sub={`Armed: at each close from 09:35 to 10:55 the picks are sent to Dhan by themselves (short, market order, stop and target with it). Not armed: they are only shown. At most ${model?.rules.cap ?? 2} trades a day; a vetoed stock is never traded.`}>
              <div className="flex flex-wrap items-center gap-2">
                <button disabled={killOn} onClick={() => control({ armed: !st?.armed })} className={`rounded-xl border-2 px-4 py-2 text-sm font-black disabled:opacity-50 ${st?.armed ? 'border-data-green bg-data-green/15 text-data-green' : 'border-line-strong text-ink-2'}`}>
                  {st?.armed ? 'ARMED · click to disarm' : 'NOT ARMED · click to arm'}
                </button>
                {(st?.armed || killMsg) && !killOn && (
                  <button disabled={!token || !!busy} onClick={killSwitch} className="rounded-xl border-2 border-data-red/60 px-4 py-2 text-sm font-black text-data-red-text disabled:opacity-50">
                    {busy === 'kill' ? 'Working…' : st?.armed ? 'DISARM + KILL SWITCH · no trades today' : 'KILL SWITCH · no trades today'}
                  </button>
                )}
              </div>
              {killOn && <p className="text-xs font-bold text-data-red-text">Kill switch ON at Dhan: no order can go through on your account today.</p>}
              {killMsg && <p className="text-xs font-bold text-data-red-text">{killMsg}</p>}
              {wide ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span>Position a trade: <b className="font-mono">₹{position.toLocaleString('en-IN')}</b></span>
                <input type="number" min={25000} max={1000000} step={25000} value={posDraft} placeholder={String(position)} onChange={(e) => setPosDraft(e.target.value)}
                  className="w-28 rounded-lg border border-line bg-brand-bg px-2 py-1 font-mono" />
                <button className={btn} disabled={!posDraft || Number(posDraft) === position} onClick={async () => { await control({ positionInr: Number(posDraft) }); setPosDraft(''); }}>Set</button>
                <span className="text-[11px] text-ink-3">Rupees of stock a trade, kept from day to day and used from the next order. The stop is about 2.3% away, so {lakh(position)} ≈ ₹{(Math.round(position * 0.023 / 100) * 100).toLocaleString('en-IN')} risk a trade; 3 at once need about ₹{(Math.round(position * 3 / 5 / 1000) * 1000).toLocaleString('en-IN')} margin at 5x. Iteration 15 was judged at ₹10 lakh: start small and raise it only on real results. trading-scaler refuses a position above BOT_MAX_NOTIONAL (checked at the stop price) and more than BOT_MAX_PER_DAY orders: set them to about {lakh(Math.ceil(position * 1.06 / 10_000) * 10_000)} and 3.</span>
              </div>
              ) : (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span>Risk a trade: <b className="font-mono">₹{risk}</b></span>
                <input type="number" min={50} max={5000} step={50} value={riskDraft} placeholder={String(risk)} onChange={(e) => setRiskDraft(e.target.value)}
                  className="w-24 rounded-lg border border-line bg-brand-bg px-2 py-1 font-mono" />
                <button className={btn} disabled={!riskDraft || Number(riskDraft) === risk} onClick={async () => { await control({ riskInr: Number(riskDraft) }); setRiskDraft(''); }}>Set</button>
                <span className="text-[11px] text-ink-3">Kept from day to day; used from the next order (orders already sent keep their size). The stop is about 2.4% away, so ₹{risk} risk ≈ ₹{(Math.round(risk / 0.024 / 100) * 100).toLocaleString('en-IN')} of stock a trade. trading-scaler refuses any position above ₹75,000 (BOT_MAX_NOTIONAL), so above about ₹1,500 risk raise that too.</span>
              </div>
              )}
            </Card>

            <Card title="3 · The closes" sub={`Each runs ${AFTER} seconds after its 10-minute candle closes while this page is open (an order goes only within 4 minutes of its close). 09:25 is the shortlist to veto from.`}>
              <div className="flex flex-wrap gap-1.5">
                {SLOTS.map((k) => {
                  const t = st?.ticks[String(k)];
                  const due = today.sec >= (555 + k) * 60;
                  return (
                    <button key={k} onClick={() => (t ? setView(k) : due ? runTick(k) : undefined)} disabled={!t && (!due || !token || !st?.list.length || busy.startsWith('tick'))}
                      className={`rounded-full border px-2.5 py-1 font-mono text-[11px] ${t ? (t.picked.length ? 'border-data-green text-data-green' : 'border-line-strong text-ink-2') : k === nextSlot ? 'border-brand-accent text-brand-accent' : 'border-line text-ink-3'} ${shown === k ? 'ring-1 ring-brand-accent' : ''}`}>
                      {busy === `tick${k}` ? '…' : hhmm(k)}{k === 10 ? ' list' : ''}{t?.picked.length ? ` ✓${t.picked.length}` : ''}
                    </button>
                  );
                })}
              </div>
              {nextSlot !== undefined && <p className="text-[11px] text-ink-3">Next: {hhmm(nextSlot)} in {Math.max(0, (555 + nextSlot) * 60 + AFTER - today.sec)} s</p>}
              {tick && (
                <>
                  <p className="text-xs"><b>{hhmm(tick.slot)}</b> · {tick.note}{tick.missing.length ? ` · no data: ${tick.missing.join(', ')}` : ''}</p>
                  <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-xs"><thead><tr className="border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3">
                    <th className="px-2 py-1 text-left">Stock</th><th className="px-2 py-1 text-right">Predicted</th><th className="px-2 py-1 text-right">Price</th><th className="px-2 py-1 text-right">Usual range</th><th className="px-2 py-1 text-left">Bar</th><th className="px-2 py-1 text-left">Veto</th>
                  </tr></thead><tbody>
                    {tick.scored.filter((x, i) => x.above || i < 15 || tick.picked.includes(x.symbol)).map((x) => (
                      <tr key={x.symbol} className={`border-b border-line/60 font-mono ${tick.picked.includes(x.symbol) ? 'bg-data-green/10' : ''}`}>
                        <td className="px-2 py-1 font-sans font-bold"><a href={chartHref(x.symbol)} target="_blank" rel="noreferrer" title={`Open ${x.symbol} on Charts, with what Algo Live saw`} className="hover:text-brand-accent hover:underline">{x.symbol}</a></td>
                        <td className={`px-2 py-1 text-right ${x.above ? 'font-bold text-data-green' : ''}`}>{x.pred === null ? x.note : r4(x.pred)}{x.thin ? <span className="block font-sans text-[10px] text-ink-3">{x.turnover ? crore(x.turnover) : ''} a day: too thin to trade</span> : null}</td>
                        <td className="px-2 py-1 text-right">{x.price?.toFixed(2) ?? '–'}</td>
                        <td className="px-2 py-1 text-right">{x.adr?.toFixed(2) ?? '–'}</td>
                        <td className="px-2 py-1">{x.above ? <b className="text-data-green">clears</b> : ''}{tick.picked.includes(x.symbol) ? ' · PICKED' : ''}</td>
                        <td className="px-2 py-1"><input type="checkbox" checked={vetoed.has(x.symbol)} onChange={(e) => control({ veto: x.symbol, on: e.target.checked })} /></td>
                      </tr>
                    ))}
                  </tbody></table></div>
                </>
              )}
              {!tick && shortlist === undefined && <p className="text-[11px] text-ink-3">Nothing scored yet today.</p>}
              {!!st?.vetoes.length && <p className="text-[11px] text-ink-2">Vetoed: {st.vetoes.map((v) => <button key={v} className="mr-1 underline" onClick={() => control({ veto: v, on: false })}>{v} ✕</button>)}</p>}
            </Card>

            <Card title="4 · Orders" sub="Sent through trading-scaler (the server Dhan allows to place orders). It closes anything still open at 15:15; this page does it again at 15:16 if it is open." right={
              <div className="flex gap-2">
                <button className={btn} disabled={!token || !!busy} onClick={() => scalerCall('status')}>Refresh</button>
                <button className={`${btn} border-data-red/60 text-data-red-text`} disabled={!token || !!busy} onClick={() => { if (confirm('Close every position the bot opened today, now, at market?')) scalerCall('squareoff'); }}>Square off now</button>
              </div>}>
              {!st?.orders.length ? <p className="text-[11px] text-ink-3">No orders today.</p> : (
                <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-xs"><thead><tr className="border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3">
                  <th className="px-2 py-1 text-left">Stock</th><th className="px-2 py-1 text-left">At</th><th className="px-2 py-1 text-right">Qty</th><th className="px-2 py-1 text-right">Close</th><th className="px-2 py-1 text-right">Filled</th><th className="px-2 py-1 text-right">Stop</th><th className="px-2 py-1 text-right">Target</th><th className="px-2 py-1 text-right">90% at</th><th className="px-2 py-1 text-right">Move stop to</th><th className="px-2 py-1 text-left">Status</th><th className="px-2 py-1 text-left">SL / TP</th>
                </tr></thead><tbody>
                  {st.orders.map((o) => (
                    <tr key={o.correlationId} className="border-b border-line/60 font-mono">
                      <td className="px-2 py-1 font-sans font-bold"><a href={chartHref(o.symbol)} target="_blank" rel="noreferrer" className="hover:text-brand-accent hover:underline">{o.symbol}</a></td><td className="px-2 py-1">{hhmm(o.slot)}</td><td className="px-2 py-1 text-right">{o.qty}</td>
                      <td className="px-2 py-1 text-right">{o.price.toFixed(2)}</td><td className="px-2 py-1 text-right">{o.avgPrice ? o.avgPrice.toFixed(2) : '–'}</td>
                      <td className="px-2 py-1 text-right">{o.stop.toFixed(2)}</td><td className="px-2 py-1 text-right">{o.target.toFixed(2)}</td>
                      <td className="px-2 py-1 text-right">{snap?.levels?.[o.correlationId]?.at90.toFixed(2) ?? '–'}</td><td className="px-2 py-1 text-right">{snap?.levels?.[o.correlationId]?.moveStop.toFixed(2) ?? '–'}</td>
                      <td className="px-2 py-1">{o.status}{o.error ? ` · ${o.error}` : ''}</td>
                      <td className="px-2 py-1 font-sans">{positions?.some((p) => p.symbol === o.symbol && p.netQty) ? (
                        <span className="flex gap-1">
                          <button className="rounded border border-data-red/50 px-2 py-0.5 text-[11px] text-data-red-text disabled:opacity-40" disabled={!token || !!busy} onClick={() => pushExits(o, 'sl')}
                            title={`Place this position's stop at ${o.stop.toFixed(2)} (stop-limit), if it has none; it and the target cancel each other`}>
                            {busy === `exits:sl:${o.correlationId}` ? 'Placing…' : 'Push SL'}
                          </button>
                          <button className="rounded border border-data-green/50 px-2 py-0.5 text-[11px] text-data-green disabled:opacity-40" disabled={!token || !!busy} onClick={() => pushExits(o, 'tp')}
                            title={`Place this position's target at ${o.target.toFixed(2)}, if it has none; it and the stop cancel each other`}>
                            {busy === `exits:tp:${o.correlationId}` ? 'Placing…' : 'Push TP'}
                          </button>
                        </span>
                      ) : <span className="text-ink-4">–</span>}</td>
                    </tr>
                  ))}
                </tbody></table></div>
              )}
              {positions && <p className="text-[11px] text-ink-2">Positions: {positions.length ? positions.map((p) => `${p.symbol} ${p.netQty} (₹${Math.round(p.realized + p.unrealized)})`).join(' · ') : 'none open'}</p>}
            </Card>

            <Card title="Log" sub="Today, newest first.">
              <ul className="max-h-64 space-y-0.5 overflow-y-auto font-mono text-[11px] text-ink-2">
                {[...(st?.log ?? [])].reverse().map((l, i) => <li key={i}>{clock(l.at)} · {l.msg}</li>)}
              </ul>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
