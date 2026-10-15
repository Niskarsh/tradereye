"use client";
import React, { forwardRef, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Send } from 'lucide-react';
import type { ChatMsg, CheckResp } from './useCopilot';

const STARTERS_TRADE = ['Why did it say weakening?', 'Where is the nearest real support?', 'Is this move running out of steam?'];
const STARTERS_ENTRY = ['What would make this a better entry?', 'What is the main risk here?', 'Is this momentum or a reversal?'];

/**
 * Chat about the stock on screen, as a card BELOW the facts (scroll up for the data at any time).
 * The conversation lives in the page state, so it survives scrolling, refreshes and re-checks of the same stock.
 */
export const ChatPanel = forwardRef<HTMLTextAreaElement, {
  check: CheckResp; msgs: ChatMsg[]; busy: boolean; fetching: boolean;
  onSend: (q: string) => void; onRefresh: () => void;
}>(function ChatPanel({ check, msgs, busy, fetching, onSend, onRefresh }, inputRef) {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  // follow new answers, but never jump the page on first render
  useEffect(() => { if (first.current) { first.current = false; return; } end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [msgs.length, busy]);
  const ageMin = check.fetchedAt ? Math.floor((Date.now() - check.fetchedAt) / 60_000) : 0;
  const send = (q: string) => { if (!q.trim() || busy) return; onSend(q); setText(''); };
  const starters = check.mode === 'MANAGE' ? STARTERS_TRADE : STARTERS_ENTRY;

  return (
    <div id="copilot-chat" className="rounded-2xl border border-zinc-800 bg-brand-card p-3 space-y-3 scroll-mt-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Chat · {check.symbol}</p>
          <p className={`text-[10px] ${ageMin >= 5 ? 'text-brand-accent' : 'text-zinc-500'}`}>Data from {check.time.slice(0, 5)} · ₹{check.price}{ageMin >= 1 ? ` · ${ageMin} min old` : ''}</p>
        </div>
        <button onClick={onRefresh} disabled={fetching || busy}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-zinc-100 px-3 text-[11px] font-black text-black disabled:opacity-40">
          {fetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Latest Dhan data
        </button>
      </div>

      {msgs.length === 0 && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-500">Ask anything about {check.symbol} or your trade. Short answers, on the same numbers as the card.</p>
          <div className="flex flex-wrap gap-2">
            {starters.map((s) => <button key={s} onClick={() => send(s)} disabled={busy} className="rounded-xl border border-zinc-800 px-3 py-2 text-xs text-zinc-300 text-left">{s}</button>)}
          </div>
        </div>
      )}
      <div className="space-y-2.5">
        {msgs.map((m, i) => m.role === 'note' ? (
          <p key={i} className="text-center text-[10px] font-bold uppercase tracking-widest text-zinc-500">{m.content}</p>
        ) : (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
            <div className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${m.role === 'user' ? 'bg-zinc-100 text-black' : 'bg-black/30 text-zinc-100'}`}>
              {m.content}
              {m.meta && <p className="mt-1.5 text-[10px] text-zinc-500">{m.meta}</p>}
            </div>
          </div>
        ))}
        {busy && <div className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Claude is reading…</div>}
        <div ref={end} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="flex gap-2">
        <textarea ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder="Ask about this stock or your trade…"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text); } }}
          className="flex-1 resize-none rounded-xl bg-brand-bg border border-zinc-800 px-3 py-3 text-sm text-zinc-100 focus:outline-none max-h-32" />
        <button type="submit" disabled={busy || !text.trim()} aria-label="Send"
          className="h-12 w-12 flex items-center justify-center rounded-xl bg-brand-accent text-black disabled:opacity-40">
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
});
