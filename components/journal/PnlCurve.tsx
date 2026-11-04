"use client";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Curve, CurveMode, PnlPosition } from '@/lib/pnlCurve/curve';
import { drawCurve } from '@/lib/pnlCurve/draw';

/** The day's curve on the page: same drawing as the post image, plus a crosshair (hover, or tap on a phone). */
export function PnlCurveChart({ curve, mode, height = 420 }: { curve: Curve; mode: CurveMode; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const hover = useRef<number | undefined>(undefined);
  const draw = useCallback(() => {
    const c = cv.current, b = box.current;
    if (!c || !b) return;
    const dpr = window.devicePixelRatio || 1, W = b.clientWidth;
    c.width = Math.round(W * dpr); c.height = Math.round(height * dpr);
    c.style.width = `${W}px`; c.style.height = `${height}px`;
    const g = c.getContext('2d'); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCurve(g, W, height, curve, mode, { hover: hover.current });
  }, [curve, mode, height]);
  useEffect(() => {
    draw();
    const b = box.current;
    if (!b || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(draw); ro.observe(b);
    return () => ro.disconnect();
  }, [draw]);
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const right = curve.positions.length > 1 ? 118 : 16;
    const x = (e.clientX - r.left - 62) / Math.max(1, r.width - 62 - right);
    hover.current = x < 0 || x > 1 ? undefined : Math.round(x * (curve.times.length - 1));
    draw();
  };
  return (
    <div ref={box} className="w-full overflow-hidden rounded-xl">
      <canvas ref={cv} className="block cursor-crosshair" onPointerMove={onMove} onPointerDown={onMove}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') { hover.current = undefined; draw(); } }} />
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
