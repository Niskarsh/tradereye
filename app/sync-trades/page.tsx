"use client";
import React, { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCcw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { TokenBar } from '@/components/auth/TokenBar';
import { postWithToken } from '@/components/live/useLiveSession';
import { ClosedTable, OpenTradeCard } from '@/components/live/TradeCards';
import { inr, tone } from '@/components/live/format';
import type { SyncResult } from '@/lib/live/sync';
import { summarizeDay } from '@/lib/live/daySummary';

const Big = ({ label, value, cls = '', sub }: { label: string; value: string; cls?: string; sub?: string }) => (
  <div className="bg-brand-card rounded-3xl border border-zinc-800 p-5 space-y-1">
    <p className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest">{label}</p>
    <p className={`text-3xl font-black tracking-tight ${cls}`}>{value}</p>
    {sub && <p className="text-[11px] text-zinc-500">{sub}</p>}
  </div>
);

/**
 * One press: today's executions and orders from Dhan, paired into trades exactly as the Live tab pairs them (direction from
 * the first fill, adds and partial exits kept in one trade, stops and targets from the order book), priced after charges,
 * and every completed trade saved to its monthly sheet once. Same engine as Live (POST /api/live/sync), so a trade Live
 * already saved, or one you logged by hand, is recognised and not written again.
 */
export default function FetchTodaysTrades() {
  const { token } = useAuth();
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<SyncResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { document.documentElement.classList.add('dark'); }, []);

  const run = async () => {
    if (!token) { setError('Log in to Dhan first.'); return; }
    setBusy(true); setError('');
    try { setData(await postWithToken<SyncResult>('/api/live/sync', token)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const open = data?.groups.filter((g) => g.status === 'OPEN') ?? [];
  const closed = data?.groups.filter((g) => g.status === 'CLOSED') ?? [];
  const sum = data ? summarizeDay(data) : null;

  return (
    <div className="min-h-screen bg-brand-bg text-zinc-100 font-sans pb-24">
      <div className="page-shell pt-6 space-y-6">
        <header className="border-b border-zinc-900 pb-6 space-y-1">
          <h1 className="text-2xl font-black tracking-tighter">Fetch Today&apos;s Trades</h1>
          <p className="text-[11px] text-zinc-500">
            One press fetches every execution and order from Dhan, pairs them into trades (entries, adds, exits, stops and targets),
            works out profit or loss after charges, and saves each completed trade to this month&apos;s sheet. Pressing again is safe:
            nothing is written twice, and trades the Live tab or you already saved are left alone.
          </p>
        </header>

        <TokenBar />

        <Button size="lg" onClick={run} disabled={busy || !token}
          className="w-full h-16 bg-zinc-100 text-black hover:bg-zinc-300 font-black uppercase tracking-[0.2em] text-[11px] rounded-2xl shadow-xl">
          {busy ? <Loader2 className="w-5 h-5 mr-3 animate-spin" /> : <RefreshCcw className="w-4 h-4 mr-3" />}
          {busy ? 'Fetching, pairing and saving…' : data ? 'Fetch & save again' : "Fetch & save today's trades"}
        </Button>

        {error && (
          <div className="p-4 bg-rose-500/5 border border-rose-500/20 rounded-2xl flex items-center gap-3 text-sm text-rose-400">
            <AlertTriangle className="w-4 h-4 shrink-0" />{error}
          </div>
        )}

        {data && sum && (
          <>
            <div className={`p-4 rounded-2xl border flex items-center gap-3 text-sm ${sum.notSaved ? 'border-rose-500/20 bg-rose-500/5 text-rose-300' : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300'}`}>
              {sum.notSaved ? <AlertTriangle className="w-4 h-4 shrink-0" /> : <CheckCircle2 className="w-4 h-4 shrink-0" />}
              <span>{sum.line}<span className="text-zinc-500"> · as of {data.asOf.split(' ')[1]?.slice(0, 5) ?? data.asOf} IST</span></span>
            </div>

            {data.warnings.length > 0 && (
              <ul className="text-[12px] text-rose-300 space-y-1 list-disc pl-5">{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Big label="Net today (after charges)" value={inr(data.totals.closedNet, 2)} cls={tone(data.totals.closedNet)}
                sub={`${data.totals.closedCount} completed • charges ${inr(data.totals.charges, 2)}`} />
              <Big label="Gross today" value={inr(data.totals.closedGross, 2)} cls={tone(data.totals.closedGross)} sub="before charges" />
              <Big label="Open now" value={inr(data.totals.openUnrealized, 2)} cls={tone(data.totals.openUnrealized)}
                sub={`${data.totals.openCount} open • saved once flat`} />
            </div>

            {open.length > 0 && (
              <section className="space-y-4">
                <h2 className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Still open (not saved yet)</h2>
                {open.map((t) => <OpenTradeCard key={t.id} t={t} now={Date.now()} />)}
              </section>
            )}

            <section className="space-y-4">
              <h2 className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Completed today</h2>
              <ClosedTable rows={closed} pending="Not saved (press again)" />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
