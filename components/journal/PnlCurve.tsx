"use client";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Curve, CurveMode, PnlPosition } from '@/lib/pnlCurve/curve';
import { drawCurve, type CurveGeom } from '@/lib/pnlCurve/draw';
import { tradedRange } from '@/lib/pnlCurve/curve';
import { useFullscreen } from '@/components/book/useFullscreen';
import { Maximize2, Minimize2 } from 'lucide-react';

interface View { end: number; count: number; lo?: number; hi?: number }
const MIN_MINUTES = 8;

/**
 * The day's curve on the page: same drawing as the post image, with the same handling as the journal's candle charts.
 * Drag to pan (time and rupees); drag on the rupee scale = zoom it; two fingers = pinch zoom; wheel = zoom time from the
 * right edge; Ctrl + wheel = zoom around the pointer; wheel on the scale = zoom rupees; sideways wheel = pan; double-click
 * or Trade = back to the traded part; Auto = rupee scale back to automatic. Opens on the traded part of the day.
 */
export function PnlCurveChart({ curve, mode, height = 420, toolbar }: { curve: Curve; mode: CurveMode; height?: number; /** shown only in full screen */ toolbar?: React.ReactNode }) {
  const { ref: card, full, height: fullH, toggle } = useFullscreen<HTMLDivElement>(120);
  const h = full ? fullH : height;
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const n = curve.times.length;
  const home = useCallback((): View => { const r = tradedRange(curve); return { end: r.to, count: Math.max(1, r.to - r.from) }; }, [curve]);
  const view = useRef<View>(home());
  const geom = useRef<CurveGeom | undefined>(undefined);
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; end: number; lo: number; hi: number; axis: boolean; moved: boolean } | null>(null);
  const pinch = useRef<{ dist: number; count: number; mid: number } | null>(null);
  const [manual, setManual] = useState(false);

  const draw = useCallback(() => {
    const c = cv.current, b = box.current;
    if (!c || !b) return;
    const dpr = window.devicePixelRatio || 1, W = b.clientWidth;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(h * dpr); c.style.width = `${W}px`; c.style.height = `${h}px`; }
    const g = c.getContext('2d'); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = view.current, from = v.end - v.count, m = mouse.current, last = geom.current;
    let hover: number | undefined;
    if (m && last && m.x >= last.left && m.x <= last.left + last.plotW) hover = Math.round(from + ((m.x - last.left) / last.plotW) * v.count);
    geom.current = drawCurve(g, W, h, curve, mode, { hover, view: { from, to: v.end, lo: v.lo, hi: v.hi } });
  }, [curve, mode, h]);

  const curveKey = `${curve.date}-${n}`;
  useEffect(() => { view.current = home(); setManual(false); }, [curveKey, home]);
  useEffect(() => { view.current = { ...view.current, lo: undefined, hi: undefined }; setManual(false); }, [mode]);
  useEffect(() => {
    draw();
    const b = box.current;
    if (!b || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => draw()); ro.observe(b);
    return () => ro.disconnect();
  }, [draw, curveKey, mode]);

  const clamp = (x: View): View => {
    const most = Math.max(MIN_MINUTES, (n - 1) * 1.1);
    const count = Math.max(MIN_MINUTES, Math.min(most, x.count));
    const end = Math.max(Math.min(count, n - 1) * 0.3, Math.min(n - 1 + count * 0.3, x.end));
    return { ...x, count, end };
  };
  const local = (e: { clientX: number; clientY: number }) => { const r = cv.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onDown = (e: React.PointerEvent) => {
    const p = local(e), gm = geom.current;
    if (!gm) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.max(10, Math.abs(a.x - b.x)), count: view.current.count, mid: gm.from + (((a.x + b.x) / 2 - gm.left) / gm.plotW) * view.current.count };
      drag.current = null;
      return;
    }
    drag.current = { x: p.x, y: p.y, end: view.current.end, lo: gm.lo, hi: gm.hi, axis: p.x < gm.left, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const p = local(e), gm = geom.current;
    if (!gm) return;
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p);
    mouse.current = e.pointerType === 'mouse' || drag.current ? p : mouse.current;
    const pc = pinch.current;
    if (pc && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const count = pc.count * (pc.dist / Math.max(10, Math.abs(a.x - b.x)));
      const midX = ((a.x + b.x) / 2 - gm.left) / gm.plotW;
      view.current = clamp({ ...view.current, count, end: pc.mid + (1 - midX) * count });
      draw(); return;
    }
    const d = drag.current;
    if (d) {
      if (Math.abs(p.x - d.x) + Math.abs(p.y - d.y) > 5) d.moved = true;
      if (d.axis) {
        const f = Math.exp((p.y - d.y) / 120), mid = (d.lo + d.hi) / 2, half = ((d.hi - d.lo) / 2) * f;
        view.current = { ...view.current, lo: mid - half, hi: mid + half }; setManual(true);
      } else if (d.moved) {
        const di = ((p.x - d.x) / gm.plotW) * view.current.count, dv = ((p.y - d.y) / gm.plotH) * (d.hi - d.lo);
        view.current = clamp({ ...view.current, end: d.end - di, lo: d.lo + dv, hi: d.hi + dv }); setManual(true);
      }
    }
    draw();
  };
  const onUp = (e: React.PointerEvent) => {
    const tap = drag.current && !drag.current.moved;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    drag.current = null;
    // on a phone there is no hover: a tap leaves the crosshair where the finger was, a drag clears it
    if (e.pointerType !== 'mouse') { mouse.current = tap ? local(e) : null; draw(); }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e), gm = geom.current, v = view.current;
    if (!gm) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { view.current = clamp({ ...v, end: v.end + (e.deltaX / gm.plotW) * v.count }); draw(); return; }
    const f = e.deltaY < 0 ? 1 / 1.15 : 1.15;
    if (p.x < gm.left) {
      const mid = gm.hi - ((p.y - gm.top) / gm.plotH) * (gm.hi - gm.lo);
      view.current = { ...v, lo: mid - (mid - gm.lo) * f, hi: mid + (gm.hi - mid) * f }; setManual(true);
    } else if (e.ctrlKey || e.metaKey) {
      const at = gm.from + ((p.x - gm.left) / gm.plotW) * v.count, count = v.count * f;
      view.current = clamp({ ...v, count, end: at + (v.end - at) * f });
    } else view.current = clamp({ ...v, count: v.count * f });
    draw();
  };
  const wheelRef = useRef(onWheel); wheelRef.current = onWheel;
  useEffect(() => {
    const c = cv.current; if (!c) return;
    const on = (e: WheelEvent) => wheelRef.current(e);
    c.addEventListener('wheel', on, { passive: false });
    return () => c.removeEventListener('wheel', on);
  }, []);

  const toTrade = () => { view.current = home(); setManual(false); draw(); };
  const zoom = (f: number) => { view.current = clamp({ ...view.current, count: view.current.count * f }); draw(); };
  const btn = 'h-7 min-w-7 rounded-md border border-zinc-800 px-2 text-[11px] font-bold text-zinc-400 hover:text-white';
  return (
    <div ref={card} className={`space-y-1.5 ${full ? 'overflow-auto bg-brand-card p-3' : ''}`}>
      {full && toolbar}
      <div ref={box} className="relative w-full select-none overflow-hidden rounded-xl" style={{ height: h, touchAction: 'none' }}>
        <canvas ref={cv} className="block cursor-crosshair"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onPointerLeave={(e) => { if (e.pointerType === 'mouse') { mouse.current = null; draw(); } }}
          onDoubleClick={toTrade} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={() => zoom(1 / 1.4)} aria-label="Zoom in" className={btn}>+</button>
        <button onClick={() => zoom(1.4)} aria-label="Zoom out" className={btn}>−</button>
        <button onClick={toTrade} className={`${btn} border-brand-accent/60 text-brand-accent`}>Trade</button>
        {manual && <button onClick={() => { view.current = { ...view.current, lo: undefined, hi: undefined }; setManual(false); draw(); }} className={btn}>Auto</button>}
        <button onClick={toggle} aria-label={full ? 'Exit full screen' : 'Full screen'} className={`${btn} ml-auto`}>{full ? <Minimize2 className="mx-auto h-3.5 w-3.5" /> : <Maximize2 className="mx-auto h-3.5 w-3.5" />}</button>
      </div>
    </div>
  );
}

/** Two pills: click one, it lights up and that chart shows. Same shape as the momentum / reversal tags. */
export function ModePills({ mode, onChange }: { mode: CurveMode; onChange: (m: CurveMode) => void }) {
  return (
    <div className="flex items-center gap-2">
      {(['gross', 'net'] as const).map((m) => (
        <button key={m} type="button" onClick={() => onChange(m)} aria-pressed={mode === m}
          className={`rounded-full border px-4 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${mode === m ? 'border-brand-accent bg-brand-accent text-brand-bg' : 'border-zinc-800 bg-zinc-900/40 text-zinc-500 hover:border-zinc-600 hover:text-white'}`}>
          {m}
        </button>
      ))}
    </div>
  );
}

export interface CurveAnswer { curve: Curve; positions: PnlPosition[]; fromS3: boolean; saved: boolean; live: boolean }

/** Asks for the day's curve: S3 when saved, else from candles (Dhan once). One request per change of the fills. */
export function useDayCurve(date: string, positions: PnlPosition[], token: string, enabled: boolean) {
  const [answer, setAnswer] = useState<CurveAnswer | null>(null);
  const [err, setErr] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify(positions);
  const load = useCallback(async () => {
    setBusy(true); setErr(''); setCode('');
    try {
      const r = await fetch('/api/journal/pnl-curve', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dhan-token': token }, body: JSON.stringify({ date, positions: JSON.parse(key) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setAnswer(null); setErr(j.message ?? `HTTP ${r.status}`); setCode(j.error ?? ''); return; }
      setAnswer(j as CurveAnswer);
    } catch (e) { setAnswer(null); setErr((e as Error).message); }
    finally { setBusy(false); }
  }, [date, key, token]);
  useEffect(() => { if (enabled) void load(); else { setAnswer(null); setErr(''); setCode(''); } }, [enabled, load]);
  return { answer, err, code, busy, reload: load };
}
