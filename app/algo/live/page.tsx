"use client";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { Card, rr } from '@/components/setups/parts';

/**
 * Algo Live: the strategy iteration 10 picked, traded live (lib/algoLive/engine.ts).
 *   1. Day list (before the open): the stocks the backtest would look at today, comma separated for the Order Book.
 *   2. 09:25: the shortlist (the model's view after the first 10 minutes) to veto from.
 *   3. 09:35-10:55: at each 10-minute close the first 2 that clear the bar are shorted through trading-scaler
 *      (stop and target ½ the usual daily range, ₹300 risk), unless vetoed or not armed. trading-scaler closes
 *      whatever is still open at 15:15.
 * Keep this page open in the morning: it drives the closes.
 */

interface Scored { symbol: string; pred: number | null; price?: number; adr?: number; above: boolean; note?: string }
interface Tick { slot: number; at: number; scored: Scored[]; picked: string[]; note: string; missing: string[] }
interface Order { symbol: string; slot: number; pred: number; price: number; adr: number; qty: number; stop: number; target: number; correlationId: string; sentAt: number; orderId?: string; status: string; error?: string; avgPrice?: number }
interface Item { symbol: string; securityId: string; prevClose: number; avgVol: number }
interface State { date: string; list: Item[]; listAt?: number; candidates?: number; vetoes: string[]; armed: boolean; ticks: Record<string, Tick>; orders: Order[]; log: { at: number; msg: string }[] }
interface ModelInfo { month: string; train: [string, string]; val: [string, string]; threshold: number | null; standAside: boolean; valTrades: number; valR: number | null; valDays: number; createdAt: number; trees: number; parityWorst: number | null; rules: { firstSlot: number; lastSlot: number; cap: number; riskInr: number } }
interface Snap { now: number; date: string; state: State; record: string[]; model: ModelInfo | null; scaler: boolean; settings?: { riskInr: number } }
interface Pos { symbol: string; netQty: number; realized: number; unrealized: number }

const SLOTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const IST = 19800_000;
const ist = (ms: number) => { const t = new Date(ms + IST); return { date: t.toISOString().slice(0, 10), sec: t.getUTCHours() * 3600 + t.getUTCMinutes() * 60 + t.getUTCSeconds() }; };
const hhmm = (k: number) => { const m = 555 + k; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const mon = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
/** a close is run this many seconds after it (Dhan needs a few seconds to serve the last minute) */
const AFTER = 6, LATEST = 4 * 60;
const btn = 'rounded-lg border px-3 py-1.5 text-xs font-bold disabled:opacity-40';

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
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<number | null>(null);
  const running = useRef(new Set<number>());
  const lastTry = useRef(new Map<number, number>());
  const squaredOff = useRef(false);

  const refresh = useCallback(async () => { try { setSnap(await api('/api/algo-live/state')); } catch (e) { setErr((e as Error).message); } }, [api]);
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
    for (const k of SLOTS) {
      const at = (555 + k) * 60 + AFTER;
      // a failed close is tried again every 20 s until it is too late
      if (today.sec >= at && today.sec < at + LATEST && !st.ticks[String(k)] && !running.current.has(k) && Date.now() - (lastTry.current.get(k) ?? 0) > 20_000) { runTick(k); break; }
    }
  }, [today.sec, st, model, token, stale, runTick]);

  const risk = snap?.settings?.riskInr ?? 300;
  const [riskDraft, setRiskDraft] = useState('');
  const control = async (b: Record<string, unknown>) => { try { await api('/api/algo-live/control', b); await refresh(); } catch (e) { setErr((e as Error).message); } };
  const scalerCall = useCallback(async (action: 'ping' | 'status' | 'squareoff') => {
    setBusy(action); setErr('');
    try {
      const r = await api('/api/algo-live/scaler', { action });
      if (action === 'ping') setScalerMsg(`trading-scaler is up (its clock ${clock(r.now)}, at most ${r.maxPerDay} orders a day${r.ip ? `, IP ${r.ip}` : ''})`);
      else { setPositions(r.status.positions); setScalerMsg(action === 'squareoff' ? `Square-off: ${r.squareOff?.done?.join(', ') || 'nothing open'}${r.squareOff?.errors?.length ? ` · ${r.squareOff.errors.join('; ')}` : ''}` : `Read at ${clock(Date.now())}`); }
      await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }, [api, refresh]);

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
  const vetoed = new Set(st?.vetoes ?? []);
  const nextSlot = SLOTS.find((k) => today.sec < (555 + k) * 60 + AFTER);
  const recordText = (snap?.record ?? []).join(',');

  return (
    <div className="min-h-screen bg-brand-bg text-ink font-sans pb-24">
      <div className="page-shell pt-6 space-y-4">
        <header className="border-b border-line pb-3">
          <h1 className="text-2xl font-black tracking-tighter">Algo Live</h1>
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-ink-3">F · short · 09:35–10:55 · first 2 a day · stop and target ½ the usual daily range · ₹{risk} risk · out by 15:15</p>
        </header>
        {err && <p className="rounded-lg border border-data-red/50 bg-data-red/10 px-3 py-2 text-xs text-data-red-text">{err}</p>}
        {!token && <p className="text-xs text-brand-accent">Log in on the Dhan login tab first: this page needs your Dhan token.</p>}
        {!snap && !err && <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>}
        {snap && (
          <>
            <Card title="The model" sub={model ? `Trades ${mon(model.month)} · learned from ${mon(model.train[0])}–${mon(model.train[1])} · bar set on ${mon(model.val[0])}–${mon(model.val[1])} · ${model.trees} trees · made ${new Date(model.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : 'No live model yet: run the "Algo Live model" workflow on GitHub (Actions tab).'}>
              {model && (
                <p className="text-sm">
                  {model.standAside ? <b className="text-brand-accent">Standing aside this month: no bar made money on the 3 months before.</b>
                    : <>Bar <b className="font-mono">{rr(model.threshold)}</b> predicted · on the 3 months before: {model.valTrades} trades in {model.valDays} days, <b className="font-mono">{rr(model.valR)}</b> a trade.</>}
                  {model.month !== today.date.slice(0, 7) && <b className="block text-data-red-text">This model is for {mon(model.month)}: re-run the backtest and the model workflow for this month.</b>}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button className={btn} disabled={!token || !!busy} onClick={() => scalerCall('ping')}>Check trading-scaler</button>
                {!snap.scaler && <span className="text-[11px] text-data-red-text">TRADING_SCALER_URL / TE_SHARED_SECRET are not set on Vercel.</span>}
                {scalerMsg && <span className="text-[11px] text-ink-2">{scalerMsg}</span>}
              </div>
            </Card>

            <Card title="1 · Day list" sub="The stocks the backtest looked at: previous close ₹250–340 and 10-day average volume above 5 lakh shares. Make it any time before 09:15 (takes a minute or two)." right={<button className={btn} disabled={!token || !!busy} onClick={makeList}>{busy === 'list' ? 'Working…' : st?.list.length ? 'Make it again' : 'Make the day list'}</button>}>
              {progress && <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-4 w-4 animate-spin" />{progress}</p>}
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
              <button onClick={() => control({ armed: !st?.armed })} className={`rounded-xl border-2 px-4 py-2 text-sm font-black ${st?.armed ? 'border-data-green bg-data-green/15 text-data-green' : 'border-line-strong text-ink-2'}`}>
                {st?.armed ? 'ARMED · click to disarm' : 'NOT ARMED · click to arm'}
              </button>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span>Risk a trade: <b className="font-mono">₹{risk}</b></span>
                <input type="number" min={50} max={5000} step={50} value={riskDraft} placeholder={String(risk)} onChange={(e) => setRiskDraft(e.target.value)}
                  className="w-24 rounded-lg border border-line bg-brand-bg px-2 py-1 font-mono" />
                <button className={btn} disabled={!riskDraft || Number(riskDraft) === risk} onClick={async () => { await control({ riskInr: Number(riskDraft) }); setRiskDraft(''); }}>Set</button>
                <span className="text-[11px] text-ink-3">Kept from day to day; used from the next order (orders already sent keep their size). The stop is about 2.4% away, so ₹{risk} risk ≈ ₹{(Math.round(risk / 0.024 / 100) * 100).toLocaleString('en-IN')} of stock a trade. trading-scaler refuses any position above ₹75,000 (BOT_MAX_NOTIONAL), so above about ₹1,500 risk raise that too.</span>
              </div>
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
                        <td className="px-2 py-1 font-sans font-bold">{x.symbol}</td>
                        <td className="px-2 py-1 text-right">{x.pred === null ? x.note : rr(x.pred)}</td>
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
                <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-xs"><thead><tr className="border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3">
                  <th className="px-2 py-1 text-left">Stock</th><th className="px-2 py-1 text-left">At</th><th className="px-2 py-1 text-right">Qty</th><th className="px-2 py-1 text-right">Close</th><th className="px-2 py-1 text-right">Filled</th><th className="px-2 py-1 text-right">Stop</th><th className="px-2 py-1 text-right">Target</th><th className="px-2 py-1 text-left">Status</th>
                </tr></thead><tbody>
                  {st.orders.map((o) => (
                    <tr key={o.correlationId} className="border-b border-line/60 font-mono">
                      <td className="px-2 py-1 font-sans font-bold">{o.symbol}</td><td className="px-2 py-1">{hhmm(o.slot)}</td><td className="px-2 py-1 text-right">{o.qty}</td>
                      <td className="px-2 py-1 text-right">{o.price.toFixed(2)}</td><td className="px-2 py-1 text-right">{o.avgPrice ? o.avgPrice.toFixed(2) : '–'}</td>
                      <td className="px-2 py-1 text-right">{o.stop.toFixed(2)}</td><td className="px-2 py-1 text-right">{o.target.toFixed(2)}</td>
                      <td className="px-2 py-1">{o.status}{o.error ? ` · ${o.error}` : ''}</td>
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
