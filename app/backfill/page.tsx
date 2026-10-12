"use client";
import React, { useRef, useState } from 'react';
import { Loader2, Play, Search, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/context/AuthContext';
import { postWithToken } from '@/components/live/useLiveSession';
import type { PlanResult, RunItemResult, RunResult } from '@/lib/live/backfill';

const CHUNK = 3;
const ABORT_TEXT: Record<string, string> = {
  TOKEN_EXPIRED: 'The token expired. Paste a fresh one and run again; finished trades are kept.',
  NO_DATA_PLAN: 'Dhan says the Data API plan is not active. Subscribe, then run again; finished trades are kept.',
};

export default function BackfillPage() {
  const { token, setToken } = useAuth();
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [busy, setBusy] = useState<'' | 'plan' | 'run'>('');
  const [redo, setRedo] = useState(false);
  const [done, setDone] = useState(0);
  const [results, setResults] = useState<RunItemResult[]>([]);
  const [msg, setMsg] = useState('');
  const stopFlag = useRef(false);

  const doPlan = async () => {
    setBusy('plan'); setMsg(''); setResults([]); setDone(0);
    try { setPlan(await postWithToken<PlanResult>('/api/backfill/plan', token, { redo })); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(''); }
  };

  const run = async () => {
    if (!plan?.items.length) return;
    setBusy('run'); setMsg(''); stopFlag.current = false; setResults([]); setDone(0);
    const items = plan.items;
    let n = 0;
    try {
      for (let i = 0; i < items.length && !stopFlag.current; i += CHUNK) {
        const slice = items.slice(i, i + CHUNK).map(({ tab, groupId }) => ({ tab, groupId }));
        const r = await postWithToken<RunResult>('/api/backfill/run', token, { items: slice });
        setResults((p) => [...p, ...r.results]);
        n += r.results.length; setDone(n);
        if (r.aborted) { setMsg(ABORT_TEXT[r.aborted]); break; }
      }
      if (!stopFlag.current && n >= items.length) setMsg('Finished. Press "Check" again to confirm nothing is left.');
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(''); }
  };

  const [pick, setPick] = useState('');
  const [inspect, setInspect] = useState('');
  const doInspect = async () => {
    const it = plan?.items.find((i) => i.groupId === pick);
    if (!it) return;
    setInspect('Loading…');
    try { setInspect(JSON.stringify(await postWithToken('/api/backfill/inspect', token, { tab: it.tab, groupId: it.groupId }))); }
    catch (e) { setInspect((e as Error).message); }
  };
  const total = plan?.items.length ?? 0;
  const bad = results.filter((r) => r.status !== 'OK');

  return (
    <div className="min-h-screen bg-brand-bg text-zinc-100 font-sans pb-24">
      <div className="max-w-4xl mx-auto px-4 pt-2 space-y-8">
        <header className="space-y-0.5 border-b border-zinc-900 pb-6">
          <h1 className="text-2xl font-black tracking-tighter">Backfill Market Data</h1>
          <p className="text-[9px] font-bold text-brand-text uppercase tracking-[0.2em]">Stock: relative volume, ATR, excursions • Nifty 500: first-5-min and at-entry move</p>
        </header>

        <p className="text-sm text-zinc-400">
          Fills the market columns for trades already in your sheet. New columns are created for you. Direction, times and prices come from your own fills.
          This needs the Dhan Data API only while it runs: history goes back years, so one paid month can enrich everything, then you can cancel.
        </p>

        <div className="flex gap-2 p-2 bg-brand-card rounded-2xl">
          <Input type="password" placeholder="Dhan Auth Token" value={token} onChange={(e) => setToken(e.target.value)}
            className="bg-brand-card border-none h-10 text-xs focus-visible:ring-0 placeholder:text-brand-text/20 font-mono" />
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <Button onClick={doPlan} disabled={!token || !!busy} className="h-10 bg-brand-accent hover:bg-brand-accent/90 text-black font-black uppercase tracking-tighter">
            {busy === 'plan' ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Search className="w-4 h-4 mr-2" />}Check what needs filling
          </Button>
          <label className="flex items-center gap-2 text-xs text-zinc-400"><input type="checkbox" checked={redo} onChange={(e) => setRedo(e.target.checked)} className="accent-indigo-600" />Redo trades already filled</label>
        </div>

        {plan && (
          <div className="bg-brand-card rounded-3xl border border-zinc-800 p-6 space-y-4">
            <div className="flex flex-wrap gap-8">
              <Num label="To fill" v={plan.pending} /><Num label="Already done" v={plan.done} /><Num label="Monthly sheets" v={plan.tabs.length} />
            </div>
            {total > 0 && (
              <>
                <div className="flex gap-3">
                  {busy === 'run'
                    ? <Button onClick={() => { stopFlag.current = true; }} className="bg-data-red/90 hover:bg-data-red text-white font-black"><Square className="w-3 h-3 mr-2" />Stop</Button>
                    : <Button onClick={run} className="bg-data-green hover:bg-data-green/90 text-black font-black"><Play className="w-3 h-3 mr-2" />Start backfill ({total} trades)</Button>}
                </div>
                <div className="h-2 rounded-full bg-zinc-900 overflow-hidden"><div className="h-full bg-brand-accent transition-all" style={{ width: `${Math.min(100, (done / total) * 100)}%` }} /></div>
                <p className="text-[11px] text-zinc-500">{done} / {total} done</p>
              </>
            )}
            {total === 0 && <p className="text-sm text-data-green font-bold">Everything is filled.</p>}
          </div>
        )}

        {plan && plan.items.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Inspect volume numbers for one trade</h2>
            <div className="flex gap-2">
              <select value={pick} onChange={(e) => setPick(e.target.value)} className="bg-brand-card text-xs rounded-lg px-3 h-9 flex-1 font-mono">
                <option value="">Choose a trade…</option>
                {plan.items.map((i) => <option key={i.groupId} value={i.groupId}>{i.date} {i.symbol}</option>)}
              </select>
              <Button size="sm" variant="outline" onClick={doInspect} disabled={!pick || !token}>Inspect</Button>
            </div>
            {inspect && <textarea readOnly value={inspect} className="w-full h-40 bg-brand-card rounded-xl p-3 text-[10px] font-mono text-zinc-300" onFocus={(e) => e.currentTarget.select()} />}
          </section>
        )}

        {msg && <div className="p-4 bg-brand-card border border-zinc-800 rounded-2xl text-xs font-bold text-brand-accent">{msg}</div>}

        {bad.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Needs a look ({bad.length})</h2>
            <ul className="bg-brand-card rounded-2xl divide-y divide-zinc-900 text-xs font-mono">
              {bad.map((r) => <li key={r.groupId} className="px-4 py-2 flex gap-3"><span className="font-black">{r.symbol}</span><span className={r.status === 'FAILED' ? 'text-data-red' : 'text-brand-accent'}>{r.status}</span><span className="text-zinc-400">{r.detail}</span></li>)}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function Num({ label, v }: { label: string; v: number }) {
  return <div><p className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest">{label}</p><p className="text-3xl font-black tracking-tighter">{v}</p></div>;
}
