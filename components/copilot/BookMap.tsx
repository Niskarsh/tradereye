"use client";
import React, { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { BookModel, type Wall } from '@/lib/book/model';
import { DEPTH_URL, FEED_URL, parseDepth, parseFeed, subscribeDepth, subscribeQuote } from '@/lib/book/feed';

/**
 * Bookmap-style order book for the stock on screen: resting orders over time as a heatmap (brighter = bigger),
 * the bid/ask line, traded volume as bubbles (green = buyers hitting the ask, red = sellers hitting the bid), and
 * walls tagged on the right with what they are doing. Each tag has an Ask button: Claude explains that level for
 * your trade. Old levels stay drawn (fading) after price leaves the 20-level window, until price shows them again.
 * Streams straight from Dhan in this browser (20-level depth + live quotes); nothing is stored.
 */

// how much time fits across the map (not a candle size); 10-minute candles are drawn on top in every view
const WINDOWS = [{ label: '5m', sec: 300 }, { label: '10m', sec: 600 }, { label: '30m', sec: 1800 }, { label: '60m', sec: 3600 }];
const CANDLE_SEC = 600;
const GUTTER = 168;
const H = 440;
const STATUS: Record<string, { text: string; cls: string }> = {
  RESTING: { text: 'resting', cls: 'border-data-neutral/60 text-data-neutral' },
  HOLDING: { text: 'holding (absorbing)', cls: 'border-brand-accent/70 text-brand-accent' },
  PULLED: { text: 'pulled', cls: 'border-data-caution/70 text-data-caution' },
  EATEN: { text: 'eaten', cls: 'border-zinc-500 text-zinc-300' },
};

// navy -> copper -> gold -> off-white: brighter = more size resting there
const STOPS: [number, [number, number, number]][] = [[0, [22, 34, 47]], [0.35, [111, 62, 24]], [0.6, [232, 135, 58]], [0.82, [223, 177, 91]], [1, [244, 245, 248]]];
function heat(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    if (x <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i], f = (x - a) / (b - a);
      return [0, 1, 2].map((k) => Math.round(ca[k] + (cb[k] - ca[k]) * f)) as [number, number, number];
    }
  }
  return STOPS[STOPS.length - 1][1];
}
const fmtQ = (q: number) => (q >= 1000 ? `${(q / 1000).toFixed(1)}k` : String(Math.round(q)));

export function BookMap({ symbol, securityId, token, clientId, onAskLevel, registerSummary }: {
  symbol: string; securityId?: string; token: string; clientId?: string;
  onAskLevel: (question: string) => void;
  registerSummary: (fn: (() => string) | undefined) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const model = useRef(new BookModel());
  const range = useRef<{ lo: number; hi: number } | null>(null);
  const [win, setWin] = useState(600);
  const [status, setStatus] = useState<'connecting' | 'live' | 'no-data' | 'error'>('connecting');
  const [err, setErr] = useState('');
  const [tags, setTags] = useState<{ w: Wall; y: number }[]>([]);
  const [flow, setFlow] = useState<{ f1: ReturnType<BookModel['flow']>; reach: ReturnType<BookModel['reach']> } | null>(null);
  const lastData = useRef(0);

  // fresh model per stock
  useEffect(() => { model.current = new BookModel(); range.current = null; setTags([]); setFlow(null); }, [securityId]);

  useEffect(() => {
    registerSummary(() => model.current.summary(Date.now()));
    return () => registerSummary(undefined);
  }, [registerSummary, securityId]);

  // the two Dhan streams
  useEffect(() => {
    if (!securityId || !token || !clientId) { setStatus('error'); setErr(!clientId ? 'Log in to Dhan first.' : 'No security id for this stock.'); return; }
    let closed = false;
    const sockets: WebSocket[] = [];
    const qs = `token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}&authType=2`;
    const open = (url: string, sub: string, onMsg: (b: ArrayBuffer) => void, attempt = 0) => {
      if (closed) return;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(sub);
      ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) { lastData.current = Date.now(); onMsg(e.data); } };
      ws.onclose = () => { if (!closed) setTimeout(() => open(url, sub, onMsg, attempt + 1), Math.min(15_000, 1000 * 2 ** attempt)); };
      ws.onerror = () => { setErr('Dhan feed connection failed (retrying).'); };
      sockets.push(ws);
    };
    setStatus('connecting'); setErr('');
    open(`${DEPTH_URL}?${qs}`, subscribeDepth(securityId), (b) => { for (const m of parseDepth(b)) if (m.securityId === securityId) model.current.onDepth(m, Date.now()); });
    open(`${FEED_URL}?version=2&${qs}`, subscribeQuote(securityId), (b) => { for (const q of parseFeed(b)) if (q.securityId === securityId) model.current.onQuote(q, Date.now()); });
    const sec = setInterval(() => {
      const now = Date.now();
      model.current.snapshot(now);
      if (lastData.current) setStatus(now - lastData.current < 15_000 ? 'live' : 'no-data');
    }, 1000);
    const noData = setTimeout(() => { if (!lastData.current) setStatus('no-data'); }, 12_000);
    return () => {
      closed = true; clearInterval(sec); clearTimeout(noData);
      for (const ws of sockets) { try { ws.send(JSON.stringify({ RequestCode: 12 })); } catch { /* closing */ } ws.close(); }
    };
  }, [securityId, token, clientId]);

  // drawing, 4 times a second
  useEffect(() => {
    const id = setInterval(() => {
      const c = canvas.current, b = box.current;
      if (!c || !b) return;
      const m = model.current;
      const dpr = window.devicePixelRatio || 1;
      const Wfull = b.clientWidth;
      if (c.width !== Wfull * dpr) { c.width = Wfull * dpr; c.height = H * dpr; c.style.width = `${Wfull}px`; c.style.height = `${H}px`; }
      const g = c.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#0A1118'; g.fillRect(0, 0, Wfull, H);
      const W = Wfull - GUTTER;
      const nowSec = Math.floor(Date.now() / 1000);
      const cols = m.columns.filter((x) => x.t > nowSec - win);
      const ref = m.ltp ?? m.bestBid ?? m.bestAsk;
      if (!ref || !cols.length) {
        g.fillStyle = '#7C8899'; g.font = '13px sans-serif';
        g.fillText(status === 'no-data' ? 'No live order book (market closed, or the Data API plan is off)' : 'Waiting for the order book…', 16, H / 2);
        return;
      }
      // price range: around the live book, and only widened/moved when price nears an edge (so it does not jump)
      const tick = m.tick / 100;
      const last = cols[cols.length - 1];
      const live = last.cells.filter((x) => x.age < 5000).map((x) => x.p / 100);
      const spanLo = Math.min(ref, ...live), spanHi = Math.max(ref, ...live);
      let r = range.current;
      const pad = Math.max((spanHi - spanLo) * 0.15, tick * 4);
      if (!r || ref < r.lo + (r.hi - r.lo) * 0.12 || ref > r.hi - (r.hi - r.lo) * 0.12 || r.hi - r.lo > (spanHi - spanLo + 2 * pad) * 3) {
        r = { lo: spanLo - pad, hi: spanHi + pad };
        range.current = r;
      }
      const y = (p: number) => ((r!.hi - p) / (r!.hi - r!.lo)) * H;
      const rowH = Math.max(1.5, (H / ((r.hi - r.lo) / tick)) * 0.95);
      const pxPerSec = W / win;

      const sizes = cols.slice(-60).flatMap((x) => x.cells.map((cl) => cl.qty)).sort((a, b) => a - b);
      // brightness against a WALL-sized level (4x the typical level): normal levels stay dark, walls glow
      const med = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 1;
      const norm = (q: number) => Math.pow(Math.min(1, q / Math.max(4 * med, 1)), 0.8);

      // heatmap
      for (const col of cols) {
        const x = W - (nowSec - col.t) * pxPerSec;
        const w = Math.max(1, Math.ceil(pxPerSec));
        for (const cl of col.cells) {
          const p = cl.p / 100;
          if (p < r.lo || p > r.hi) continue;
          const [R, G, B] = heat(norm(cl.qty));
          const fade = cl.age < 60_000 ? 1 : Math.max(0.3, 1 - (cl.age - 60_000) / 900_000);
          g.fillStyle = `rgba(${R},${G},${B},${fade})`;
          g.fillRect(x, y(p) - rowH / 2, w, rowH);
        }
      }
      // bid / ask lines
      const line = (pick: (cl: typeof cols[number]) => number | undefined, color: string) => {
        g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath();
        let started = false;
        for (const col of cols) {
          const v = pick(col); if (v === undefined) continue;
          const x = W - (nowSec - col.t) * pxPerSec;
          if (!started) { g.moveTo(x, y(v)); started = true; } else g.lineTo(x, y(v));
        }
        g.stroke();
      };
      line((cl) => cl.bid, 'rgba(29,201,149,0.9)');
      line((cl) => cl.ask, 'rgba(240,107,124,0.9)');
      // 10-minute candles from the live price (same clock as his 10-minute chart: 09:15, 09:25, ...)
      const day0 = (t: number) => { const d = new Date((t + 19800) * 1000); return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000) - 19800; };
      const buckets = new Map<number, { o: number; h: number; l: number; c: number; t0: number }>();
      for (const col of cols) {
        if (col.ltp === undefined) continue;
        const open915 = day0(col.t) + 9 * 3600 + 15 * 60;
        const start = open915 + Math.floor((col.t - open915) / CANDLE_SEC) * CANDLE_SEC;
        const k = buckets.get(start);
        if (!k) buckets.set(start, { o: col.ltp, h: col.ltp, l: col.ltp, c: col.ltp, t0: start });
        else { k.h = Math.max(k.h, col.ltp); k.l = Math.min(k.l, col.ltp); k.c = col.ltp; }
      }
      for (const k of buckets.values()) {
        const x0 = Math.max(0, W - (nowSec - k.t0) * pxPerSec), x1 = Math.min(W, W - (nowSec - (k.t0 + CANDLE_SEC)) * pxPerSec);
        if (x1 <= 0) continue;
        const up = k.c >= k.o;
        const color = up ? 'rgba(29,201,149,0.95)' : 'rgba(240,107,124,0.95)';
        const bodyW = Math.max(6, (x1 - x0) * 0.55), cx = (x0 + x1) / 2;
        g.strokeStyle = color; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(cx, y(k.h)); g.lineTo(cx, y(k.l)); g.stroke();
        g.strokeRect(cx - bodyW / 2, Math.min(y(k.o), y(k.c)), bodyW, Math.max(1.5, Math.abs(y(k.o) - y(k.c))));
        // candle boundary
        g.strokeStyle = 'rgba(124,136,153,0.25)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(x0, 0); g.lineTo(x0, H); g.stroke();
      }
      // traded volume bubbles
      const vols = cols.map((cl) => cl.buy + cl.sell).filter((v) => v > 0).sort((a, b) => a - b);
      const medV = vols.length ? vols[Math.floor(vols.length / 2)] : 1;
      for (const col of cols) {
        const v = col.buy + col.sell;
        if (!v || col.ltp === undefined) continue;
        const x = W - (nowSec - col.t) * pxPerSec;
        const rad = Math.min(16, 1.5 + Math.sqrt(v / Math.max(medV, 1)) * 2.5);
        const buyShare = col.buy / v;
        g.fillStyle = buyShare >= 0.65 ? 'rgba(29,201,149,0.75)' : buyShare <= 0.35 ? 'rgba(224,63,83,0.75)' : 'rgba(223,177,91,0.6)';
        g.beginPath(); g.arc(x, y(col.ltp), rad, 0, Math.PI * 2); g.fill();
      }
      // right gutter: price scale and the live book as bars
      g.fillStyle = '#111B26'; g.fillRect(W, 0, GUTTER, H);
      const liveCells = last.cells.filter((x) => x.age < 5000);
      const maxQ = Math.max(1, ...liveCells.map((x) => x.qty));
      for (const cl of liveCells) {
        const p = cl.p / 100; if (p < r.lo || p > r.hi) continue;
        g.fillStyle = cl.side === 'BID' ? 'rgba(29,201,149,0.55)' : 'rgba(224,63,83,0.55)';
        g.fillRect(W + 1, y(p) - rowH / 2, (cl.qty / maxQ) * 70, Math.max(1, rowH - 0.5));
      }
      g.fillStyle = '#7C8899'; g.font = '10px monospace';
      const steps = 8;
      for (let i = 0; i <= steps; i++) {
        const p = r.lo + ((r.hi - r.lo) * i) / steps;
        g.fillText(p.toFixed(2), W + 76, y(p) + 3);
      }
      if (m.ltp !== undefined) {
        g.fillStyle = '#DFB15B'; g.fillRect(W + 72, y(m.ltp) - 7, 60, 14);
        g.fillStyle = '#0A1118'; g.font = 'bold 10px monospace'; g.fillText(m.ltp.toFixed(2), W + 76, y(m.ltp) + 3);
      }
      // wall tags (HTML on top, so they can be clicked)
      const now = Date.now();
      const walls = [...m.walls(now), ...m.endedWalls(now).filter((x) => x.seenAgoSec < 300)].filter((x) => x.price >= r!.lo && x.price <= r!.hi);
      const placed: { w: Wall; y: number }[] = [];
      for (const w of walls.sort((a, b) => b.price - a.price)) {
        let yy = y(w.price);
        const prev = placed[placed.length - 1];
        if (prev && yy - prev.y < 22) yy = prev.y + 22; // keep tags from overlapping
        placed.push({ w, y: yy });
      }
      setTags(placed);
      setFlow({ f1: m.flow(now, 60), reach: m.reach(now) });
    }, 250);
    return () => clearInterval(id);
  }, [win, status]);

  const ask = (w: Wall) => onAskLevel(
    `The ${w.side === 'ASK' ? 'sell' : 'buy'} wall at ${w.price.toFixed(2)} (${fmtQ(w.status === 'PULLED' || w.status === 'EATEN' ? w.maxQty : w.qty)}, ${w.times}x a normal level, ${w.status.toLowerCase()}). What does it mean for my trade, and what should I watch for when price gets there?`,
  );

  return (
    <div className="rounded-2xl border border-line bg-brand-card p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-black uppercase tracking-widest text-ink-3">Order book · {symbol}</span>
        <span className={`h-2 w-2 rounded-full ${status === 'live' ? 'bg-data-green' : status === 'connecting' ? 'bg-brand-accent' : 'bg-data-caution'}`} />
        <span className="text-[10px] text-ink-3">{status === 'live' ? 'live' : status === 'connecting' ? 'connecting…' : status === 'no-data' ? 'no data' : err}</span>
        {flow && (flow.f1.buy + flow.f1.sell > 0) && (
          <span className="text-[11px] text-ink-2">
            1 min: buyers <b className="text-data-green">{fmtQ(flow.f1.buy)}</b> vs sellers <b className="text-data-red-text">{fmtQ(flow.f1.sell)}</b> · {flow.f1.moveTicks >= 0 ? '+' : ''}{flow.f1.moveTicks} ticks
          </span>
        )}
        {flow?.f1.absorption && (
          <span className="rounded-md border border-data-caution/70 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-data-caution">
            {flow.f1.absorption === 'BUYING_ABSORBED' ? 'Buying absorbed: not going up' : 'Selling absorbed: not going down'}
          </span>
        )}
        <span className="ml-auto flex gap-1">
          {WINDOWS.map((o) => (
            <button key={o.sec} onClick={() => setWin(o.sec)} className={`h-7 rounded-md px-2 text-[11px] font-bold ${win === o.sec ? 'bg-brand-accent text-brand-bg' : 'border border-line-strong text-ink-2'}`}>{o.label}</button>
          ))}
        </span>
      </div>
      <div ref={box} className="relative w-full overflow-hidden rounded-xl" style={{ height: H }}>
        <canvas ref={canvas} className="block" />
        {tags.map(({ w, y }) => (
          <div key={`${w.side}${w.price}${w.status}`} className="absolute flex items-center gap-1" style={{ top: Math.max(0, Math.min(H - 20, y - 10)), right: GUTTER + 6 }}>
            <span className={`rounded-md border bg-brand-bg/85 px-1.5 py-0.5 font-mono text-[10px] ${STATUS[w.status].cls}`}>
              {w.price.toFixed(2)} · {fmtQ(w.status === 'PULLED' || w.status === 'EATEN' ? w.maxQty : w.qty)} {w.side === 'ASK' ? 'sell' : 'buy'} · {STATUS[w.status].text}{w.ageMin >= 1 ? ` · ${w.ageMin}m` : ''}
            </span>
            <button onClick={() => ask(w)} aria-label={`Ask Claude about ${w.price}`} className="flex h-5 items-center gap-0.5 rounded-md bg-brand-accent px-1.5 text-[10px] font-black text-brand-bg">
              <Sparkles className="h-3 w-3" />Ask
            </button>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-ink-3">
        Brighter = more shares waiting at that price (dark = normal, glowing = a wall). Candles = 10-minute candles since you opened this page. Green / red lines = best bid / ask. Bubbles = trades (green: buyers hitting the ask, red: sellers hitting the bid).
        Faded = last seen outside the 20-level window.{flow?.reach.below !== undefined ? ` 20 levels reach ₹${flow.reach.below} below and ₹${flow.reach.above ?? '?'} above right now.` : ''}
      </p>
    </div>
  );
}
