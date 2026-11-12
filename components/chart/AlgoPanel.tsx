'use client';
import { X } from 'lucide-react';
import type { AlgoView } from '@/lib/chart/algo';
import type { FactPush } from '@/lib/algoLive/why';
import type { AlgoParts } from './stores';

const r = (v: number | null | undefined, d = 4) => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}R`);
const val = (v: number | null) => (v === null ? '—' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

function Push({ p, up }: { p: FactPush; up: boolean }) {
  return (
    <li className="flex items-start justify-between gap-2 py-1">
      <span className="min-w-0">
        <span className="block text-ink">{p.label}</span>
        <span className="block text-[11px] text-ink-3">
          {val(p.value)}{p.listMedian !== null ? ` (list median ${val(p.listMedian)})` : ''}{p.aboveListPct !== null ? ` · above ${p.aboveListPct}% of the list` : ''}
        </span>
      </span>
      <span className={`shrink-0 font-mono text-xs ${up ? 'text-data-green' : 'text-data-red-text'}`}>{r(p.pushR, 3)}</span>
    </li>
  );
}

/** What Algo Live saw for this stock: every close, the bar, the reasons at the chosen close, its order. */
export function AlgoPanel({ view: v, slot, onSlot, onClose, parts, onParts }: { view: AlgoView; slot: number | null; onSlot: (s: number) => void; onClose: () => void; parts: AlgoParts; onParts: (p: AlgoParts) => void }) {
  const sel = v.closes.find((c) => c.slot === slot);
  return (
    <aside className="flex w-[300px] shrink-0 flex-col overflow-hidden border-l border-line bg-brand-section text-xs">
      <div className="flex items-start justify-between gap-2 border-b border-line px-3 py-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-brand-accent">Algo Live · {v.date}</p>
          <p className="mt-0.5 text-sm font-semibold text-white">{v.symbol}</p>
          <p className="text-[11px] text-ink-3">
            {v.onList ? `On the day list (${v.listSize})` : 'Not on the day list'}{v.vetoed ? ' · VETOED' : ''}
            {v.model ? ` · iteration ${v.model.iteration ?? '?'} (${v.model.version})` : ''}
          </p>
        </div>
        <button onClick={onClose} title="Hide Algo Live (the chart stays clean)" className="text-ink-3 hover:text-white"><X className="size-4" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-[11px]">
          <span className="text-ink-3">On the charts:</span>
          {([['dots', 'Close dots'], ['levels', 'Levels'], ['orders', 'Order lines']] as const).map(([k, l]) => (
            <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={parts[k]} onChange={(e) => onParts({ ...parts, [k]: e.target.checked })} />{l}</label>
          ))}
        </div>
        <div className="px-3 pt-2 text-[11px] text-ink-3">
          Bar to clear: <span className="font-mono text-ink">{r(v.bar)}</span>{v.standAside ? ' · standing aside this month' : ''}
        </div>
        <table className="mt-1 w-full">
          <thead><tr className="text-[10px] uppercase tracking-wider text-ink-3"><th className="px-3 py-1 text-left">Close</th><th className="text-right">Score</th><th className="text-right">Rank</th><th className="px-3 text-right"> </th></tr></thead>
          <tbody>
            {v.closes.map((c) => (
              <tr key={c.slot} onClick={() => c.hasFacts && onSlot(c.slot)}
                className={`border-t border-line/60 font-mono ${c.slot === slot ? 'bg-brand-accent/10' : ''} ${c.hasFacts ? 'cursor-pointer hover:bg-white/5' : ''}`}>
                <td className="px-3 py-1 font-sans">{c.time}{c.slot === 10 ? <span className="ml-1 text-[10px] text-ink-3">list</span> : null}</td>
                <td className={`text-right ${c.above ? 'text-brand-accent' : ''}`}>{c.scoreR === null ? '—' : c.scoreR.toFixed(4)}</td>
                <td className="text-right text-ink-3">{c.rank ? `${c.rank}/${c.of}` : '—'}</td>
                <td className="px-3 text-right font-sans text-[10px]">{c.picked ? <b className="text-data-red-text">PICKED</b> : c.above ? <span className="text-brand-accent">clears</span> : ''}</td>
              </tr>
            ))}
            {!v.closes.length && <tr><td colSpan={4} className="px-3 py-2 text-ink-3">No close scored yet today.</td></tr>}
          </tbody>
        </table>

        {v.orders.map((o) => (
          <div key={o.sentAt} className="mx-3 mt-3 rounded-lg border border-line-strong p-2">
            <p className="font-semibold text-white">Algo {o.side} at {o.time} · {o.status}</p>
            <p className="mt-0.5 font-mono text-[11px]">qty {o.qty} · entry {o.avgPrice || o.price} · stop <span className="text-data-red-text">{o.stop}</span> · target <span className="text-data-green">{o.target}</span></p>
          </div>
        ))}

        {v.reasons && sel && (
          <div className="px-3 pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-3">Why the score at {sel.time}</p>
            <p className="mt-1 text-[11px] text-ink-3">Each fact swapped for what the other {v.reasons.stocksCompared} stocks on the list had: how much it moved this stock&apos;s score.</p>
            {v.reasons.toward.length > 0 && <>
              <p className="mt-2 font-semibold text-data-green">Pushed it up</p>
              <ul>{v.reasons.toward.map((p) => <Push key={p.fact} p={p} up />)}</ul>
            </>}
            {v.reasons.against.length > 0 && <>
              <p className="mt-2 font-semibold text-data-red-text">Held it back</p>
              <ul>{v.reasons.against.map((p) => <Push key={p.fact} p={p} up={false} />)}</ul>
            </>}
          </div>
        )}
        {sel?.levels && sel.levels.length > 0 && (
          <div className="px-3 pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-3">Levels it read at {sel.time} (on the chart)</p>
            <ul className="mt-1 grid grid-cols-2 gap-x-3 font-mono text-[11px]">
              {sel.levels.map((l) => <li key={l.key} className="flex justify-between"><span className="font-sans text-ink-3">{l.label}</span>{l.price.toFixed(2)}</li>)}
            </ul>
          </div>
        )}
        {v.model && v.model.leansOnMost.length > 0 && (
          <p className="px-3 pt-3 text-[11px] text-ink-3">This month&apos;s model leans most on: {v.model.leansOnMost.join(', ')}.</p>
        )}
        {v.notes.map((n) => <p key={n} className="px-3 pt-3 text-[11px] text-data-caution">{n}</p>)}
        <p className="px-3 py-3 text-[11px] text-ink-3">Click a close (or its dot on the chart) to see that moment. Algo button in the top bar hides all of this.</p>
      </div>
    </aside>
  );
}
