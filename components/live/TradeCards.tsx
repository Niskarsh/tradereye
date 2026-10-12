"use client";
import type { LiveGroupView } from '@/lib/live/sync';
import { dur, inr, tone } from './format';

const Stat = ({ label, value, cls = '' }: { label: string; value: string; cls?: string }) => (
  <div>
    <p className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest">{label}</p>
    <p className={`text-sm font-black font-mono ${cls}`}>{value}</p>
  </div>
);

export function DirTag({ d }: { d: 'LONG' | 'SHORT' }) {
  return <span className={`text-[10px] font-black tracking-widest px-2 py-0.5 rounded-full border ${d === 'LONG' ? 'text-data-green border-data-green/30' : 'text-data-red border-data-red/30'}`}>{d}</span>;
}

export function OpenTradeCard({ t, now }: { t: LiveGroupView; now: number }) {
  const heldSec = Math.max(0, Math.round((now - (Date.parse(`${t.date}T${t.entryTime}+05:30`) || now)) / 1000));
  return (
    <div className="bg-brand-card rounded-3xl border border-zinc-800 p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl font-black tracking-tight">{t.symbol}</span>
          <DirTag d={t.direction} />
          <span className="text-[10px] font-black uppercase tracking-widest text-brand-accent animate-pulse">In progress</span>
        </div>
        <div className="text-right">
          <p className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest">Unrealized</p>
          <p className={`text-2xl font-black ${tone(t.unrealized)}`}>{t.unrealized === null ? '—' : inr(t.unrealized, 2)}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Open qty" value={`${Math.abs(t.netQty)}${t.peakQty !== Math.abs(t.netQty) ? ` / peak ${t.peakQty}` : ''}`} />
        <Stat label="Avg cost" value={`₹${t.avgCost.toFixed(2)}`} />
        <Stat label="Entered" value={`${t.entryTime.slice(0, 5)} (${dur(heldSec)})`} />
        <Stat label="Adds" value={String(t.adds)} />
        <Stat label="Stop now" value={t.lastStop ? `₹${t.lastStop}` : 'none seen'} cls="text-data-red" />
        <Stat label="First stop" value={t.initialStop ? `₹${t.initialStop}` : '—'} />
        <Stat label="Risk (R)" value={t.riskInr ? inr(t.riskInr) : '—'} />
        <Stat label="Target shown" value={t.tpLast ? `₹${t.tpLast}` : '—'} cls="text-data-green" />
      </div>
      <p className="text-[11px] text-zinc-500">
        Booked so far {inr(t.realizedGross, 2)} before charges. This trade is kept out of Journal and Stats until the position is flat.
      </p>
    </div>
  );
}

const SAVE_LABEL: Record<string, { text: string; cls: string }> = {
  LOGGED: { text: 'Saved to sheet', cls: 'text-data-green' },
  DUPLICATE: { text: 'Already in sheet', cls: 'text-zinc-400' },
  CLOSED: { text: 'Saving…', cls: 'text-brand-accent' },
  STALE: { text: 'Left open overnight', cls: 'text-data-red' },
  OPEN: { text: 'Open', cls: 'text-brand-accent' },
};

export function ClosedTable({ rows }: { rows: LiveGroupView[] }) {
  if (!rows.length) return <p className="text-sm text-zinc-500">No completed trades yet today.</p>;
  return (
    <div className="bg-[#080808] rounded-3xl border border-zinc-900 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[9px] font-black text-zinc-600 uppercase tracking-widest">
            {['Time', 'Symbol', 'Side', 'Qty', 'In → Out', 'Held', 'Stop', 'Exit', 'Net', 'R', 'Sheet'].map((h) => <th key={h} className="px-4 py-3 whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((t) => {
            const s = SAVE_LABEL[t.saved] ?? SAVE_LABEL.CLOSED;
            return (
              <tr key={t.id} className="border-t border-zinc-900/60">
                <td className="px-4 py-3 font-mono text-zinc-500">{t.entryTime.slice(0, 5)}</td>
                <td className="px-4 py-3 font-black">{t.symbol}</td>
                <td className="px-4 py-3"><DirTag d={t.direction} /></td>
                <td className="px-4 py-3 font-mono">{t.peakQty}</td>
                <td className="px-4 py-3 font-mono text-zinc-400">{t.avgEntry.toFixed(2)} → {t.avgExit.toFixed(2)}</td>
                <td className="px-4 py-3 font-mono text-zinc-500">{dur(t.durationSec)}</td>
                <td className="px-4 py-3 font-mono text-zinc-500">{t.initialStop ? `${t.initialStop}${t.stopMoves ? ` (+${t.stopMoves} moves)` : ''}` : '—'}</td>
                <td className="px-4 py-3 text-[11px] uppercase tracking-wider text-zinc-500">{t.exitType}</td>
                <td className={`px-4 py-3 font-black font-mono ${tone(t.netPnl)}`}>{inr(t.netPnl, 2)}</td>
                <td className={`px-4 py-3 font-mono ${tone(t.rMultiple)}`}>{t.rMultiple === null ? '—' : `${t.rMultiple}R`}</td>
                <td className={`px-4 py-3 text-[11px] font-bold ${s.cls}`}>{s.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
