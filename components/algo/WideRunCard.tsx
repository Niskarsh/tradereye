"use client";
import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { ProgressBar } from '@/components/ui/progress';
import { Card } from '@/components/setups/parts';
import type { RunStatus } from '@/lib/setups/store';

/** Starts and follows Algo Lab's wide-universe run (iteration 12). Research only: Algo Live does not read its results. */
export function WideRunCard({ onDone }: { onDone: () => void }) {
  const { token } = useAuth();
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState('');
  const [override, setOverride] = useState(false);
  const load = useCallback(async () => {
    const j = await (await fetch('/api/algo/wide', { cache: 'no-store' })).json();
    setStatus(j.status ?? null); setActive(!!j.active);
    return !!j.active;
  }, []);
  useEffect(() => { load().catch(() => {}); }, [load]);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { load().then((still) => { if (!still) onDone(); }).catch(() => {}); }, 15000);
    return () => clearInterval(id);
  }, [active, load, onDone]);
  const start = async () => {
    setStarting(true); setErr('');
    try {
      const r = await fetch('/api/algo/wide', { method: 'POST', headers: { 'x-dhan-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ override }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setStatus(j.status); setActive(true);
    } catch (e) { setErr((e as Error).message); } finally { setStarting(false); }
  };
  return (
    <Card title="Wider universe (iteration 12)" sub="F on ₹250–1000 stocks against ₹250–340. Research only: Algo Live keeps its model, its list and its orders."
      right={<button onClick={start} disabled={!token || starting || active} className="flex h-10 items-center gap-2 rounded-xl border border-brand-accent px-4 text-xs font-black text-brand-accent disabled:opacity-40">
        {(starting || active) && <Loader2 className="h-4 w-4 animate-spin" />}{active ? 'Running' : 'Run'}
      </button>}>
      {active && status && (
        <div className="space-y-1">
          <p className="text-xs text-ink-2">{status.phase}{status.total ? ` · ${status.done ?? 0} of ${status.total}` : ''}</p>
          <ProgressBar value={status.total ? (status.done ?? 0) / status.total : undefined} />
        </div>
      )}
      {!active && status?.message && <p className={`text-xs ${status.state === 'failed' ? 'text-data-red-text' : 'text-ink-2'}`}>{status.message}</p>}
      {!active && !status?.message && <p className="text-xs text-ink-3">{token ? 'Takes most of a day the first time. Start it in the evening or at a weekend: it stops itself between 08:40 and 11:15 on trading days unless you tick the box below. NSE holidays run at full speed.' : 'Log in on the Dhan login tab first.'}</p>}
      {!active && (
        <label className="mt-2 flex items-start gap-2 text-xs text-ink-2">
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="mt-0.5 accent-brand-accent" />
          <span>Run during market hours: keeps going 08:40–11:15 at 1 Dhan request a second there (Algo Live keeps the rest), so that stretch is slower. Applies to this run only.</span>
        </label>
      )}
      {err && <p className="mt-1 text-xs text-data-red-text">{err}</p>}
    </Card>
  );
}
