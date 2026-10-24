"use client";
import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';

/**
 * "Make a short" on the Socials page: pick a real trade (Mystery chart) or a finished week (Me vs Algo), Generate,
 * and the video is rendered on GitHub Actions in a few minutes. Every short shows here with its preview.
 */

type Kind = 'mystery' | 'vs';
interface Result { value: number; unit: 'R' | '%' }
interface MysteryTrade { id: string; date: string; symbol: string; dir: 'LONG' | 'SHORT'; entryTime: string; holdMin: number; result: Result }
interface Side { r: number; n: number; uncounted: number }
interface Week { week: string; label: string; me: Side; algo: Side; winner: 'me' | 'algo' | 'tie' | 'none'; meTrade?: { symbol: string; r?: number }; algoTrade?: { symbol: string; r?: number } }
interface Short { id: string; kind: Kind; label: string; createdAt: number; status: { state: 'queued' | 'rendering' | 'done' | 'failed'; error?: string }; video?: string; poster?: string }

const fmt = (r: Result) => `${r.value > 0 ? '+' : ''}${r.value}${r.unit}`;
const fmtR = (x?: number) => (x === undefined ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(1)}R`);
const tone = (x: number) => (x >= 0 ? 'text-data-green' : 'text-data-red-text');
const dateFmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export default function MakeShorts() {
  const { token } = useAuth();
  const [kind, setKind] = useState<Kind>('mystery');
  const [trades, setTrades] = useState<MysteryTrade[] | null>(null);
  const [cutoff, setCutoff] = useState('');
  const [weeks, setWeeks] = useState<Week[] | null>(null);
  const [pick, setPick] = useState('');
  const [tell, setTell] = useState('');
  const [notes, setNotes] = useState({ me: '', algo: '' });
  const [shorts, setShorts] = useState<Short[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const loadShorts = useCallback(async () => {
    const r = await fetch('/api/shorts/list', { cache: 'no-store' }).catch(() => null);
    const j = await r?.json().catch(() => null);
    if (r?.ok && j?.shorts) setShorts(j.shorts);
  }, []);

  useEffect(() => { void loadShorts(); }, [loadShorts]);
  // while anything is rendering, check every 10 s
  const working = shorts.some((s) => s.status.state === 'queued' || s.status.state === 'rendering');
  useEffect(() => {
    if (!working) return;
    const id = setInterval(() => void loadShorts(), 10_000);
    return () => clearInterval(id);
  }, [working, loadShorts]);

  useEffect(() => {
    setPick(''); setErr('');
    if (kind === 'mystery' && !trades) {
      fetch('/api/shorts/candidates?kind=mystery', { cache: 'no-store' }).then(async (r) => {
        const j = await r.json(); if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
        setTrades(j.trades); setCutoff(j.cutoff);
      }).catch((e) => setErr((e as Error).message));
    }
    if (kind === 'vs' && !weeks) {
      fetch('/api/shorts/candidates?kind=vs', { cache: 'no-store' }).then(async (r) => {
        const j = await r.json(); if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
        setWeeks(j.weeks);
      }).catch((e) => setErr((e as Error).message));
    }
  }, [kind, trades, weeks]);

  const generate = async () => {
    setBusy(true); setErr('');
    try {
      const body = kind === 'mystery'
        ? (() => { const t = trades?.find((x) => x.id === pick); return { kind, tradeId: t?.id, date: t?.date, tell }; })()
        : { kind, week: pick, notes };
      const r = await fetch('/api/shorts/generate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dhan-token': token ?? '' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) setErr(j.message ?? `HTTP ${r.status}`);
      else { setPick(''); setTell(''); setNotes({ me: '', algo: '' }); }
      await loadShorts();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Delete this short?')) return;
    await fetch('/api/shorts/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => null);
    void loadShorts();
  };

  const week = weeks?.find((w) => w.week === pick);
  const tab = (k: Kind, label: string) => (
    <button onClick={() => setKind(k)} className={`rounded-full px-4 py-1.5 text-sm font-semibold ${kind === k ? 'bg-brand-accent text-brand-bg' : 'text-ink-3 hover:text-white'}`}>{label}</button>
  );

  return (
    <section className="mt-8">
      <h2 className="text-xl font-semibold text-white">Make a short</h2>
      <p className="mt-1 text-sm text-ink-3">Drawn from your real trades and candles. Rendering takes a few minutes on GitHub; it shows below when ready.</p>

      <div className="mt-4 rounded-2xl border border-line-strong bg-brand-card p-4">
        <div className="mb-4 inline-flex gap-1 rounded-full border border-line-strong p-1">
          {tab('mystery', 'Mystery chart')}{tab('vs', 'Me vs Algo')}
        </div>

        {kind === 'mystery' && (
          <>
            <p className="mb-2 text-xs text-ink-3">Trades from {cutoff ? dateFmt(cutoff) : '…'} or earlier: the ticker is revealed at the end, so only trades over 3 months old (SEBI).</p>
            {!trades ? <Loader2 className="size-5 animate-spin text-ink-3" /> : !trades.length ? <p className="text-sm text-ink-3">No trades that old yet.</p> : (
              <div className="max-h-72 overflow-y-auto rounded-xl border border-line">
                {trades.map((t) => (
                  <label key={t.id} className={`flex cursor-pointer items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-0 ${pick === t.id ? 'bg-white/5' : ''}`}>
                    <input type="radio" name="trade" checked={pick === t.id} onChange={() => setPick(t.id)} className="accent-[var(--color-brand-accent)]" />
                    <span className="w-24 text-ink-3">{dateFmt(t.date)}</span>
                    <span className="w-28 font-semibold text-white">{t.symbol}</span>
                    <span className={`w-14 text-xs font-bold ${t.dir === 'LONG' ? 'text-data-green' : 'text-data-red-text'}`}>{t.dir}</span>
                    <span className="w-14 text-ink-3">{t.entryTime}</span>
                    <span className="w-16 text-ink-3">{t.holdMin} min</span>
                    <span className={`ml-auto font-semibold ${tone(t.result.value)}`}>{fmt(t.result)}</span>
                  </label>
                ))}
              </div>
            )}
            <label className="mt-3 block text-sm text-ink-2">
              The tell <span className="text-ink-4">(optional, one line shown at the end: what gave the trade away)</span>
              <input value={tell} onChange={(e) => setTell(e.target.value.slice(0, 90))} placeholder="e.g. Three tests of the same low, each wick longer"
                className="mt-1 w-full rounded-lg border border-line-strong bg-brand-bg px-3 py-2 text-sm text-white placeholder:text-ink-4" />
            </label>
          </>
        )}

        {kind === 'vs' && (
          <>
            {!weeks ? <Loader2 className="size-5 animate-spin text-ink-3" /> : !weeks.length ? <p className="text-sm text-ink-3">No finished week since Algo Live started yet.</p> : (
              <div className="rounded-xl border border-line">
                {weeks.map((w) => (
                  <label key={w.week} className={`flex cursor-pointer flex-wrap items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-0 ${pick === w.week ? 'bg-white/5' : ''}`}>
                    <input type="radio" name="week" checked={pick === w.week} onChange={() => setPick(w.week)} className="accent-[var(--color-brand-accent)]" />
                    <span className="w-36 font-semibold text-white">{w.label}</span>
                    <span>Me <b className={tone(w.me.r)}>{fmtR(w.me.r)}</b> <span className="text-ink-4">({w.me.n})</span></span>
                    <span>Algo <b className={tone(w.algo.r)}>{fmtR(w.algo.r)}</b> <span className="text-ink-4">({w.algo.n})</span></span>
                    <span className="ml-auto text-xs font-bold uppercase text-brand-accent">{w.winner === 'none' ? 'no trades' : w.winner === 'tie' ? 'tie' : `${w.winner} wins`}</span>
                  </label>
                ))}
              </div>
            )}
            {week && (
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {(['me', 'algo'] as const).map((side) => {
                  const t = side === 'me' ? week.meTrade : week.algoTrade;
                  return (
                    <label key={side} className="block text-sm text-ink-2">
                      {side === 'me' ? 'Your' : 'Algo\'s'} trade of the week: <b className="text-white">{t ? `${t.symbol} ${fmtR(t.r)}` : 'none'}</b>
                      <input value={notes[side]} disabled={!t} onChange={(e) => setNotes((n) => ({ ...n, [side]: e.target.value.slice(0, 40) }))} placeholder="One-line reason (optional)"
                        className="mt-1 w-full rounded-lg border border-line-strong bg-brand-bg px-3 py-2 text-sm text-white placeholder:text-ink-4 disabled:opacity-40" />
                    </label>
                  );
                })}
                {(week.me.uncounted > 0 || week.algo.uncounted > 0) && <p className="text-xs text-ink-4 md:col-span-2">Trades without a logged stop aren&apos;t scored (me {week.me.uncounted}, algo {week.algo.uncounted}).</p>}
              </div>
            )}
          </>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button onClick={generate} disabled={!pick || busy}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-brand-accent px-5 text-sm font-semibold text-brand-bg hover:bg-brand-accent-hover disabled:opacity-40">
            {busy && <Loader2 className="size-4 animate-spin" />}Generate
          </button>
          {err && <span className="text-sm text-data-red-text">{err}</span>}
        </div>
      </div>

      {shorts.length > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {shorts.map((s) => (
            <div key={s.id} className="overflow-hidden rounded-2xl border border-line-strong bg-brand-card">
              <div className="flex aspect-[9/16] items-center justify-center bg-black">
                {s.status.state === 'done' && s.video
                  ? <video src={s.video} poster={s.poster} controls playsInline preload="none" className="size-full object-contain" />
                  : s.status.state === 'failed'
                    ? <p className="px-3 text-center text-xs text-data-red-text">{s.status.error ?? 'Render failed.'}</p>
                    : <span className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="size-4 animate-spin" />{s.status.state === 'queued' ? 'Waiting for GitHub' : 'Rendering'}</span>}
              </div>
              <div className="flex items-start justify-between gap-2 p-3">
                <p className="text-xs leading-5 text-ink-2">{s.label}</p>
                <button onClick={() => remove(s.id)} aria-label="Delete" className="text-ink-4 hover:text-data-red-text"><Trash2 className="size-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
