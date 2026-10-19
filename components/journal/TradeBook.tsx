"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, ChevronUp, Loader2, Maximize2, Minimize2, Sparkles } from 'lucide-react';
import { BookChart } from '@/components/book/BookChart';
import { tradeMarks, type Fill } from '@/lib/book/marks';
import { useFullscreen } from '@/components/book/useFullscreen';
import { LoadingPanel } from '@/components/ui/progress';
import { loadDay } from '@/lib/book/recorder';
import { dayFolder, istDate } from '@/lib/book/record';
import type { BookModel } from '@/lib/book/model';

/**
 * The order book behind one journal trade (only if that stock was recorded that day in the Order Book tab). Saved
 * recordings need only the Google sign-in, no Dhan token.
 * Opens zoomed on the trade, with his entries, adds and exits marked; same chart as the Order Book tab (drag, wheel
 * zoom, crosshair, walls with Ask, full screen). Loaded only when he presses the button.
 */

const IST = 19800_000;
const hhmm = (slot: string) => `${slot.slice(0, 2)}:${slot.slice(2)}`;

export function TradeBook({ symbol, date, direction, fills, token }: { symbol: string; date: string; direction: string; fills: Fill[]; token: string }) {
  const tokenRef = useRef(token); tokenRef.current = token;
  const api = useCallback((path: string, init: RequestInit = {}) => fetch(path, { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), 'x-dhan-token': tokenRef.current } }), []);
  const sym = symbol.trim().toUpperCase();
  const ok = /^[A-Z0-9&-]{1,30}$/.test(sym) && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const fillsKey = JSON.stringify(fills);
  const marks = useMemo(() => tradeMarks(date, direction, JSON.parse(fillsKey)), [date, direction, fillsKey]);
  const focus = useMemo(() => (marks.length ? { from: marks[0].t, to: marks[marks.length - 1].t } : undefined), [marks]);

  // is there a recording? (one small S3 listing, no data downloaded)
  const [slots, setSlots] = useState<string[] | null | 'error'>(null);
  useEffect(() => {
    if (!ok) return;
    let gone = false;
    setSlots(null);
    api(`/api/book/list?folder=${encodeURIComponent(dayFolder(sym, date))}`)
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!gone) setSlots(r.ok && Array.isArray(j.slots) ? j.slots : 'error'); })
      .catch(() => { if (!gone) setSlots('error'); });
    return () => { gone = true; };
  }, [sym, date, ok, api]);

  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<BookModel | null>(null);
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState('');
  const { ref: card, full, height: fullH, toggle } = useFullscreen<HTMLDivElement>(110);
  const [answer, setAnswer] = useState<{ q: string; text?: string; busy: boolean; err?: string; cost?: number } | null>(null);

  const show = async () => {
    setOpen(true);
    if (model || loading) return;
    setErr(''); setLoading({ done: 0, total: 0 });
    try {
      const m = await loadDay(api, { symbol: sym, securityId: '' }, date, (done, total) => setLoading({ done, total }));
      setModel(m);
    } catch (e) { setErr(`Could not load: ${(e as Error).message}`); }
    finally { setLoading(null); }
  };

  const ask = async (q: string) => {
    setAnswer({ q, busy: true });
    try {
      const at = model?.lastEventAt || Date.now();
      const r = await api('/api/book/ask', { method: 'POST', body: JSON.stringify({ symbol: sym, question: q, book: model?.summary(at), date: date === istDate(Date.now()) ? undefined : date }), headers: { 'Content-Type': 'application/json' } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setAnswer({ q, text: j.text, busy: false, cost: j.costInr });
    } catch (e) { setAnswer({ q, busy: false, err: (e as Error).message }); }
  };

  if (!ok) return null;
  const head = (
    <div className="flex items-center gap-2 mb-3 text-zinc-500">
      <BarChart3 size={14} /><span className="text-[10px] font-black uppercase tracking-widest">Order book</span>
    </div>
  );
  if (slots === null) return <div className="px-6 pb-4">{head}<p className="flex items-center gap-2 text-[11px] text-zinc-600"><Loader2 className="h-3 w-3 animate-spin" />Checking for a recording…</p></div>;
  if (slots === 'error') return <div className="px-6 pb-4">{head}<p className="text-[11px] text-zinc-600">Could not check S3 for a recording of {sym} that day.</p></div>;
  if (!slots.length) return <div className="px-6 pb-4">{head}<p className="text-[11px] text-zinc-600">{sym} was not recorded on {date}. Add it to the Order Book list before you trade it to see the book here.</p></div>;

  const last = slots[slots.length - 1];
  const to = `${String(Math.floor((Number(last.slice(0, 2)) * 60 + Number(last.slice(2)) + 10) / 60)).padStart(2, '0')}:${String((Number(last.slice(2)) + 10) % 60).padStart(2, '0')}`;
  const outside = focus && (focus.to < Date.parse(`${date}T${hhmm(slots[0])}:00Z`) - IST || focus.from > Date.parse(`${date}T${to}:00Z`) - IST);

  return (
    <div className="px-6 pb-6">
      {head}
      {!open ? (
        <button onClick={show} className="flex h-10 items-center gap-2 rounded-full border border-brand-accent/60 px-4 text-[11px] font-black uppercase tracking-widest text-brand-accent hover:bg-brand-accent/10">
          <BarChart3 size={14} />Show order book <span className="font-mono normal-case tracking-normal text-zinc-500">recorded {hhmm(slots[0])}–{to}</span>
        </button>
      ) : (
        <div ref={card} className={`space-y-2 border border-zinc-800/80 bg-brand-card p-3 ${full ? 'overflow-auto rounded-none' : 'rounded-[24px]'}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-black text-white">{sym}</span>
            <span className="text-[11px] text-zinc-500">{date} · recorded {hhmm(slots[0])}–{to} · ▲ buy ▼ sell · dashed = your average entry</span>
            {outside && <span className="text-[11px] text-data-caution">Your trade was outside the recorded time.</span>}
            <button onClick={toggle} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen (Esc)' : 'Full screen'} className="ml-auto rounded-lg border border-zinc-800 p-1.5 text-zinc-500 hover:text-white">
              {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            {!full && <button onClick={() => setOpen(false)} aria-label="Hide order book" className="rounded-lg border border-zinc-800 p-1.5 text-zinc-500 hover:text-white"><ChevronUp className="h-4 w-4" /></button>}
          </div>
          {model ? <BookChart model={model} live={false} height={full ? fullH : 520} onAsk={ask} marks={marks} focus={focus} />
            : loading ? <LoadingPanel height={full ? fullH : 520} value={loading.total ? loading.done / loading.total : undefined}
                label={loading.total ? `Loading from S3 · ${loading.done}/${loading.total} pieces (10 min each)` : 'Finding saved data…'} />
            : null}
          {err && <p className="text-xs text-data-red-text">{err}</p>}
          {answer && (
            <div className="rounded-xl border border-zinc-800 bg-brand-bg p-3 text-sm space-y-1">
              <p className="text-[11px] text-zinc-500"><Sparkles className="mr-1 inline h-3 w-3 text-brand-accent" />{answer.q}</p>
              {answer.busy ? <p className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />Claude is reading…</p>
                : answer.err ? <p className="text-xs text-data-red-text">{answer.err}</p>
                : <p className="leading-relaxed text-zinc-200">{answer.text} <span className="text-[10px] text-zinc-500">₹{answer.cost?.toFixed(2)}</span></p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
