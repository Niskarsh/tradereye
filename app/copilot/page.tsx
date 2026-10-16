"use client";
import React, { useEffect, useRef, useState } from 'react';
import { Loader2, MessageCircle, Sparkles } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/context/AuthContext';
import { TokenBar } from '@/components/auth/TokenBar';
import { useCopilot, type Dir, type SetupT } from '@/components/copilot/useCopilot';
import { FactsCard, MarketStrip, TodayChecks, VerdictCard } from '@/components/copilot/Cards';
import { ChatPanel } from '@/components/copilot/ChatPanel';

/**
 * Co-pilot: tap direction, setup and a symbol to see the facts (no Claude); press Ask Claude for a read.
 * Claude is only ever called from the Ask button.
 */
export default function CopilotPage() {
  const { token } = useAuth();
  const c = useCopilot(token);
  const [symbol, setSymbol] = useState('');
  const [stop, setStop] = useState('');
  const [suggest, setSuggest] = useState<string[]>([]);
  const [editRisk, setEditRisk] = useState(false);
  const [riskDraft, setRiskDraft] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  // the Chat button opens the chat card below the data and jumps to it; scrolling up shows the data, the thread stays
  const openChat = () => {
    setChatOpen(true);
    setTimeout(() => { document.getElementById('copilot-chat')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); chatInput.current?.focus({ preventScroll: true }); }, 50);
  };
  const stopRef = useRef<HTMLInputElement>(null);

  // orders already placed in Dhan: fill the Stop box (if empty) and follow the order's direction
  useEffect(() => {
    const p = c.check?.pending;
    if (!p || c.check?.mode !== 'ENTRY') return;
    if (p.stop !== undefined) setStop((cur) => (cur ? cur : String(p.stop)));
    if (p.direction && p.direction !== c.direction) c.setDirection(p.direction);
  }, [c.check]); // eslint-disable-line react-hooks/exhaustive-deps
  const picked = useRef('');

  useEffect(() => {
    const q = symbol.trim();
    if (q.length < 2 || q === picked.current) { setSuggest([]); return; } // no list again for a symbol just picked
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/copilot/symbols?q=${encodeURIComponent(q)}`).then((x) => x.json());
        setSuggest((r.symbols ?? []).filter((s: string) => s !== q.toUpperCase()));
      } catch { setSuggest([]); }
    }, 200);
    return () => clearTimeout(t);
  }, [symbol]);

  // picking a symbol (chip or suggestion) only fills it in and moves to the Stop box; Go runs the check
  const pick = (sym: string) => {
    const s = sym.trim().toUpperCase();
    if (!s) return;
    if (s !== symbol) setStop('');
    picked.current = s;
    setSymbol(s); setSuggest([]);
    setTimeout(() => stopRef.current?.focus(), 0);
  };

  const go = (sym: string) => {
    const s = sym.trim().toUpperCase();
    if (!s) return;
    setSymbol(s); setSuggest([]);
    const st = parseFloat(stop);
    c.runCheck(s, Number.isFinite(st) && st > 0 ? st : undefined);
  };
  const ready = !!c.direction && !!c.setup;
  const held = c.check?.mode === 'MANAGE';
  const canAsk = !!c.check && c.busy === '' && (c.market?.asksLeft ?? 1) > 0;
  // after a read, the same button refreshes the data and asks again (repeatable, in a trade or not)
  const onAsk = () => {
    if (!c.check) return;
    const st = parseFloat(stop);
    // first ask: refetch first if the facts on screen are more than a few seconds old
    if (!c.read) { c.askFresh(held ? undefined : Number.isFinite(st) && st > 0 ? st : undefined); return; }
    c.refreshAndAsk(c.check.symbol, held ? undefined : Number.isFinite(st) && st > 0 ? st : undefined);
    c.reload();
  };
  const chips = c.market?.recentSymbols ?? [];

  return (
    <div className="min-h-screen bg-brand-bg text-zinc-100 font-sans pb-36">
      <div className="page-shell pt-6 space-y-4">
        <header className="flex items-end justify-between border-b border-zinc-900 pb-3">
          <div>
            <h1 className="text-2xl font-black tracking-tighter">Co-pilot</h1>
            <p className="text-[9px] font-bold text-brand-text uppercase tracking-[0.2em]">Facts first · Claude only when you ask</p>
          </div>
          {c.market && (
            <div className="text-right text-[10px] text-zinc-500 space-y-1">
              {editRisk ? (
                <form onSubmit={(e) => { e.preventDefault(); const n = parseFloat(riskDraft); if (n > 0) c.saveRisk(n); setEditRisk(false); }} className="flex items-center gap-1 justify-end">
                  <span>Risk ₹</span>
                  <input value={riskDraft} onChange={(e) => setRiskDraft(e.target.value)} inputMode="numeric" autoFocus
                    className="w-16 h-7 rounded-md bg-brand-card border border-zinc-700 px-2 text-xs text-zinc-100 font-mono" />
                  <button type="submit" className="h-7 px-2 rounded-md bg-zinc-100 text-black text-[10px] font-black">Save</button>
                </form>
              ) : (
                <button onClick={() => { setRiskDraft(String(c.market!.riskInr)); setEditRisk(true); }} className="text-zinc-300 underline decoration-dotted underline-offset-2">
                  Risk ₹{c.market.riskInr} per trade
                </button>
              )}
              <p>{c.market.asksLeft} asks left today</p>
            </div>
          )}
        </header>

        {!token && <TokenBar />}

        <div className="space-y-4 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-6 lg:space-y-0 lg:items-start">
        <div className="space-y-4">
        <MarketStrip m={c.market} err={c.marketErr} onRefresh={c.reload} />

        <div className="grid grid-cols-2 gap-2">
          {(['LONG', 'SHORT'] as Dir[]).map((d) => (
            <button key={d} onClick={() => c.setDirection(d)}
              className={`h-16 rounded-2xl text-lg font-black tracking-tight border-2 ${c.direction === d ? (d === 'LONG' ? 'bg-data-green text-black border-data-green' : 'bg-data-red text-white border-data-red') : 'border-zinc-800 text-zinc-300'}`}>
              {d}
            </button>
          ))}
          {(['MOMENTUM', 'REVERSAL'] as SetupT[]).map((s) => (
            <button key={s} onClick={() => c.setSetup(s)}
              className={`h-14 rounded-2xl text-sm font-black tracking-wider border-2 ${c.setup === s ? 'bg-brand-accent text-black border-brand-accent' : 'border-zinc-800 text-zinc-300'}`}>
              {s}
            </button>
          ))}
        </div>

        {chips.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {chips.map((s) => (
              <button key={s} onClick={() => pick(s)} disabled={c.busy !== ''}
                className={`h-10 px-4 rounded-xl text-sm font-bold border ${c.market?.openSymbols.includes(s) ? 'border-brand-accent text-brand-accent' : 'border-zinc-700 text-zinc-200'} disabled:opacity-40`}>
                {s}{c.market?.openSymbols.includes(s) ? ' ●' : ''}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); go(symbol); }} className="space-y-2">
          <div className="flex gap-2">
            <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="Symbol"
              autoCapitalize="characters" autoCorrect="off" spellCheck={false}
              className="h-12 flex-1 bg-brand-card border-zinc-800 text-base font-bold tracking-wide" />
            <Input ref={stopRef} value={stop} onChange={(e) => setStop(e.target.value)} placeholder="Stop" inputMode="decimal"
              className="h-12 w-28 bg-brand-card border-zinc-800 text-base font-mono" />
            <button type="submit" disabled={!ready || !symbol || c.busy !== ''}
              className="h-12 px-5 rounded-xl bg-zinc-100 text-black text-sm font-black disabled:opacity-40">
              {c.busy === 'check' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Go'}
            </button>
          </div>
          {suggest.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {suggest.map((s) => <button type="button" key={s} onClick={() => pick(s)} className="h-9 px-3 rounded-lg bg-brand-card text-xs font-bold text-zinc-300 disabled:opacity-40">{s}</button>)}
            </div>
          )}
          {!ready && <p className="text-[11px] text-zinc-500">Pick a direction and a setup first.</p>}
        </form>

        {c.error && <div className="rounded-2xl border border-data-red/40 bg-data-red/10 p-3 text-xs font-bold text-data-red">{c.error}</div>}
        </div>

        <div className="space-y-4">

        {c.read && <VerdictCard r={c.read} decision={c.decision} onDecide={c.decide} showDecision={!held}
          onTryAlt={(a) => { c.setDirection(a.direction); c.setSetup(a.setup); setStop(a.stop !== undefined ? String(a.stop) : ''); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />}
        {c.check && <FactsCard c={c.check} refreshing={c.busy !== ''}
          onRefresh={() => { const st = parseFloat(stop); c.runCheck(c.check!.symbol, Number.isFinite(st) && st > 0 ? st : undefined); c.reload(); }}
          onUseStop={held ? undefined : (st) => { setStop(String(st)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
          onTryAlt={(a) => { c.setDirection(a.direction); c.setSetup(a.setup); setStop(a.stop !== undefined ? String(a.stop) : ''); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />}

        {c.check && (chatOpen || c.chat.length > 0) && (
          <ChatPanel ref={chatInput} check={c.check} msgs={c.chat} busy={c.chatBusy} fetching={c.busy === 'check'} onSend={c.sendChat}
            onRefresh={() => { const st = parseFloat(stop); c.refreshForChat(held ? undefined : Number.isFinite(st) && st > 0 ? st : undefined); }} />
        )}
        </div>
        </div>

        <TodayChecks m={c.market} />
      </div>

      {c.check && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-900 bg-brand-bg/95 p-3 backdrop-blur">
          <div className="page-shell flex gap-2">
            <button onClick={openChat} disabled={c.busy === 'check'} aria-label="Chat with Claude"
              className="flex h-14 w-16 shrink-0 flex-col items-center justify-center rounded-2xl border-2 border-brand-accent text-brand-accent text-[9px] font-black uppercase disabled:opacity-40">
              <MessageCircle className="w-5 h-5" />Chat
            </button>
            <button onClick={onAsk} disabled={!canAsk}
              className="flex h-14 flex-1 items-center justify-center gap-2 rounded-2xl bg-brand-accent text-black text-base font-black uppercase tracking-tight disabled:opacity-40">
              {c.busy !== '' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
              {c.busy === 'check' ? 'Fetching fresh data…' : c.read ? (held ? '↻ Re-check my trade again' : '↻ Refresh & ask again') : held ? 'Re-check my trade' : 'Ask Claude'}
            </button>
          </div>
          {c.market && !c.market.hasApiKey && <p className="mt-1 text-center text-[10px] text-data-red">ANTHROPIC_API_KEY is not set in Vercel yet.</p>}
        </div>
      )}

    </div>
  );
}
