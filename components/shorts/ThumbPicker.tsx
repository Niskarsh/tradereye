"use client";
import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

/**
 * Picking the cover frame, like YouTube Studio: scrub through the video, stop where you like, "Use this frame".
 * The frame is captured in the browser as a JPEG (needs the S3 bucket's CORS rule) and saved with its position:
 * YouTube gets the image as the custom thumbnail, Instagram gets it as the Reel cover (or the position, if no image).
 */

interface Thumb { ms: number; image: boolean }
const STEP = 1 / 30;  // one frame at 30 fps
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

export default function ThumbPicker({ id, disabled }: { id: string; disabled?: boolean }) {
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const [preview, setPreview] = useState<string | undefined>();
  const [src, setSrc] = useState('');
  const [open, setOpen] = useState(false);
  const [cors, setCors] = useState(true);      // try loading the video so a frame can be captured; off if S3 refuses
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const v = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    fetch(`/api/shorts/thumb?id=${encodeURIComponent(id)}`, { cache: 'no-store' }).then(async (r) => {
      const j = await r.json(); if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setThumb(j.thumb ?? null); setPreview(j.image); setSrc(j.video);
    }).catch((e) => setMsg((e as Error).message));
  }, [id]);

  const seek = (s: number) => { const el = v.current; if (!el) return; el.pause(); el.currentTime = Math.min(Math.max(0, s), dur || el.duration || 0); };

  const use = async () => {
    const el = v.current; if (!el) return;
    el.pause();
    setBusy(true); setMsg('');
    const ms = el.currentTime * 1000;
    let image: string | undefined;
    try {
      const c = document.createElement('canvas');
      c.width = el.videoWidth; c.height = el.videoHeight;
      c.getContext('2d')!.drawImage(el, 0, 0);
      image = c.toDataURL('image/jpeg', 0.88);   // throws when the video came without CORS
    } catch { image = undefined; }
    try {
      const r = await fetch('/api/shorts/thumb', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ms, image }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setThumb(j.thumb); setPreview(j.image); setOpen(false);
      if (!image) setMsg('Saved the position only: the frame could not be captured (the S3 bucket needs its CORS rule). Instagram will use this frame; YouTube needs the image.');
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-ink-3">Cover frame</span>
        {preview ? <img src={preview} alt="Cover" className="h-24 w-[54px] rounded-md object-cover" /> : null}
        <span className="text-xs text-white">
          {thumb ? `at ${fmt(thumb.ms / 1000)}${thumb.image ? '' : ' (position only)'}` : 'Not picked: YouTube and Instagram choose their own'}
        </span>
        {!open && (
          <button onClick={() => setOpen(true)} disabled={disabled || !src} className="text-xs font-semibold text-brand-accent hover:underline disabled:opacity-40">
            {thumb ? 'Change' : 'Pick a frame'}
          </button>
        )}
      </div>
      {open && src && (
        <div className="mt-3 flex flex-wrap items-start gap-4">
          <video key={cors ? 'cors' : 'plain'} ref={v} src={src} crossOrigin={cors ? 'anonymous' : undefined} muted playsInline preload="auto"
            onError={() => cors && setCors(false)}
            onLoadedMetadata={(e) => { const el = e.currentTarget; setDur(el.duration); if (thumb) el.currentTime = thumb.ms / 1000; }}
            onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onSeeked={(e) => setT(e.currentTarget.currentTime)}
            className="h-96 rounded-lg bg-black" />
          <div className="min-w-56 flex-1 space-y-3">
            <p className="text-xs text-ink-3">Drag to pan through the video, fine-tune frame by frame, then use the frame on screen.</p>
            <input type="range" min={0} max={dur || 0} step={STEP} value={t} onChange={(e) => seek(Number(e.target.value))}
              className="w-full accent-[var(--color-brand-accent)]" aria-label="Position in the video" />
            <div className="flex items-center gap-2 text-sm text-white">
              <button onClick={() => seek(t - STEP)} aria-label="One frame back" className="rounded-full border border-line-strong p-1 hover:border-brand-accent"><ChevronLeft className="size-4" /></button>
              <span className="w-20 text-center tabular-nums">{fmt(t)}</span>
              <button onClick={() => seek(t + STEP)} aria-label="One frame forward" className="rounded-full border border-line-strong p-1 hover:border-brand-accent"><ChevronRight className="size-4" /></button>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={use} disabled={busy || !dur}
                className="inline-flex h-9 items-center gap-2 rounded-full bg-brand-accent px-4 text-sm font-semibold text-brand-bg hover:bg-brand-accent-hover disabled:opacity-40">
                {busy && <Loader2 className="size-4 animate-spin" />}Use this frame
              </button>
              <button onClick={() => setOpen(false)} disabled={busy} className="text-sm text-ink-3 hover:text-white">Cancel</button>
            </div>
            {!cors && <p className="text-[11px] text-data-caution">The video loaded without CORS, so only the position can be saved (see the S3 CORS step).</p>}
          </div>
        </div>
      )}
      {msg && <p className="mt-2 text-xs text-data-caution">{msg}</p>}
      <p className="mt-2 text-[11px] text-ink-4">Applied when you press Schedule / Save changes. YouTube shows custom Short thumbnails only for some channels (see the note if it refuses).</p>
    </div>
  );
}
