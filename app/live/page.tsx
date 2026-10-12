"use client";
import React, { useState } from 'react';
import { Loader2, Play, RefreshCcw, Square, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/context/AuthContext';
import { useLiveSession, postWithToken } from '@/components/live/useLiveSession';
import { ClosedTable, OpenTradeCard } from '@/components/live/TradeCards';
import { countdown, inr, tone } from '@/components/live/format';

const WS_LABEL: Record<string, string> = {
  idle: 'Not connected', connecting: 'Connecting…', open: 'Live', reconnecting: 'Reconnecting…',
  failed: 'Unavailable (polling instead)', closed: 'Closed',
};

export default function LivePage() {
  const { token, setToken } = useAuth();
  const s = useLiveSession(token);
  const [renewing, setRenewing] = useState(false);
  const [renewMsg, setRenewMsg] = useState('');
  const running = s.state === 'running';
  const d = s.data;
  const open = d?.groups.filter((g) => g.status === 'OPEN') ?? [];
  const closed = d?.groups.filter((g) => g.status === 'CLOSED') ?? [];
  const msLeft = s.profile?.expiresAtMs ? s.profile.expiresAtMs - s.now : null;

  const renew = async () => {
    setRenewing(true); setRenewMsg('');
    try {
      const r = await postWithToken<{ accessToken: string }>('/api/live/renew', token);
      setToken(r.accessToken);
      await s.adoptToken(r.accessToken);
      setRenewMsg('Token renewed for another 24h. The old one no longer works.');
    } catch (e) { setRenewMsg((e as Error).message); } finally { setRenewing(false); }
  };

  return (
    <div className="min-h-screen bg-brand-bg text-zinc-100 font-sans pb-24">
      <div className="max-w-5xl mx-auto px-4 pt-2 space-y-8">
        <header className="flex justify-between items-center border-b border-zinc-900 pb-6">
          <div className="space-y-0.5">
            <h1 className="text-2xl font-black tracking-tighter">Live Session</h1>
            <p className="text-[9px] font-bold text-brand-text uppercase tracking-[0.2em]">Automatic trade capture • NSE</p>
          </div>
          {running
            ? <Button onClick={() => s.stop()} className="h-10 bg-data-red/90 hover:bg-data-red text-white font-black uppercase tracking-tighter"><Square className="w-3 h-3 mr-2" />End session</Button>
            : <Button onClick={s.start} disabled={s.state === 'starting' || !token} className="h-10 bg-brand-accent hover:bg-brand-accent/90 text-black font-black uppercase tracking-tighter">
                {s.state === 'starting' ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-3 h-3 mr-2" />}Start session
              </Button>}
        </header>

        <div className="flex gap-2 p-2 bg-brand-card rounded-2xl">
          <Input type="password" placeholder="Dhan Auth Token" value={token} onChange={(e) => setToken(e.target.value)}
            className="bg-brand-card border-none h-10 text-xs focus-visible:ring-0 placeholder:text-brand-text/20 font-mono" />
          <Button size="sm" variant="outline" className="h-10" onClick={renew} disabled={!token || renewing} title="Swap this token for a fresh 24h one">
            {renewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4 mr-1" />}Renew
          </Button>
        </div>
        {renewMsg && <p className="text-[11px] text-zinc-400">{renewMsg}</p>}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <Chip label="Session" value={running ? 'Running' : s.state === 'ended' ? 'Ended' : 'Off'} ok={running} />
          <Chip label="Order feed" value={WS_LABEL[s.ws]} ok={s.ws === 'open'} />
          <Chip label="Token" value={msLeft === null ? '—' : countdown(msLeft)} ok={msLeft === null || msLeft > 30 * 60_000} />
          <Chip label="Last sync" value={s.lastOkAt ? `${Math.max(0, Math.round((s.now - s.lastOkAt) / 1000))}s ago` : '—'} ok={!!s.lastOkAt && s.now - s.lastOkAt < 40_000} />
        </div>

        {s.error && <div className="p-4 bg-data-red/10 border border-data-red/30 rounded-2xl text-xs font-bold text-data-red">{s.error}</div>}
        {!running && s.state !== 'ended' && (
          <p className="text-sm text-zinc-500">Paste your token and press Start. Your trades, stop moves and targets are captured while this page stays open; the session ends on its own when the token expires.</p>
        )}

        {d && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Big label="Net today (closed)" value={inr(d.totals.closedNet, 2)} cls={tone(d.totals.closedNet)} sub={`${d.totals.closedCount} trades • charges ${inr(d.totals.charges, 2)}`} />
              <Big label="Open now" value={inr(d.totals.openUnrealized, 2)} cls={tone(d.totals.openUnrealized)} sub={`${d.totals.openCount} open • not in stats yet`} />
              <Big label="Gross today" value={inr(d.totals.closedGross, 2)} cls={tone(d.totals.closedGross)} sub="before charges" />
              <div className="flex items-end"><Button variant="outline" size="sm" onClick={s.syncNow}><RefreshCcw className="w-3 h-3 mr-2" />Sync now</Button></div>
            </div>

            {open.length > 0 && <section className="space-y-4"><h2 className="text-[10px] font-black uppercase tracking-widest text-zinc-500">In progress</h2>{open.map((t) => <OpenTradeCard key={t.id} t={t} now={s.now} />)}</section>}

            <section className="space-y-4"><h2 className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Completed today</h2><ClosedTable rows={closed} /></section>

            <section className="space-y-3">
              <h2 className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Order activity</h2>
              {(d.recentEvents ?? []).length === 0 ? <p className="text-sm text-zinc-500">Nothing yet.</p> : (
                <ul className="bg-brand-card rounded-2xl divide-y divide-zinc-900">
                  {d.recentEvents!.slice(0, 20).map((e, i) => (
                    <li key={i} className="px-4 py-2 flex gap-3 text-xs font-mono">
                      <span className="text-zinc-600">{e.time.slice(11, 19)}</span>
                      <span className="font-black">{e.symbol}</span>
                      <span className={e.side === 'BUY' ? 'text-data-green' : 'text-data-red'}>{e.side}</span>
                      <span className="text-zinc-400">{e.note || `${e.kind} ${e.status}`}</span>
                      <span className="ml-auto text-zinc-600">{e.src}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function Chip({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="bg-brand-card rounded-2xl px-4 py-3 border border-zinc-900">
      <p className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest">{label}</p>
      <p className={`font-black ${ok ? 'text-data-green' : 'text-zinc-300'}`}>{value}</p>
    </div>
  );
}
function Big({ label, value, cls, sub }: { label: string; value: string; cls: string; sub: string }) {
  return (
    <div className="bg-brand-card rounded-2xl p-5 border border-zinc-900">
      <p className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest">{label}</p>
      <p className={`text-3xl font-black tracking-tighter ${cls}`}>{value}</p>
      <p className="text-[10px] text-zinc-600 mt-1">{sub}</p>
    </div>
  );
}
