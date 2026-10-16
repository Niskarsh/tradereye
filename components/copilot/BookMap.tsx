"use client";
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { BookModel } from '@/lib/book/model';
import { DEPTH_URL, FEED_URL, parseDepth, parseFeed, subscribeDepth, subscribeQuote } from '@/lib/book/feed';
import { BookChart } from '@/components/book/BookChart';

/**
 * The order book inside the co-pilot. When the Order Book tab is recording this stock, it uses that (no extra
 * Dhan connections) and links there; otherwise it streams the stock itself, just for this page (not saved).
 * Either way the book summary goes to Claude with every Ask and chat question.
 */
const CHANNEL = 'tradereye-orderbook';

export function BookMap({ symbol, securityId, token, clientId, onAskLevel, registerSummary }: {
  symbol: string; securityId?: string; token: string; clientId?: string;
  onAskLevel: (question: string) => void;
  registerSummary: (fn: (() => string) | undefined) => void;
}) {
  const [model, setModel] = useState(() => new BookModel());
  const [remote, setRemote] = useState<{ summary: string; at: number } | null>(null);
  const remoteRef = useRef(remote); remoteRef.current = remote;
  const [err, setErr] = useState('');

  useEffect(() => { setModel(new BookModel()); setRemote(null); }, [securityId]);

  // the Order Book tab, if it is open and recording this stock
  useEffect(() => {
    let ch: BroadcastChannel | null = null;
    try { ch = new BroadcastChannel(CHANNEL); } catch { return; }
    ch.onmessage = (e) => {
      const it = (e.data?.items ?? []).find((x: { securityId: string }) => x.securityId === securityId);
      if (it?.summary) setRemote({ summary: it.summary, at: e.data.at });
    };
    return () => ch?.close();
  }, [securityId]);
  const useRemote = !!remote && Date.now() - remote.at < 20_000;

  useEffect(() => {
    registerSummary(() => (remoteRef.current && Date.now() - remoteRef.current.at < 20_000 ? remoteRef.current.summary : model.summary(Date.now())));
    return () => registerSummary(undefined);
  }, [registerSummary, model]);

  // stream it here only when the Order Book tab is not doing it
  useEffect(() => {
    if (useRemote) return;
    if (!securityId || !token || !clientId) { setErr(!clientId ? 'Log in to Dhan first.' : ''); return; }
    let closed = false;
    const sockets: WebSocket[] = [];
    const qs = `token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}&authType=2`;
    const open = (url: string, sub: string, onMsg: (b: ArrayBuffer) => void, attempt = 0) => {
      if (closed) return;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(sub);
      ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) onMsg(e.data); };
      ws.onclose = () => { if (!closed) setTimeout(() => open(url, sub, onMsg, attempt + 1), Math.min(15_000, 1000 * 2 ** attempt)); };
      ws.onerror = () => setErr('Dhan feed connection dropped (retrying).');
      sockets.push(ws);
    };
    open(`${DEPTH_URL}?${qs}`, subscribeDepth(securityId), (b) => { const t = Date.now(); for (const m of parseDepth(b)) if (m.securityId === securityId) model.onDepth(m, t); });
    open(`${FEED_URL}?version=2&${qs}`, subscribeQuote(securityId), (b) => { const t = Date.now(); for (const q of parseFeed(b)) if (q.securityId === securityId) model.onQuote(q, t); });
    return () => { closed = true; for (const ws of sockets) { try { ws.send(JSON.stringify({ RequestCode: 12 })); } catch { /* closing */ } ws.close(); } };
  }, [securityId, token, clientId, model, useRemote]);

  return (
    <div className="rounded-2xl border border-line bg-brand-card p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-black uppercase tracking-widest text-ink-3">Order book · {symbol}</span>
        <Link href="/order-book" className="ml-auto text-[11px] font-bold text-brand-accent underline decoration-dotted underline-offset-2">Open full Order Book ↗</Link>
      </div>
      {useRemote ? (
        <p className="rounded-xl bg-brand-bg p-3 text-xs text-ink-2">Recording in the Order Book tab. Claude gets that live book with every Ask and chat question here; the full chart is in that tab.</p>
      ) : (
        <>
          {err && <p className="text-[11px] text-data-caution">{err}</p>}
          <BookChart model={model} live height={400} compact onAsk={onAskLevel} />
          <p className="text-[10px] text-ink-3">Not saved: start recording in the Order Book tab to keep this stock&apos;s history.</p>
        </>
      )}
    </div>
  );
}
