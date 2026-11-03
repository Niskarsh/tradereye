"use client";
import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Card } from '@/components/setups/parts';
import type { MeVsAlgoRow, MeVsAlgoTotals } from '@/lib/algoLive/meVsAlgo';

const NEEDED = 20;
const inr = (x: number | null) => (x === null ? '–' : `${x > 0 ? '+' : x < 0 ? '−' : ''}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`);
const tone = (x: number | null) => (x === null || x === 0 ? '' : x > 0 ? 'text-data-green' : 'text-data-red-text');
const TH = 'px-2 py-1.5 text-right';

/** Me vs Algo: what the algo proposed, what he did, what the untouched bracket did (lib/algoLive/meVsAlgo.ts) */
export function MeVsAlgoCard({ token }: { token: string | null | undefined }) {
  const [d, setD] = useState<{ rows: MeVsAlgoRow[]; totals: MeVsAlgoTotals } | null>(null);
  const [err, setErr] = useState('');
  const load = () => {
    setErr('');
    fetch('/api/algo/me-vs-algo', { headers: { 'x-dhan-token': token ?? '' }, cache: 'no-store' }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setD(j);
    }).catch((e) => setErr((e as Error).message));
  };
  useEffect(load, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = d?.totals;
  return (
    <Card title="Me vs Algo" sub="Every Algo Live trade: what it proposed, what you did, and what would have happened if you had left the stop and target alone. After charges. The untouched result uses the backtest's fill rules, so it is an estimate.">
      <button className="w-fit rounded-lg border px-3 py-1.5 text-xs font-bold" onClick={load}>Refresh</button>
      {err && <p className="text-xs text-data-red-text">{err}</p>}
      {!d && !err && <p className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="h-4 w-4 animate-spin" />Reading trades…</p>}
      {t && (
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div><p className="text-[10px] uppercase tracking-widest text-ink-3">You</p><p className={`font-mono font-bold ${tone(t.myInr)}`}>{inr(t.myInr)}</p></div>
          <div><p className="text-[10px] uppercase tracking-widest text-ink-3">Untouched</p><p className={`font-mono font-bold ${tone(t.planInr)}`}>{inr(t.planInr)}</p></div>
          <div><p className="text-[10px] uppercase tracking-widest text-ink-3">Your difference</p><p className={`font-mono font-bold ${tone(t.diffInr)}`}>{inr(t.diffInr)}</p></div>
          <div><p className="text-[10px] uppercase tracking-widest text-ink-3">You stepped in</p><p className="font-mono font-bold">{t.steppedIn} of {t.closed} <span className="text-[11px] font-normal text-ink-3">({t.helped} helped, {t.hurt} hurt)</span></p></div>
        </div>
      )}
      {t && t.steppedIn < NEEDED && <p className="text-xs text-ink-2">Too few yet to judge your exits: {t.steppedIn} of {NEEDED} trades where you stepped in.</p>}
      {d && d.rows.length > 0 && (
        <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-xs"><thead><tr className="border-b border-line text-[10px] font-black uppercase tracking-widest text-ink-3">
          <th className="px-2 py-1.5 text-left">Day</th><th className="px-2 py-1.5 text-left">Stock</th><th className={TH}>Entry</th><th className={TH}>Stop</th><th className={TH}>Target</th>
          <th className={TH}>You got out</th><th className={TH}>Best move</th><th className={TH}>Untouched</th><th className={TH}>You</th><th className={TH}>Untouched ₹</th><th className={TH}>Difference</th>
        </tr></thead><tbody>
          {d.rows.map((r) => (
            <tr key={`${r.date}-${r.symbol}-${r.time}`} className="border-b border-line/60 font-mono tabular-nums">
              <td className="px-2 py-1.5">{r.date.slice(5)} {r.time}</td><td className="px-2 py-1.5 font-sans font-bold">{r.symbol}</td>
              <td className={TH}>{r.entry.toFixed(2)}</td><td className={TH}>{r.stop.toFixed(2)}</td><td className={TH}>{r.target.toFixed(2)}</td>
              <td className={TH}>{r.myExit !== null ? `${r.myExit.toFixed(2)}${r.myTime ? ` · ${r.myTime}` : ''} · ${r.myHow}` : r.myHow}{r.lastStop !== null && Math.abs(r.lastStop - r.stop) > 0.01 ? ` · stop moved to ${r.lastStop.toFixed(2)}` : ''}</td>
              <td className={TH}>{r.peakPct !== null ? `${r.peakPct}% to target${r.peakTime ? ` · ${r.peakTime}` : ''}` : '–'}</td>
              <td className={TH}>{r.note ?? (r.planOutcome ? `${r.planOutcome === 'OPEN' ? 'still open' : r.planOutcome} · ${r.planTime}` : '–')}</td>
              <td className={`${TH} ${tone(r.myInr)}`}>{inr(r.myInr)}</td><td className={`${TH} ${tone(r.planInr)}`}>{inr(r.planInr)}</td>
              <td className={`${TH} font-bold ${tone(r.diffInr)}`}>{inr(r.diffInr)}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      {d && !d.rows.length && <p className="text-xs text-ink-3">No filled Algo Live orders yet.</p>}
    </Card>
  );
}
