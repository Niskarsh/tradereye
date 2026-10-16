"use client";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { BookModel, Wall } from '@/lib/book/model';

/**
 * Bookmap-style chart of one stock's order book.
 *  - Heatmap: shares waiting at each price over time (dark = normal, glowing = a wall). After a price leaves the
 *    20-level window its last known size stays drawn, faded, until price shows it again.
 *  - Green / red lines: best bid / best ask. Bubbles: trades (green = buyers lifting the ask, red = sellers hitting
 *    the bid). 10-minute candles on the same clock as his chart. Shaded = not recorded.
 *  - Drag to pan; wheel zooms time (Ctrl + wheel: around the pointer); drag / wheel on the price scale zooms price;
 *    double-click = back to live.
 *  - Crosshair with the exact price on the right and time at the bottom.
 *  - Walls listed beside the price scale at their own height; hovering a wall (row or band) shows its Ask button.
 */

const PRICE_W = 66;
const PANEL_W = 236;
const TIME_H = 22;
const SPANS = [{ label: '5m', ms: 5 * 60_000 }, { label: '10m', ms: 10 * 60_000 }, { label: '30m', ms: 30 * 60_000 }, { label: '60m', ms: 60 * 60_000 }, { label: 'Day', ms: 375 * 60_000 }];
const STATUS: Record<string, { text: string; cls: string }> = {
  RESTING: { text: 'resting', cls: 'text-data-neutral border-data-neutral/50' },
  HOLDING: { text: 'holding', cls: 'text-brand-accent border-brand-accent/60' },
  PULLED: { text: 'pulled', cls: 'text-data-caution border-data-caution/60' },
  EATEN: { text: 'eaten', cls: 'text-ink-2 border-line-strong' },
};
const STOPS: [number, [number, number, number]][] = [[0, [22, 34, 47]], [0.35, [111, 62, 24]], [0.6, [232, 135, 58]], [0.82, [223, 177, 91]], [1, [244, 245, 248]]];
function heat(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) if (x <= STOPS[i][0]) {
    const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i], f = (x - a) / (b - a);
    return `rgb(${[0, 1, 2].map((k) => Math.round(ca[k] + (cb[k] - ca[k]) * f)).join(',')})`;
  }
  return 'rgb(244,245,248)';
}
const fmtQ = (q: number) => (q >= 1000 ? `${(q / 1000).toFixed(1)}k` : String(Math.round(q)));
const hhmm = (t: number, sec = false) => new Date(t + 19800_000).toISOString().slice(11, sec ? 19 : 16);
const TIME_STEPS = [10e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3];

interface View { end: number | null; span: number; pLo?: number; pHi?: number }

export function BookChart({ model, live, height = 520, onAsk, compact = false }: {
  model: BookModel; live: boolean; height?: number; onAsk?: (question: string) => void; compact?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ end: null, span: 10 * 60_000 });
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; end: number; pLo: number; pHi: number; axis: boolean } | null>(null);
  const geom = useRef({ W: 0, H: 0, plotW: 0, plotH: 0, t0: 0, t1: 0, pLo: 0, pHi: 1, panel: 0, dataEnd: 0 });
  const [rows, setRows] = useState<{ w: Wall; y: number }[]>([]);
  const [hoverWall, setHoverWall] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const [span, setSpan] = useState(10 * 60_000);
  const [flow, setFlow] = useState<ReturnType<BookModel['flow']> | null>(null);
  const [bias, setBias] = useState<ReturnType<BookModel['bias']> | null>(null);
  const hoverRef = useRef<string | null>(null);
  hoverRef.current = hoverWall;
  // hovering moves between the band and its label: clear only after a short pause, so the Ask button can be reached
  const clearT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hover = (id: string | null) => {
    if (clearT.current) { clearTimeout(clearT.current); clearT.current = null; }
    if (id) setHoverWall(id); else clearT.current = setTimeout(() => setHoverWall(null), 600);
  };

  const draw = useCallback(() => {
    const c = cv.current, box = wrap.current;
    if (!c || !box) return;
    const dpr = window.devicePixelRatio || 1;
    const W = box.clientWidth, H = height;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = `${W}px`; c.style.height = `${H}px`; }
    const g = c.getContext('2d'); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const panel = compact || W < 700 ? 0 : PANEL_W;
    const plotW = W - PRICE_W - panel, plotH = H - TIME_H;
    g.fillStyle = '#0A1118'; g.fillRect(0, 0, W, H);

    const latest = model.lastEventAt || Date.now();
    // the last moment there is data for: nothing is drawn after it (panning into the future shows empty space)
    const dataEnd = live ? Math.max(latest, Date.now()) : latest;
    const v = view.current;
    const t1 = v.end ?? (live ? Math.max(latest, Date.now()) : latest);
    const t0 = t1 - v.span;
    const tick = model.tick / 100;

    // price range: automatic around what traded in view, unless he zoomed / dragged the price scale
    let pLo = v.pLo, pHi = v.pHi;
    if (pLo === undefined || pHi === undefined) {
      let lo = Infinity, hi = -Infinity;
      for (const q of model.quotes) if (q.t >= t0 && q.t <= t1) for (const p of [q.bid, q.ask, q.ltp]) if (p !== undefined) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
      if (!Number.isFinite(lo)) { const ref = model.ltp ?? model.bestBid ?? 0; lo = ref - tick * 10; hi = ref + tick * 10; }
      const pad = Math.max((hi - lo) * 0.35, tick * 12);
      pLo = lo - pad; pHi = hi + pad;
    }
    geom.current = { W, H, plotW, plotH, t0, t1, pLo, pHi, panel, dataEnd };
    const X = (t: number) => ((t - t0) / (t1 - t0)) * plotW;
    const Y = (p: number) => ((pHi! - p) / (pHi! - pLo!)) * plotH;
    const pxTick = plotH / ((pHi - pLo) / tick);
    const rowH = Math.max(1, pxTick * 0.92);

    if (!model.lastEventAt) {
      g.fillStyle = '#7C8899'; g.font = '13px sans-serif';
      g.fillText(live ? 'Waiting for the order book… (needs market hours and the Dhan Data API plan)' : 'Nothing recorded for this stock and day.', 16, plotH / 2);
    }

    // brightness against a wall-sized level (4x the typical level now): normal levels stay dark, walls glow
    // (measured at the last data, never at an empty future moment, which made everything look like a wall)
    const nowQ: number[] = [];
    for (const l of model.levels.values()) if (l.qty > 0 && dataEnd - l.seenAt < 30_000) nowQ.push(l.qty);
    if (!nowQ.length) for (const s of model.segments) if ((s.t1 ?? dataEnd) >= t0 && s.t0 <= t1) nowQ.push(s.qty);
    nowQ.sort((a, b) => a - b);
    const ref = Math.max(1, 4 * (nowQ[Math.floor(nowQ.length / 2)] ?? 1));
    g.save(); g.beginPath(); g.rect(0, 0, plotW, plotH); g.clip();
    for (const s of model.segments) {
      const end = Math.min(s.t1 ?? dataEnd, dataEnd);
      if (end < t0 || s.t0 > t1) continue;
      const p = s.p / 100;
      if (p < pLo || p > pHi) continue;
      const y = Y(p) - rowH / 2;
      const col = heat(Math.pow(Math.min(1, s.qty / ref), 0.8));
      const fadeAt = s.seenTill + 60_000;
      const xa = X(Math.max(s.t0, t0)), xb = X(Math.min(end, t1));
      g.fillStyle = col;
      if (fadeAt >= end) { g.globalAlpha = 1; g.fillRect(xa, y, Math.max(1, xb - xa), rowH); }
      else {
        const xf = X(Math.max(Math.min(fadeAt, t1), t0));
        if (xf > xa) { g.globalAlpha = 1; g.fillRect(xa, y, xf - xa, rowH); }
        g.globalAlpha = 0.32; g.fillRect(Math.max(xa, xf), y, Math.max(1, xb - Math.max(xa, xf)), rowH);
      }
    }
    g.globalAlpha = 1;

    // not recorded
    for (const gp of model.gaps) {
      if (gp.to < t0 || gp.from > t1) continue;
      const xa = X(Math.max(gp.from, t0)), xb = X(Math.min(gp.to, t1));
      g.fillStyle = 'rgba(17,27,38,0.92)'; g.fillRect(xa, 0, xb - xa, plotH);
      if (xb - xa > 90) { g.fillStyle = '#4E5B6B'; g.font = '11px sans-serif'; g.fillText(`not recorded ${hhmm(gp.from)}–${hhmm(gp.to)}`, xa + 8, 16); }
    }

    // 10-minute candles (translucent body + wick)
    for (const k of model.candles(t0, t1)) {
      const xa = X(k.t0 * 1000), xb = X(Math.min(k.t0 * 1000 + 600_000, dataEnd));
      if (xb < 0 || xa > plotW) continue;
      const up = k.c >= k.o, cx = (xa + xb) / 2, bw = Math.max(4, (xb - xa) * 0.6);
      g.strokeStyle = up ? 'rgba(29,201,149,0.9)' : 'rgba(240,107,124,0.9)';
      g.fillStyle = up ? 'rgba(29,201,149,0.16)' : 'rgba(224,63,83,0.16)';
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(cx, Y(k.h)); g.lineTo(cx, Y(k.l)); g.stroke();
      const yb = Math.min(Y(k.o), Y(k.c)), hb = Math.max(2, Math.abs(Y(k.o) - Y(k.c)));
      g.fillRect(cx - bw / 2, yb, bw, hb); g.strokeRect(cx - bw / 2, yb, bw, hb);
      g.strokeStyle = 'rgba(124,136,153,0.18)'; g.lineWidth = 1; g.beginPath(); g.moveTo(xa, 0); g.lineTo(xa, plotH); g.stroke();
    }

    // best bid / ask as step lines
    const stepLine = (pick: 'bid' | 'ask', color: string) => {
      g.strokeStyle = color; g.lineWidth = 1.4; g.beginPath();
      let prev: number | undefined;
      for (const q of model.quotes) {
        if (q.t < t0 - 60_000 || q.t > t1) continue;
        const p = q[pick]; if (p === undefined) continue;
        const x = X(Math.max(q.t, t0));
        if (prev === undefined) g.moveTo(x, Y(p)); else { g.lineTo(x, Y(prev)); g.lineTo(x, Y(p)); }
        prev = p;
      }
      if (prev !== undefined) g.lineTo(X(Math.min(t1, model.lastEventAt || t1)), Y(prev));
      g.stroke();
    };
    stepLine('bid', 'rgba(29,201,149,0.9)');
    stepLine('ask', 'rgba(240,107,124,0.9)');

    // trades: grouped per few pixels so zooming out stays readable
    const bucketMs = Math.max(1000, (t1 - t0) / Math.max(60, plotW / 5));
    const groups = new Map<number, { buy: number; sell: number; price: number; t: number }>();
    for (const tr of model.trades) {
      const t = tr.t * 1000; if (t < t0 || t > t1) continue;
      const k = Math.floor(t / bucketMs);
      const gq = groups.get(k);
      if (gq) { gq.buy += tr.buy; gq.sell += tr.sell; gq.price = tr.price; } else groups.set(k, { buy: tr.buy, sell: tr.sell, price: tr.price, t });
    }
    const vols = [...groups.values()].map((x) => x.buy + x.sell).sort((a, b) => a - b);
    const medV = vols[Math.floor(vols.length / 2)] ?? 1;
    for (const gq of groups.values()) {
      const vol = gq.buy + gq.sell; if (!vol) continue;
      const r = Math.min(18, 1.5 + Math.sqrt(vol / Math.max(medV, 1)) * 2.6);
      const share = gq.buy / vol;
      g.fillStyle = share >= 0.65 ? 'rgba(29,201,149,0.7)' : share <= 0.35 ? 'rgba(224,63,83,0.7)' : 'rgba(223,177,91,0.55)';
      g.beginPath(); g.arc(X(gq.t), Y(gq.price), r, 0, Math.PI * 2); g.fill();
    }

    // walls that ended in view: x = pulled, o = eaten
    for (const w of model.endedWalls(t1, t0)) {
      const x = X(w.endedAt ?? t1), y = Y(w.price);
      g.strokeStyle = w.status === 'PULLED' ? '#E8873A' : '#E8EAF0'; g.lineWidth = 1.5;
      if (w.status === 'PULLED') { g.beginPath(); g.moveTo(x - 4, y - 4); g.lineTo(x + 4, y + 4); g.moveTo(x + 4, y - 4); g.lineTo(x - 4, y + 4); g.stroke(); }
      else { g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.stroke(); }
    }

    // live walls: hovered one gets an outline
    const walls = model.walls(Math.min(t1, dataEnd));
    const hv = hoverRef.current;
    for (const w of walls) {
      if (`${w.side}${w.price}` !== hv) continue;
      g.strokeStyle = '#DFB15B'; g.lineWidth = 1.5; g.setLineDash([4, 3]);
      g.strokeRect(0, Y(w.price) - Math.max(rowH, 6) / 2, plotW, Math.max(rowH, 6)); g.setLineDash([]);
    }
    // past the last data: a "now" line, then empty space (no future data, nothing drawn)
    if (dataEnd < t1 && model.lastEventAt) {
      const xn = X(dataEnd);
      g.strokeStyle = 'rgba(223,177,91,0.6)'; g.setLineDash([2, 4]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(xn, 0); g.lineTo(xn, plotH); g.stroke(); g.setLineDash([]);
      if (plotW - xn > 60) { g.fillStyle = '#4E5B6B'; g.font = '11px sans-serif'; g.fillText(live ? 'now' : 'end of recording', xn + 6, 14); }
    }
    g.restore();

    // price scale
    g.fillStyle = '#111B26'; g.fillRect(plotW, 0, PRICE_W, H);
    const pStep = (() => { const raw = (pHi - pLo) / Math.max(4, plotH / 42); const m = [1, 2, 5, 10, 20, 50, 100, 200, 500].map((x) => x * tick).find((s) => s >= raw); return m ?? raw; })();
    g.font = '10px monospace'; g.fillStyle = '#7C8899';
    for (let p = Math.ceil(pLo / pStep) * pStep; p <= pHi; p += pStep) { g.fillText(p.toFixed(2), plotW + 8, Y(p) + 3); g.fillStyle = 'rgba(36,52,70,0.6)'; g.fillRect(0, Y(p), plotW, 0.5); g.fillStyle = '#7C8899'; }
    if (model.ltp !== undefined && model.ltp >= pLo && model.ltp <= pHi) {
      g.fillStyle = '#DFB15B'; g.fillRect(plotW + 2, Y(model.ltp) - 8, PRICE_W - 4, 16);
      g.fillStyle = '#0A1118'; g.font = 'bold 10px monospace'; g.fillText(model.ltp.toFixed(2), plotW + 8, Y(model.ltp) + 4);
    }

    // time scale
    g.fillStyle = '#111B26'; g.fillRect(0, plotH, plotW + PRICE_W, TIME_H);
    const tStep = TIME_STEPS.find((s) => (s / (t1 - t0)) * plotW >= 70) ?? 3600e3;
    g.font = '10px monospace'; g.fillStyle = '#7C8899';
    for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) {
      const x = X(t); g.fillText(hhmm(t, tStep < 60e3), x - (tStep < 60e3 ? 22 : 14), plotH + 15);
      g.fillStyle = 'rgba(36,52,70,0.5)'; g.fillRect(x, plotH, 0.5, 4); g.fillStyle = '#7C8899';
    }

    // crosshair
    const ms = mouse.current;
    if (ms && ms.x < plotW && ms.y < plotH) {
      const p = pHi - (ms.y / plotH) * (pHi - pLo);
      const ps = Math.round(p / tick) * tick;
      const t = t0 + (ms.x / plotW) * (t1 - t0);
      g.strokeStyle = 'rgba(232,234,240,0.45)'; g.setLineDash([3, 3]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, ms.y); g.lineTo(plotW, ms.y); g.moveTo(ms.x, 0); g.lineTo(ms.x, plotH); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#E8EAF0'; g.fillRect(plotW + 2, ms.y - 8, PRICE_W - 4, 16);
      g.fillStyle = '#0A1118'; g.font = 'bold 10px monospace'; g.fillText(ps.toFixed(2), plotW + 8, ms.y + 4);
      const tl = hhmm(t, true);
      g.fillStyle = '#E8EAF0'; g.fillRect(Math.min(Math.max(0, ms.x - 30), plotW - 60), plotH + 2, 60, 18);
      g.fillStyle = '#0A1118'; g.fillText(tl, Math.min(Math.max(0, ms.x - 30), plotW - 60) + 6, plotH + 15);
      const at = model.sizeAt(ps, t);
      if (at) {
        const text = `${fmtQ(at.qty)} ${at.side === 'ASK' ? 'to sell' : 'to buy'} at ${ps.toFixed(2)}`;
        g.font = '11px sans-serif';
        const tw = g.measureText(text).width + 12;
        const bx = Math.min(ms.x + 12, plotW - tw - 4), by = Math.max(4, ms.y - 26);
        g.fillStyle = 'rgba(5,9,13,0.9)'; g.fillRect(bx, by, tw, 18);
        g.fillStyle = '#E8EAF0'; g.fillText(text, bx + 6, by + 13);
      }
    }

    // wall panel rows (HTML), placed at their price height
    if (panel) {
      const placed: { w: Wall; y: number }[] = [];
      for (const w of walls.filter((x) => x.price >= pLo! && x.price <= pHi!).sort((a, b) => b.price - a.price)) {
        let y = Y(w.price);
        const prev = placed[placed.length - 1];
        if (prev && y - prev.y < 24) y = prev.y + 24;
        placed.push({ w, y: Math.min(plotH - 12, y) });
      }
      setRows((old) => (JSON.stringify(old.map((o) => [o.w.price, o.w.qty, o.w.status, Math.round(o.y)])) === JSON.stringify(placed.map((o) => [o.w.price, o.w.qty, o.w.status, Math.round(o.y)])) ? old : placed));
    } else setRows((old) => (old.length ? [] : old));
    // the bias line: at the right edge of the view (live = now), always shown
    const at = Math.min(t1, dataEnd);
    if (model.lastEventAt) { setFlow(model.flow(at, 600)); setBias((old) => { const b = model.bias(at); return old && old.label === b.label && old.why === b.why ? old : b; }); }
  }, [model, live, height, compact]);

  useEffect(() => { const id = setInterval(draw, 250); draw(); return () => clearInterval(id); }, [draw]);
  useEffect(() => { view.current = { end: null, span: view.current.span }; setFollowing(true); }, [model]);

  /* ---- interactions ---- */
  const local = (e: React.PointerEvent | React.MouseEvent) => { const r = cv.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onMove = (e: React.PointerEvent) => {
    const p = local(e); mouse.current = p;
    const gm = geom.current, d = drag.current;
    if (d) {
      if (d.axis) {
        const f = Math.exp((p.y - d.y) / 150), mid = (d.pLo + d.pHi) / 2, half = ((d.pHi - d.pLo) / 2) * f;
        view.current = { ...view.current, pLo: mid - half, pHi: mid + half };
      } else {
        const dt = ((p.x - d.x) / gm.plotW) * view.current.span;
        const dp = ((p.y - d.y) / gm.plotH) * (d.pHi - d.pLo);
        // never more than ~40% of the screen past the last data
        const maxEnd = gm.dataEnd + view.current.span * 0.4;
        view.current = { ...view.current, end: Math.min(d.end - dt, maxEnd), pLo: d.pLo + dp, pHi: d.pHi + dp };
        setFollowing(false);
      }
    }
    // hover a wall band
    if (p.x < gm.plotW && p.y < gm.plotH && !d) {
      const price = gm.pHi - (p.y / gm.plotH) * (gm.pHi - gm.pLo);
      const tol = Math.max((gm.pHi - gm.pLo) / gm.plotH * 6, model.tick / 100);
      const hit = model.walls(gm.t1).find((w) => Math.abs(w.price - price) <= tol);
      hover(hit ? `${hit.side}${hit.price}` : null);
    }
    draw();
  };
  const onDown = (e: React.PointerEvent) => {
    const p = local(e), gm = geom.current;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: p.x, y: p.y, end: gm.t1, pLo: gm.pLo, pHi: gm.pHi, axis: p.x >= gm.plotW && p.x < gm.plotW + PRICE_W };
  };
  const onUp = () => { drag.current = null; };
  /**
   * Mouse wheel, like his TradingView chart:
   *  - wheel: zoom time (scroll up = zoom in), anchored at the right edge (stays live when following live)
   *  - Ctrl + wheel: zoom time anchored at the vertical line under the mouse pointer
   *  - wheel over the price scale: zoom price around the pointer
   * A native listener (not passive) so the page does not scroll and Ctrl + wheel does not zoom the browser.
   */
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = cv.current!.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top }, gm = geom.current;
    const f = e.deltaY < 0 ? 1 / 1.15 : 1.15; // up = in
    if (p.x >= gm.plotW) {
      const mid = gm.pHi - (p.y / gm.plotH) * (gm.pHi - gm.pLo);
      view.current = { ...view.current, pLo: mid - (mid - gm.pLo) * f, pHi: mid + (gm.pHi - mid) * f };
    } else {
      const span = Math.max(60_000, Math.min(400 * 60_000, view.current.span * f));
      if (e.ctrlKey || e.metaKey) {
        const at = gm.t0 + (Math.max(0, Math.min(p.x, gm.plotW)) / gm.plotW) * (gm.t1 - gm.t0);
        const end = Math.min(at + (gm.t1 - at) * (span / view.current.span), gm.dataEnd + span * 0.4);
        view.current = { ...view.current, span, end };
        setFollowing(false);
      } else {
        // right edge stays where it is (and keeps following live if it was)
        view.current = { ...view.current, span, end: view.current.end === null ? null : Math.min(gm.t1, gm.dataEnd + span * 0.4) };
      }
      setSpan(span);
    }
    draw();
  };
  const wheelRef = useRef(onWheel);
  wheelRef.current = onWheel;
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    c.addEventListener('wheel', h, { passive: false });
    return () => c.removeEventListener('wheel', h);
  }, []);
  const goLive = () => { view.current = { end: null, span: view.current.span }; setFollowing(true); draw(); };
  const setSpanTo = (ms: number) => { view.current = { ...view.current, span: ms, pLo: undefined, pHi: undefined }; setSpan(ms); draw(); };

  const ask = (w: Wall) => onAsk?.(`The ${w.side === 'ASK' ? 'sell' : 'buy'} wall at ${w.price.toFixed(2)} (${fmtQ(w.qty)} shares, ${w.times}x a normal level, there ${w.ageMin} min, ${w.status.toLowerCase()}). What does it mean for my trade, and what should I watch for when price gets there?`);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {bias && (
          <span title={bias.why} className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-black ${bias.side === 'UP' ? 'border-data-green/60 bg-data-green/10 text-data-green' : bias.side === 'DOWN' ? 'border-data-red/60 bg-data-red/10 text-data-red-text' : 'border-line-strong text-ink-2'}`}>
            {bias.side === 'UP' ? '▲' : bias.side === 'DOWN' ? '▼' : '■'} {bias.label}
            <span className="font-normal text-[11px] text-ink-3">· {bias.why}</span>
          </span>
        )}
        {flow && flow.buy + flow.sell > 0 && (
          <span className="text-[11px] text-ink-2">Last 10 min: buyers <b className="text-data-green">{fmtQ(flow.buy)}</b> vs sellers <b className="text-data-red-text">{fmtQ(flow.sell)}</b> · price {flow.moveTicks >= 0 ? '+' : ''}{flow.moveTicks} ticks</span>
        )}
        {flow?.absorption && (
          <span className="rounded-md border border-data-caution/70 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-data-caution">
            {flow.absorption === 'BUYING_ABSORBED' ? 'Buying absorbed: not going up' : 'Selling absorbed: not going down'}
          </span>
        )}
        <span className="ml-auto flex gap-1">
          {SPANS.map((s) => (
            <button key={s.label} onClick={() => setSpanTo(s.ms)} className={`h-7 rounded-md px-2 text-[11px] font-bold ${Math.abs(span - s.ms) < 1000 ? 'bg-brand-accent text-brand-bg' : 'border border-line-strong text-ink-2'}`}>{s.label}</button>
          ))}
          {live && !following && <button onClick={goLive} className="h-7 rounded-md bg-data-green px-2 text-[11px] font-black text-brand-bg">Live ▸</button>}
        </span>
      </div>
      <div ref={wrap} className="relative w-full select-none overflow-hidden rounded-xl" style={{ height, touchAction: 'none' }}>
        <canvas ref={cv} className="block cursor-crosshair"
          onPointerMove={onMove} onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={onUp}
          onPointerLeave={() => { mouse.current = null; hover(null); draw(); }}
          onDoubleClick={() => { view.current = { end: null, span: view.current.span }; setFollowing(true); draw(); }} />
        {rows.map(({ w, y }) => {
          const id = `${w.side}${w.price}`;
          return (
            <div key={id} onMouseEnter={() => hover(id)} onMouseLeave={() => hover(null)}
              className={`absolute flex items-center gap-1.5 rounded-md border bg-brand-bg/90 px-1.5 py-0.5 font-mono text-[10px] ${STATUS[w.status].cls} ${hoverWall === id ? 'ring-1 ring-brand-accent' : ''}`}
              style={{ top: Math.max(0, y - 10), left: geom.current.plotW + PRICE_W + 4, width: PANEL_W - 10 }}>
              <span className="truncate">{w.price.toFixed(2)} · {fmtQ(w.qty)} {w.side === 'ASK' ? 'sell' : 'buy'} · {STATUS[w.status].text}{w.ageMin >= 1 ? ` · ${w.ageMin}m` : ''}</span>
              {onAsk && hoverWall === id && (
                <button onClick={() => ask(w)} className="ml-auto flex h-5 items-center gap-0.5 rounded bg-brand-accent px-1.5 font-sans text-[10px] font-black text-brand-bg">
                  <Sparkles className="h-3 w-3" />Ask
                </button>
              )}
            </div>
          );
        })}
        {/* no side panel (narrow / compact): the hovered wall and its Ask float at the right edge of the chart */}
        {!geom.current.panel && hoverWall && (() => {
          const w = model.walls(geom.current.t1).find((x) => `${x.side}${x.price}` === hoverWall);
          if (!w) return null;
          const y = ((geom.current.pHi - w.price) / (geom.current.pHi - geom.current.pLo)) * geom.current.plotH;
          return (
            <div onMouseEnter={() => hover(hoverWall)} onMouseLeave={() => hover(null)} className={`absolute flex items-center gap-1.5 rounded-md border bg-brand-bg/95 px-1.5 py-0.5 font-mono text-[10px] ${STATUS[w.status].cls}`}
              style={{ top: Math.max(0, y - 10), right: PRICE_W + 6 }}>
              {w.price.toFixed(2)} · {fmtQ(w.qty)} {w.side === 'ASK' ? 'sell' : 'buy'} · {STATUS[w.status].text}
              {onAsk && <button onClick={() => ask(w)} className="flex h-5 items-center gap-0.5 rounded bg-brand-accent px-1.5 font-sans text-[10px] font-black text-brand-bg"><Sparkles className="h-3 w-3" />Ask</button>}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
