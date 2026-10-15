"use client";
import React, { useState } from 'react';
import { Check, Loader2, Sparkles, X, ArrowRight, LogOut } from 'lucide-react';

export interface StoredReview {
  grade: 'SOLID' | 'MIXED' | 'POOR' | 'RAW'; headline: string; right: string[]; wrong: string[];
  exit: string; exitPoints: string[]; nextTime: string[]; at: string; costInr: number; model: string; version: string;
}

export function parseReview(raw?: string): StoredReview | null {
  if (!raw) return null;
  try { const r = JSON.parse(raw); return r && typeof r === 'object' && r.grade ? r as StoredReview : null; } catch { return null; }
}

const GRADE: Record<string, { label: string; tone: string }> = {
  SOLID: { label: 'Solid process', tone: 'border-emerald-500/50 text-emerald-400 bg-emerald-500/5' },
  MIXED: { label: 'Mixed process', tone: 'border-amber-500/50 text-amber-400 bg-amber-500/5' },
  POOR: { label: 'Poor process', tone: 'border-rose-500/50 text-rose-400 bg-rose-500/5' },
  RAW: { label: 'Review', tone: 'border-zinc-700 text-zinc-300' },
};
const EXIT: Record<string, string> = {
  EARLY: 'Exit: early', GOOD: 'Exit: good', OK: 'Exit: fine', STOPPED: 'Exit: stopped out',
  STOPPED_THEN_WORKED: 'Exit: stopped, then it worked', UNKNOWN: 'Exit',
};

function Section({ icon, title, items, tone }: { icon: React.ReactNode; title: string; items: string[]; tone: string }) {
  if (!items.length) return null;
  return (
    <div>
      <p className={`flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest mb-2 ${tone}`}>{icon}{title}</p>
      <ul className="space-y-1.5">
        {items.map((x, i) => <li key={i} className="flex gap-2 text-sm leading-snug text-zinc-300"><span className="text-zinc-600">•</span><span>{x}</span></li>)}
      </ul>
    </div>
  );
}

/**
 * "Review this trade": one Claude call per press (never automatic). The result is saved on the trade's row in the
 * month sheet, so the journal shows it from the sheet afterwards at no cost.
 */
export function TradeReview({ raw, sheetTitle, groupId, token, onSaved }: {
  raw?: string; sheetTitle?: string; groupId: string; token: string; onSaved: (json: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const r = parseReview(raw);

  const run = async () => {
    if (!sheetTitle) { setErr('Trade not found'); return; }
    if (r && !window.confirm('Review this trade again? It costs another Claude call.')) return;
    setBusy(true); setErr(''); setNote('');
    try {
      const res = await fetch('/api/journal/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'x-dhan-token': token } : {}) },
        body: JSON.stringify({ sheetTitle, tradeGroupId: groupId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.message || j.error || `HTTP ${res.status}`);
      onSaved(JSON.stringify(j.review));
      if (j.notes?.length) setNote(j.notes.join(' '));
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!r) {
    return (
      <div className="px-6 py-5 border-t border-zinc-800/50 flex flex-wrap items-center gap-3">
        <button onClick={run} disabled={busy}
          className="flex items-center gap-2 h-10 px-5 rounded-full bg-gradient-to-r from-cyan-500 to-violet-500 text-black text-[11px] font-black uppercase tracking-widest disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {busy ? 'Reviewing…' : 'Review this trade'}
        </button>
        <span className="text-[10px] text-zinc-600">One Claude call (about ₹2–4), saved to your sheet.{!token && <> <a href="/dhan-login" className="underline text-zinc-400">Log in to Dhan</a> first for the candle-level review.</>}</span>
        {err && <span className="w-full text-xs font-bold text-rose-400">{err}</span>}
      </div>
    );
  }

  const g = GRADE[r.grade] ?? GRADE.RAW;
  return (
    <div className="px-6 py-6 border-t border-zinc-800/50 space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={14} className="text-cyan-400" />
        <span className="text-[10px] font-black uppercase tracking-widest text-zinc-500">AI trade review</span>
        <span className={`px-3 py-1 rounded-full border text-[10px] font-black uppercase tracking-widest ${g.tone}`}>{g.label}</span>
        {r.exit && r.exit !== 'UNKNOWN' && <span className="px-3 py-1 rounded-full border border-zinc-700 text-[10px] font-black uppercase tracking-widest text-zinc-300">{EXIT[r.exit] ?? r.exit}</span>}
      </div>
      {r.headline && <p className="text-base font-bold leading-snug text-white">{r.headline}</p>}
      <div className="grid gap-5 md:grid-cols-2">
        <Section icon={<Check size={12} />} title="What went right" items={r.right} tone="text-emerald-400" />
        <Section icon={<X size={12} />} title="What went wrong" items={r.wrong} tone="text-rose-400" />
        <Section icon={<LogOut size={12} />} title={EXIT[r.exit] ?? 'Exit'} items={r.exitPoints} tone="text-amber-400" />
        <Section icon={<ArrowRight size={12} />} title="Next time" items={r.nextTime} tone="text-cyan-400" />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[10px] text-zinc-600">
        <span>{r.at?.slice(0, 16)} · ₹{Number(r.costInr ?? 0).toFixed(2)} · {r.model}</span>
        <button onClick={run} disabled={busy} className="underline decoration-dotted underline-offset-2 text-zinc-500 disabled:opacity-50">
          {busy ? 'Reviewing…' : 'Review again'}
        </button>
        {note && <span className="w-full text-zinc-500">{note}</span>}
        {err && <span className="w-full font-bold text-rose-400">{err}</span>}
      </div>
    </div>
  );
}
