'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrderLine } from '@/packages/candle-chart/src';
import type { ScalerBook, ScalerWorking } from '@/lib/algoLive/scaler';
import { seriesFor } from '@/lib/chart/series';
import { fetchT } from '@/lib/chart/fetchTimeout';

/**
 * The active chart's stock as a trade: its position and working orders (through trading-scaler, every 5 s in market
 * hours while the page is visible), the order lines the charts draw, and the Flatten / Clear all / Break-even /
 * move / cancel actions. They act at once (no confirmation), on real orders.
 */

const IST_MS = 330 * 60_000;
const tradingHours = (ms = Date.now()) => { const t = new Date(ms + IST_MS); const m = t.getUTCHours() * 60 + t.getUTCMinutes(), wd = t.getUTCDay(); return wd > 0 && wd < 6 && m >= 9 * 60 && m <= 15 * 60 + 40; };
const inr = (v: number) => `${v >= 0 ? '+' : '−'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
const ROLE: Record<ScalerWorking['role'], { label: string; color: string }> = {
  stop: { label: 'SL', color: '#E03F53' }, target: { label: 'TP', color: '#1DC995' }, entry: { label: 'Entry', color: '#E8EAF0' }, limit: { label: 'LMT', color: '#DFB15B' },
};

export function orderLinesOf(book: ScalerBook | null): OrderLine[] {
  if (!book) return [];
  const lines: OrderLine[] = [];
  const p = book.position;
  if (p && p.netQty && p.avgPrice > 0) {
    lines.push({ id: 'pos', price: p.avgPrice, color: p.netQty > 0 ? '#1DC995' : '#F06B7C', label: p.netQty > 0 ? 'Long' : 'Short', qty: Math.abs(p.netQty), extra: inr(p.unrealized + p.realized), cancellable: true });
  }
  for (const w of book.working) lines.push({ id: w.id, price: w.price, color: ROLE[w.role].color, label: `${ROLE[w.role].label}${w.byBot ? ' (algo)' : ''}`, qty: w.qty, draggable: w.role !== 'entry' && w.price > 0, cancellable: true });
  return lines;
}

export function useTrading(symbol: string, token: string) {
  const [book, setBook] = useState<ScalerBook | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState('');
  /** why the order book could not be read (trading-scaler down / not updated): shown as a quiet chip, not a banner */
  const [bookErr, setBookErr] = useState('');
  const [rev, setRev] = useState(0); // bump to redraw the lines (a declined drag snaps back)
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const sid = () => (symbol && symbol !== 'NIFTY500' ? seriesFor(symbol, () => tokenRef.current).securityId : undefined);

  const call = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    const securityId = sid();
    if (!securityId) throw new Error('The stock\'s Dhan id is not known yet: wait for its chart to load.');
    const r = await fetchT('/api/chart/trade', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dhan-token': tokenRef.current }, body: JSON.stringify({ action, securityId, symbol, ...extra }) }, action === 'book' ? 20_000 : 65_000);
    const j = await r.json().catch(() => ({}));
    if (j?.book) setBook(j.book as ScalerBook);
    if (!r.ok) throw new Error(j?.message ?? `HTTP ${r.status}`);
    return j as { book?: ScalerBook; price?: number; done?: string[]; errors?: string[] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  // the book, every 5 s in market hours while visible (30 s after an error: trading-scaler may be down)
  useEffect(() => {
    setBook(null); setMsg(null); setBookErr('');
    if (!token || !symbol || symbol === 'NIFTY500') return;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let wait = 5000;
      if (tradingHours() && !document.hidden && sid()) {
        try { await call('book'); if (alive) setBookErr(''); } catch (e) { wait = 30_000; if (alive) setBookErr((e as Error).message); }
      } else if (!sid()) wait = 1500;
      if (alive) timer = setTimeout(tick, wait);
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, token, call]);

  const run = useCallback(async (label: string, action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action); setMsg(null);
    try {
      const j = await call(action, extra);
      const errs = j.errors ?? [];
      const text = action === 'breakeven' && j.price !== undefined ? `Stop moved to ${j.price.toFixed(2)} (break-even after costs)`
        : action === 'flatten' ? (j.done?.length ? `Closed: ${j.done.join(', ')}` : 'Nothing was closed')
        : `${label}: done`;
      setMsg({ text: errs.length ? `${text} · ${errs.join('; ')}` : text, bad: errs.length > 0 });
    } catch (e) { setMsg({ text: `${label}: ${(e as Error).message}`, bad: true }); setRev((x) => x + 1); }
    finally { setBusy(''); }
  }, [call]);

  const pos = book?.position && book.position.netQty ? book.position : null;
  const stops = book?.working.filter((w) => w.role === 'stop') ?? [];
  // no confirmations (his call): every press acts at once; the result shows in the bar under the strip
  const actions = {
    flatten: () => { if (pos) void run('Flatten', 'flatten'); },
    clearAll: () => { if (book?.working.length) void run('Clear all', 'clearall'); },
    breakEven: () => { if (pos && stops.length) void run('Break-even', 'breakeven'); },
    move: (id: string, price: number) => {
      if (!book?.working.some((x) => x.id === id)) { setRev((x) => x + 1); return; }
      void run('Move', 'move', { id, price });
    },
    cancel: (id: string) => {
      if (id === 'pos') { actions.flatten(); return; }
      if (book?.working.some((x) => x.id === id)) void run('Cancel', 'cancel', { id });
    },
  };
  return { book, lines: orderLinesOf(book), rev, msg, busy, bookErr, hasPosition: !!pos, hasOrders: (book?.working.length ?? 0) > 0, hasStop: stops.length > 0, actions, clearMsg: () => setMsg(null) };
}
