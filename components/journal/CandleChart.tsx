"use client";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CBar, ProfileRow, Series } from '@/lib/candles/chart';

/**
 * Candlestick chart for the journal (10-minute and daily), with the same handling as the order-book chart:
 *  - drag to pan (time and price); drag on the price scale = zoom price; two fingers = pinch zoom (phone)
 *  - wheel: zoom time from the right edge; Ctrl + wheel: zoom around the pointer; wheel on the price scale: zoom price;
 *    sideways wheel / trackpad swipe: pan
 *  - double-click (or the Trade button): back to the trade; Auto: price scale back to automatic
 *  - crosshair with price and time, and the bar's O/H/L/C/volume (plus the lines) under the pointer
 *  - tap / click a bar: onPick (the daily chart uses it to open that day on the 10-minute chart); on a phone, a tap on
 *    a chart without onPick leaves the crosshair there instead (no hover on touch)
 * The x axis counts bars (like TradingView), so nights, weekends and holidays leave no gaps.
 */

export interface ChartLine { values: Series; color: string; label: string; width?: number }
export interface ChartHLine { price: number; color: string; label: string; dash?: number[]; from?: number; to?: number }
export interface ChartMark { t: number; price: number; side: 'BUY' | 'SELL'; label: string }
export interface ChartFlag { t: number; price: number; color: string; label: string }
export interface Lower { values: Series; label: string; color: string; fmt: (v: number) => string }

const PRICE_W = 62, TIME_H = 22, LOWER_H = 64;
const C = { bg: '#0A1118', axis: '#111B26', text: '#7C8899', grid: 'rgba(36,52,70,0.55)', up: '#1DC995', down: '#F06B7C', white: '#E8EAF0', gold: '#DFB15B', dim: '#4E5B6B' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST = 19800_000;
const hhmm = (ms: number) => new Date(ms + IST).toISOString().slice(11, 16);
const dmy = (ms: number) => { const d = new Date(ms + IST); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const fmtV = (v: number) => (v >= 1e7 ? `${(v / 1e7).toFixed(2)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(2)}L` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v)));

interface View { end: number; count: number; pLo?: number; pHi?: number }

export function CandleChart({ bars, barMs, lines = [], hlines = [], marks = [], flags = [], lower, profile, highlight, focus, height = 420, onPick, pickedDate }: {
  bars: CBar[];
  /** length of one bar: 10 min, or a day */
  barMs: number;
  lines?: ChartLine[]; hlines?: ChartHLine[]; marks?: ChartMark[]; flags?: ChartFlag[];
  /** a small pane under the chart on the same bars (Nifty 500 %) */
  lower?: Lower;
  /** volume profile drawn on the right of one day's bars */
  profile?: { rows: ProfileRow[]; poc?: number; date: string };
  /** shaded time (the trade, or the trade day) */
  highlight?: { from: number; to: number };
  /** bar index range to open on (and come back to) */
  focus: { from: number; to: number };
  height?: number;
  onPick?: (bar: CBar) => void;
  /** a day drawn with a gold outline (the day open on the other chart) */
  pickedDate?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const focusView = useCallback((): View => {
    const n = Math.max(12, focus.to - focus.from + 1);
    return { end: Math.min(bars.length + 2, focus.to + 1 + Math.max(2, Math.round(n * 0.08))), count: Math.round(n * 1.12) + 2 };
  }, [focus.from, focus.to, bars.length]);
  const view = useRef<View>(focusView());
  const geom = useRef({ W: 0, plotW: 0, plotH: 0, mainH: 0, pLo: 0, pHi: 1, start: 0 });
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; end: number; pLo: number; pHi: number; axis: boolean; at: number; moved: boolean } | null>(null);
  const pinch = useRef<{ dist: number; count: number; mid: number } | null>(null);
  const [manualPrice, setManualPrice] = useState(false);
  const focusKey = `${focus.from}-${focus.to}-${bars.length}`;
  useEffect(() => { view.current = focusView(); setManualPrice(false); }, [focusKey, focusView]);

  // time -> fractional bar index (bars are in time order)
  const idxOf = useCallback((ms: number) => {
    let lo = 0, hi = bars.length - 1;
    if (hi < 0) return 0;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bars[m].t <= ms) lo = m; else hi = m - 1; }
    return lo + Math.max(0, Math.min(0.999, (ms - bars[lo].t) / barMs));
  }, [bars, barMs]);

  const draw = useCallback(() => {
    const c = cv.current, box = wrap.current;
    if (!c || !box) return;
    const dpr = window.devicePixelRatio || 1;
    const W = box.clientWidth, H = height;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = `${W}px`; c.style.height = `${H}px`; }
    const g = c.getContext('2d'); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    const plotW = W - PRICE_W, plotH = H - TIME_H - (lower ? LOWER_H : 0), mainH = plotH;
    const v = view.current;
    const start = v.end - v.count;
    const X = (i: number) => ((i + 0.5 - start) / v.count) * plotW;
    const bw = Math.max(1, (plotW / v.count) * 0.68);
    const i0 = Math.max(0, Math.floor(start)), i1 = Math.min(bars.length - 1, Math.ceil(v.end));
    if (!bars.length) { g.fillStyle = C.text; g.font = '13px sans-serif'; g.fillText('No candles for this day.', 16, plotH / 2); return; }

    // price range: the visible candles (and his marks / trade lines in view), unless he moved the price scale
    let pLo = v.pLo, pHi = v.pHi;
    if (pLo === undefined || pHi === undefined) {
      let lo = Infinity, hi = -Infinity;
      for (let i = i0; i <= i1; i++) { lo = Math.min(lo, bars[i].l); hi = Math.max(hi, bars[i].h); }
      for (const m of marks) { const i = idxOf(m.t); if (i >= i0 && i <= i1 + 1) { lo = Math.min(lo, m.price); hi = Math.max(hi, m.price); } }
      for (const h of hlines) if (h.from !== undefined && idxOf(h.from) <= i1 && idxOf(h.to ?? h.from) >= i0) { lo = Math.min(lo, h.price); hi = Math.max(hi, h.price); }
      if (!Number.isFinite(lo)) { lo = bars[bars.length - 1].l; hi = bars[bars.length - 1].h; }
      const pad = Math.max((hi - lo) * 0.08, hi * 0.001);
      pLo = lo - pad; pHi = hi + pad;
    }
    geom.current = { W, plotW, plotH, mainH, pLo, pHi, start };
    const Y = (p: number) => ((pHi! - p) / (pHi! - pLo!)) * mainH;

    g.save(); g.beginPath(); g.rect(0, 0, plotW, plotH); g.clip();
    // grid
    const pStep = (() => { const raw = (pHi - pLo) / Math.max(3, mainH / 46); const p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? raw; })();
    g.fillStyle = C.grid;
    for (let p = Math.ceil(pLo / pStep) * pStep; p <= pHi; p += pStep) g.fillRect(0, Math.round(Y(p)), plotW, 0.5);

    // shaded trade time
    if (highlight) {
      const xa = X(idxOf(highlight.from)) - (plotW / v.count) / 2, xb = X(idxOf(highlight.to)) + (plotW / v.count) / 2;
      g.fillStyle = 'rgba(223,177,91,0.07)'; g.fillRect(xa, 0, Math.max(2, xb - xa), mainH);
    }
    // session breaks (intraday): a faint line at each day's first bar
    if (barMs < 86400_000) {
      g.strokeStyle = 'rgba(124,136,153,0.25)'; g.setLineDash([3, 4]); g.lineWidth = 1;
      for (let i = Math.max(1, i0); i <= i1; i++) if (bars[i].date !== bars[i - 1].date) { const x = X(i) - (plotW / v.count) / 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, mainH); g.stroke(); }
      g.setLineDash([]);
    }

    // volume under the candles (bottom 18%)
    let vMax = 0;
    for (let i = i0; i <= i1; i++) vMax = Math.max(vMax, bars[i].v);
    const vH = mainH * 0.18;
    for (let i = i0; i <= i1; i++) {
      const b = bars[i], h = vMax ? (b.v / vMax) * vH : 0;
      g.fillStyle = b.c >= b.o ? 'rgba(29,201,149,0.28)' : 'rgba(240,107,124,0.28)';
      g.fillRect(X(i) - bw / 2, mainH - h, bw, h);
    }

    // volume profile of one day, on the right edge
    if (profile?.rows.length) {
      const pmax = Math.max(...profile.rows.map((r) => r.v));
      const maxW = Math.min(140, plotW * 0.22);
      for (const r of profile.rows) {
        const y0 = Y(r.hi), y1 = Y(r.lo), w = pmax ? (r.v / pmax) * maxW : 0;
        const isPoc = profile.poc !== undefined && profile.poc >= r.lo && profile.poc <= r.hi;
        g.fillStyle = isPoc ? 'rgba(223,177,91,0.42)' : 'rgba(79,163,224,0.16)';
        g.fillRect(plotW - w, y0 + 0.5, w, Math.max(1, y1 - y0 - 1));
      }
      if (profile.poc !== undefined) {
        const days = bars.map((b, i) => [b, i] as const).filter(([b]) => b.date === profile.date);
        if (days.length) {
          g.strokeStyle = 'rgba(223,177,91,0.7)'; g.lineWidth = 1; g.setLineDash([6, 3]);
          const y = Y(profile.poc); g.beginPath(); g.moveTo(X(days[0][1]) - bw, y); g.lineTo(plotW, y); g.stroke(); g.setLineDash([]);
          g.font = '10px monospace'; g.fillStyle = C.gold; g.fillText(`POC ${profile.poc.toFixed(2)}`, X(days[0][1]) - bw, y - 3);
        }
      }
    }

    // candles
    for (let i = i0; i <= i1; i++) {
      const b = bars[i], x = X(i), up = b.c >= b.o;
      g.strokeStyle = g.fillStyle = up ? C.up : C.down;
      g.fillRect(Math.round(x) - 0.5, Y(b.h), 1, Math.max(1, Y(b.l) - Y(b.h)));
      const yo = Y(b.o), yc = Y(b.c);
      g.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
      if (pickedDate && b.date === pickedDate) { g.strokeStyle = C.gold; g.lineWidth = 1.5; g.strokeRect(x - bw / 2 - 2, Y(b.h) - 3, bw + 4, Y(b.l) - Y(b.h) + 6); }
    }

    // lines (VWAP, EMAs): breaks where the value is missing, and at each new day for session lines
    for (const ln of lines) {
      g.strokeStyle = ln.color; g.lineWidth = ln.width ?? 1.4; g.beginPath();
      let on = false;
      for (let i = Math.max(0, i0 - 1); i <= Math.min(bars.length - 1, i1 + 1); i++) {
        const val = ln.values[i];
        if (val === undefined || (on && i > 0 && ln.label === 'VWAP' && bars[i].date !== bars[i - 1].date)) { on = false; if (val === undefined) continue; }
        const x = X(i), y = Y(val);
        if (!on) { g.moveTo(x, y); on = true; } else g.lineTo(x, y);
      }
      g.stroke();
    }

    // labels never sit on top of each other: each one moves up / down (in 16px steps) until it is free
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const free = (x: number, y: number, w: number, h: number) => !placed.some((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 1 && y + h + 1 > r.y);
    const place = (x: number, y: number, w: number, h: number, dir: 1 | -1) => {
      for (let k = 0; k < 14; k++) {
        for (const s of k ? [dir, -dir] as const : [dir] as const) {
          const yy = Math.max(1, Math.min(mainH - h - 1, y + s * k * 16));
          if (free(x, yy, w, h)) { placed.push({ x, y: yy, w, h }); return yy; }
        }
      }
      placed.push({ x, y, w, h }); return y;
    };

    // trade levels: avg entry, stop, target, 1R (only across the trade)
    g.font = 'bold 10px sans-serif';
    for (const h of hlines) {
      const xa = h.from !== undefined ? X(idxOf(h.from)) - (plotW / v.count) / 2 : 0;
      const xb = h.to !== undefined ? X(idxOf(h.to)) + (plotW / v.count) * 2 : plotW;
      const y = Y(h.price);
      g.strokeStyle = h.color; g.lineWidth = 1.2; g.setLineDash(h.dash ?? []);
      g.beginPath(); g.moveTo(xa, y); g.lineTo(xb, y); g.stroke(); g.setLineDash([]);
      const text = `${h.label} ${h.price.toFixed(2)}`, tw = g.measureText(text).width;
      g.fillStyle = 'rgba(10,17,24,0.85)'; g.fillRect(Math.min(xb + 3, plotW - tw - 6), y - 7, tw + 4, 13);
      placed.push({ x: Math.min(xb + 3, plotW - tw - 6), y: y - 7, w: tw + 4, h: 13 });
      g.fillStyle = h.color; g.fillText(text, Math.min(xb + 5, plotW - tw - 4), y + 3);
    }

    // his orders: arrows (buy below the price pointing up, sell above pointing down) with labels
    const arrows = marks.map((m) => ({ m, x: X(idxOf(m.t)), y: Y(m.price), buy: m.side === 'BUY' }));
    for (const { x, y, buy } of arrows) {
      const tip = buy ? y + 2 : y - 2, base = buy ? y + 15 : y - 15;
      g.fillStyle = buy ? C.up : C.down; g.strokeStyle = C.bg; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, tip); g.lineTo(x - 6, base); g.lineTo(x + 6, base); g.closePath(); g.fill(); g.stroke();
      placed.push({ x: x - 7, y: Math.min(tip, base), w: 14, h: 13 });
    }
    // signals: a diamond at the price
    const diamonds = flags.map((f) => ({ f, x: X(idxOf(f.t)), y: Y(f.price) }));
    for (const { f, x, y } of diamonds) {
      g.fillStyle = f.color; g.strokeStyle = C.bg; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x + 6, y); g.lineTo(x, y + 6); g.lineTo(x - 6, y); g.closePath(); g.fill(); g.stroke();
      placed.push({ x: x - 6, y: y - 6, w: 12, h: 12 });
    }
    g.font = 'bold 10px sans-serif';
    for (const { m, x, y, buy } of arrows) {
      const tw = g.measureText(m.label).width + 10;
      const bx = Math.min(Math.max(2, x - tw / 2), plotW - tw - 2);
      const by = place(bx, buy ? y + 17 : y - 32, tw, 15, buy ? 1 : -1);
      g.strokeStyle = buy ? C.up : C.down; g.lineWidth = 1;
      if (Math.abs(by - (buy ? y + 17 : y - 32)) > 1) { g.beginPath(); g.moveTo(x, buy ? y + 15 : y - 15); g.lineTo(x, by + (buy ? 0 : 15)); g.stroke(); }
      g.fillStyle = buy ? 'rgba(10,40,32,0.95)' : 'rgba(48,14,20,0.95)'; g.fillRect(bx, by, tw, 15);
      g.strokeRect(bx + 0.5, by + 0.5, tw - 1, 14);
      g.fillStyle = C.white; g.fillText(m.label, bx + 5, by + 11);
    }
    for (const { f, x, y } of diamonds) {
      const tw = g.measureText(f.label).width + 8, bx = Math.min(Math.max(2, x + 9), plotW - tw - 2);
      const by = place(bx, y - 7, tw, 15, 1);
      if (Math.abs(by - (y - 7)) > 1) { g.strokeStyle = f.color; g.lineWidth = 1; g.beginPath(); g.moveTo(x + 5, y); g.lineTo(bx, by + 7); g.stroke(); }
      g.fillStyle = 'rgba(10,17,24,0.92)'; g.fillRect(bx, by, tw, 15);
      g.strokeStyle = f.color; g.lineWidth = 1; g.strokeRect(bx + 0.5, by + 0.5, tw - 1, 14);
      g.fillStyle = C.white; g.fillText(f.label, bx + 4, by + 11);
    }
    g.restore();

    // lower pane (Nifty 500 %)
    if (lower) {
      const top = plotH, h = LOWER_H;
      g.fillStyle = '#0D151E'; g.fillRect(0, top, plotW, h);
      g.fillStyle = C.grid; g.fillRect(0, top, plotW + PRICE_W, 1);
      let lo = Infinity, hi = -Infinity;
      for (let i = i0; i <= i1; i++) { const x = lower.values[i]; if (x !== undefined) { lo = Math.min(lo, x); hi = Math.max(hi, x); } }
      if (Number.isFinite(lo)) {
        lo = Math.min(lo, 0); hi = Math.max(hi, 0);
        const pad = Math.max((hi - lo) * 0.15, 0.05); lo -= pad; hi += pad;
        const YL = (x: number) => top + 4 + ((hi - x) / (hi - lo)) * (h - 8);
        g.strokeStyle = 'rgba(124,136,153,0.35)'; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(0, YL(0)); g.lineTo(plotW, YL(0)); g.stroke(); g.setLineDash([]);
        g.save(); g.beginPath(); g.rect(0, top, plotW, h); g.clip();
        g.strokeStyle = lower.color; g.lineWidth = 1.4; g.beginPath();
        let on = false;
        for (let i = Math.max(0, i0 - 1); i <= Math.min(bars.length - 1, i1 + 1); i++) {
          const x = lower.values[i];
          if (x === undefined || (on && bars[i].date !== bars[i - 1].date)) { on = false; if (x === undefined) continue; }
          if (!on) { g.moveTo(X(i), YL(x)); on = true; } else g.lineTo(X(i), YL(x));
        }
        g.stroke(); g.restore();
        g.font = '10px monospace'; g.fillStyle = C.text;
        g.fillText(lower.fmt(hi - pad), plotW + 6, top + 12); g.fillText(lower.fmt(lo + pad), plotW + 6, top + h - 4);
      }
      g.font = '10px sans-serif'; g.fillStyle = C.text; g.fillText(lower.label, 6, top + 12);
    }

    // price scale
    g.fillStyle = C.axis; g.fillRect(plotW, 0, PRICE_W, plotH);
    g.font = '10px monospace'; g.fillStyle = C.text;
    for (let p = Math.ceil(pLo / pStep) * pStep; p <= pHi; p += pStep) g.fillText(p.toFixed(pStep < 1 ? 2 : pStep < 10 ? 1 : 0), plotW + 6, Y(p) + 3);
    const last = bars[Math.min(i1, bars.length - 1)];
    if (last) { const y = Y(last.c); if (y > 0 && y < mainH) { g.fillStyle = last.c >= last.o ? C.up : C.down; g.fillRect(plotW + 1, y - 8, PRICE_W - 2, 16); g.fillStyle = C.bg; g.font = 'bold 10px monospace'; g.fillText(last.c.toFixed(2), plotW + 6, y + 4); } }

    // time scale
    const tTop = H - TIME_H;
    g.fillStyle = C.axis; g.fillRect(0, tTop, W, TIME_H);
    g.font = '10px monospace';
    const daily = barMs >= 86400_000;
    const every = Math.max(1, Math.ceil(70 / (plotW / v.count)));
    const month = (i: number) => new Date(bars[i].t + IST).getUTCMonth();
    const major = (i: number) => (daily ? i === 0 || month(i) !== month(i - 1) : i === 0 || bars[i].date !== bars[i - 1].date);
    const taken: number[] = [];
    for (const pass of [true, false]) {
      for (let i = i0; i <= i1; i++) {
        const isMajor = major(i);
        if (pass !== isMajor || (!isMajor && i % every !== 0)) continue;
        const x = X(i);
        if (x < 0 || x > plotW || taken.some((t) => Math.abs(t - x) < 56)) continue;
        g.fillStyle = isMajor ? C.white : C.text;
        const text = daily ? (isMajor ? MON[month(i)] : dmy(bars[i].t)) : (isMajor ? dmy(bars[i].t) : hhmm(bars[i].t));
        g.fillText(text, Math.max(2, x - g.measureText(text).width / 2), tTop + 15);
        taken.push(x);
      }
    }

    // crosshair + readout of the bar under the pointer
    const ms = mouse.current;
    if (ms && ms.x < plotW && ms.y < plotH) {
      g.strokeStyle = 'rgba(232,234,240,0.35)'; g.setLineDash([3, 3]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, ms.y); g.lineTo(plotW, ms.y); g.moveTo(ms.x, 0); g.lineTo(ms.x, plotH); g.stroke(); g.setLineDash([]);
      if (ms.y < mainH) {
        const p = pHi - (ms.y / mainH) * (pHi - pLo);
        g.fillStyle = C.white; g.fillRect(plotW + 1, ms.y - 8, PRICE_W - 2, 16);
        g.fillStyle = C.bg; g.font = 'bold 10px monospace'; g.fillText(p.toFixed(2), plotW + 6, ms.y + 4);
      }
      const i = Math.round(start + (ms.x / plotW) * v.count - 0.5);
      const b = bars[i];
      if (b) {
        const tl = barMs >= 86400_000 ? dmy(b.t) : `${dmy(b.t)} ${hhmm(b.t)}`;
        g.font = 'bold 10px monospace';
        const tw = g.measureText(tl).width + 10;
        g.fillStyle = C.white; g.fillRect(Math.min(Math.max(0, ms.x - tw / 2), plotW - tw), tTop + 2, tw, 18);
        g.fillStyle = C.bg; g.fillText(tl, Math.min(Math.max(0, ms.x - tw / 2), plotW - tw) + 5, tTop + 15);
        const parts = [`O ${b.o.toFixed(2)}`, `H ${b.h.toFixed(2)}`, `L ${b.l.toFixed(2)}`, `C ${b.c.toFixed(2)}`, `V ${fmtV(b.v)}`];
        for (const ln of lines) { const x = ln.values[i]; if (x !== undefined) parts.push(`${ln.label} ${x.toFixed(2)}`); }
        if (lower) { const x = lower.values[i]; if (x !== undefined) parts.push(`${lower.label.split(' ')[0]} ${lower.fmt(x)}`); }
        g.font = '10px monospace';
        let x0 = 6, y0 = 14;
        g.fillStyle = 'rgba(10,17,24,0.8)'; g.fillRect(0, 0, plotW, parts.join('  ').length * 6.2 > plotW - 12 ? 34 : 20);
        for (const s of parts) {
          const w = g.measureText(s).width + 10;
          if (x0 + w > plotW - 6) { x0 = 6; y0 += 14; }
          g.fillStyle = s.startsWith('C ') ? (b.c >= b.o ? C.up : C.down) : C.white; g.fillText(s, x0, y0); x0 += w;
        }
      }
    }
  }, [bars, barMs, lines, hlines, marks, flags, lower, profile, highlight, height, idxOf, pickedDate]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const box = wrap.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(box);
    return () => ro.disconnect();
  }, [draw]);

  const clampView = (x: View): View => {
    const count = Math.max(8, Math.min(Math.max(30, bars.length * 1.2 + 10), x.count));
    const end = Math.max(Math.min(count, bars.length) * 0.3, Math.min(bars.length + count * 0.4, x.end));
    return { ...x, count, end };
  };
  const local = (e: { clientX: number; clientY: number }) => { const r = cv.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  const onDown = (e: React.PointerEvent) => {
    const p = local(e), gm = geom.current;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.max(10, Math.abs(a.x - b.x)), count: view.current.count, mid: gm.start + (((a.x + b.x) / 2) / gm.plotW) * view.current.count };
      drag.current = null;
      return;
    }
    drag.current = { x: p.x, y: p.y, end: view.current.end, pLo: gm.pLo, pHi: gm.pHi, axis: p.x >= gm.plotW, at: Date.now(), moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const p = local(e), gm = geom.current;
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p);
    mouse.current = e.pointerType === 'mouse' || drag.current ? p : mouse.current;
    const pc = pinch.current;
    if (pc && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const count = pc.count * (pc.dist / Math.max(10, Math.abs(a.x - b.x)));
      const midX = (a.x + b.x) / 2;
      view.current = clampView({ ...view.current, count, end: pc.mid + (1 - midX / gm.plotW) * count });
      draw(); return;
    }
    const d = drag.current;
    if (d) {
      if (Math.abs(p.x - d.x) + Math.abs(p.y - d.y) > 5) d.moved = true;
      if (d.axis) {
        const f = Math.exp((p.y - d.y) / 120), mid = (d.pLo + d.pHi) / 2, half = ((d.pHi - d.pLo) / 2) * f;
        view.current = { ...view.current, pLo: mid - half, pHi: mid + half }; setManualPrice(true);
      } else if (d.moved) {
        const di = ((p.x - d.x) / gm.plotW) * view.current.count;
        const dp = ((p.y - d.y) / gm.mainH) * (d.pHi - d.pLo);
        view.current = clampView({ ...view.current, end: d.end - di, pLo: d.pLo + dp, pHi: d.pHi + dp }); setManualPrice(true);
      }
    }
    draw();
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const tap = d && !d.moved && !d.axis && Date.now() - d.at < 500;
    drag.current = null;
    if (tap && onPick) {
      const gm = geom.current, p = local(e);
      const b = bars[Math.round(gm.start + (p.x / gm.plotW) * view.current.count - 0.5)];
      if (b) onPick(b);
    }
    // on a phone there is no hover: a tap leaves the crosshair (and the bar's values) where the finger was
    if (e.pointerType !== 'mouse') { mouse.current = tap && !onPick ? local(e) : null; draw(); }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e), gm = geom.current, v = view.current;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { // sideways swipe: pan
      view.current = clampView({ ...v, end: v.end + (e.deltaX / gm.plotW) * v.count }); draw(); return;
    }
    const f = e.deltaY < 0 ? 1 / 1.15 : 1.15;
    if (p.x >= gm.plotW) {
      const mid = gm.pHi - (p.y / gm.mainH) * (gm.pHi - gm.pLo);
      view.current = { ...v, pLo: mid - (mid - gm.pLo) * f, pHi: mid + (gm.pHi - mid) * f }; setManualPrice(true);
    } else if (e.ctrlKey || e.metaKey) {
      const at = gm.start + (p.x / gm.plotW) * v.count;
      const count = v.count * f;
      view.current = clampView({ ...v, count, end: at + (v.end - at) * f });
    } else view.current = clampView({ ...v, count: v.count * f });
    draw();
  };
  const wheelRef = useRef(onWheel); wheelRef.current = onWheel;
  useEffect(() => {
    const c = cv.current; if (!c) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    c.addEventListener('wheel', h, { passive: false });
    return () => c.removeEventListener('wheel', h);
  }, []);

  const toFocus = () => { view.current = focusView(); setManualPrice(false); draw(); };
  const zoom = (f: number) => { view.current = clampView({ ...view.current, count: view.current.count * f }); draw(); };
  const btn = 'h-7 min-w-7 rounded-md border border-zinc-800 px-2 text-[11px] font-bold text-zinc-400 hover:text-white';
  return (
    <div className="space-y-1.5">
      <div ref={wrap} className="relative w-full select-none overflow-hidden rounded-xl" style={{ height, touchAction: 'none' }}>
        <canvas ref={cv} className="block cursor-crosshair"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onPointerLeave={(e) => { if (e.pointerType === 'mouse') { mouse.current = null; draw(); } }}
          onDoubleClick={toFocus} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={() => zoom(1 / 1.4)} aria-label="Zoom in" className={btn}>+</button>
        <button onClick={() => zoom(1.4)} aria-label="Zoom out" className={btn}>−</button>
        <button onClick={toFocus} className={`${btn} border-brand-accent/60 text-brand-accent`}>Trade</button>
        {manualPrice && <button onClick={() => { view.current = { ...view.current, pLo: undefined, pHi: undefined }; setManualPrice(false); draw(); }} className={btn}>Auto price</button>}
      </div>
    </div>
  );
}
