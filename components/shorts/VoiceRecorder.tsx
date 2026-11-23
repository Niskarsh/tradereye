"use client";
import React, { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Mic, RotateCcw, Square, X } from 'lucide-react';
import { checkTake, MAX_SPEECH_S, type VoiceResult } from '@/lib/shorts/voice';

/**
 * Records his line for a "My bot's trade" short, checks the take in the browser (lib/shorts/voice.ts: words, length,
 * loudness, distortion, pace, monotone), and asks for a retake until it passes. Emotion is his ear's job: the delivery
 * note says how to say it, and he plays it back. A passing take is uploaded and the render starts.
 */

export interface VoiceText { context: string[]; line: string; delivery: string }
type Phase = 'idle' | 'recording' | 'checking' | 'result' | 'sending';

const MAX_REC_S = 8;
const ANALYSE_SR = 16000;

type Recognition = { lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
const recognitionCtor = (): (new () => Recognition) | undefined => {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

async function decode(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(buf);
    const off = new OfflineAudioContext(1, Math.ceil(audio.duration * ANALYSE_SR), ANALYSE_SR);
    const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
    return (await off.startRendering()).getChannelData(0);
  } finally { void ctx.close(); }
}

export default function VoiceRecorder({ id, label, text, onDone, onDelete }: { id: string; label: string; text?: VoiceText; onDone: () => void; onDelete: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [secs, setSecs] = useState(0);
  const [take, setTake] = useState<{ blob: Blob; url: string; res: VoiceResult; heard: string | null } | null>(null);
  const [takes, setTakes] = useState(0);
  const [err, setErr] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const line = text?.line ?? '';

  useEffect(() => () => { if (take) URL.revokeObjectURL(take.url); }, [take]);

  const start = async () => {
    setErr('');
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { setErr('No microphone access: allow the mic for this site and try again.'); return; }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    // the word check: the browser's own speech recognition (Chrome), run alongside the recording
    const Ctor = recognitionCtor();
    let heard: string | null = Ctor ? '' : null;
    let recDone: Promise<void> = Promise.resolve();
    if (Ctor) {
      const r = new Ctor(); r.lang = 'en-IN'; r.continuous = true; r.interimResults = false;
      recDone = new Promise((res) => { r.onend = () => res(); r.onerror = () => { heard = null; res(); }; });
      r.onresult = (e) => { heard = Array.from(e.results).filter((x) => x.isFinal).map((x) => x[0].transcript).join(' '); };
      try { r.start(); } catch { heard = null; }
      mr.addEventListener('stop', () => { try { r.stop(); } catch { /* already stopped */ } });
    }
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (timer.current) clearInterval(timer.current);
      setPhase('checking');
      const blob = new Blob(chunks, { type: mr.mimeType || type || 'audio/webm' });
      await Promise.race([recDone, new Promise((r) => setTimeout(r, 2500))]);
      try {
        const res = checkTake(await decode(blob), ANALYSE_SR, line, heard);
        setTake((old) => { if (old) URL.revokeObjectURL(old.url); return { blob, url: URL.createObjectURL(blob), res, heard }; });
        setTakes((n) => n + 1);
        setPhase('result');
      } catch (e) { setErr(`Could not read the recording: ${(e as Error).message}`); setPhase('idle'); }
    };
    rec.current = mr; mr.start();
    setSecs(0); setPhase('recording');
    const t0 = Date.now();
    timer.current = setInterval(() => {
      const s = (Date.now() - t0) / 1000; setSecs(s);
      if (s >= MAX_REC_S && mr.state === 'recording') mr.stop();
    }, 100);
  };
  const stop = () => { if (rec.current?.state === 'recording') rec.current.stop(); };

  const send = async (withVoice: boolean) => {
    if (!withVoice && !window.confirm('Render this short without your voice? The line is still shown on screen.')) return;
    setPhase('sending'); setErr('');
    try {
      if (withVoice && take) {
        const up = await fetch(`/api/shorts/voice?id=${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': take.blob.type || 'audio/webm' }, body: take.blob });
        const uj = await up.json().catch(() => ({}));
        if (!up.ok) throw new Error(uj.message ?? `Upload failed (HTTP ${up.status})`);
      }
      const r = await fetch('/api/shorts/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, voice: withVoice && take ? { start: take.res.start, end: take.res.end } : null }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      onDone();
    } catch (e) { setErr((e as Error).message); setPhase(take ? 'result' : 'idle'); }
  };

  const failed = take?.res.checks.filter((c) => !c.ok) ?? [];

  return (
    <div className="col-span-full rounded-2xl border border-brand-accent/60 bg-brand-card p-4">
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold text-white">Record your line · {label}</p>
        <button onClick={onDelete} disabled={phase === 'sending' || phase === 'recording'} className="ml-auto text-xs text-ink-4 hover:text-data-red-text disabled:opacity-40">Delete</button>
      </div>
      {!text ? <p className="mt-2 text-sm text-ink-3">The line for this short is missing: delete it and make it again.</p> : (
        <>
          <div className="mt-3 rounded-xl border border-line bg-brand-bg/50 p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-ink-3">What happened</p>
            {text.context.map((c) => <p key={c} className="mt-1 text-sm text-ink-2">{c}</p>)}
          </div>
          <p className="mt-4 text-[10px] font-black uppercase tracking-widest text-ink-3">Say this</p>
          <p className="mt-1 text-2xl font-black leading-snug text-white sm:text-3xl">&ldquo;{line}&rdquo;</p>
          <p className="mt-2 text-sm text-brand-accent"><b>How:</b> {text.delivery}</p>
          <p className="mt-1 text-xs text-ink-4">Under {MAX_SPEECH_S} seconds. It plays over the opening frame, and the words are shown on screen too.</p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {phase === 'recording' ? (
              <button onClick={stop} className="inline-flex h-12 items-center gap-2 rounded-full bg-data-red px-6 text-sm font-bold text-white">
                <Square className="size-4 fill-current" />Stop · {secs.toFixed(1)} s
              </button>
            ) : (
              <button onClick={start} disabled={phase === 'checking' || phase === 'sending'}
                className="inline-flex h-12 items-center gap-2 rounded-full bg-brand-accent px-6 text-sm font-bold text-brand-bg hover:bg-brand-accent-hover disabled:opacity-40">
                {take ? <RotateCcw className="size-4" /> : <Mic className="size-4" />}{take ? 'Retake' : 'Record'}
              </button>
            )}
            {phase === 'checking' && <span className="flex items-center gap-2 text-sm text-ink-3"><Loader2 className="size-4 animate-spin" />Checking the take…</span>}
            {takes > 0 && phase !== 'recording' && <span className="text-xs text-ink-4">Take {takes}</span>}
          </div>

          {take && phase !== 'recording' && phase !== 'checking' && (
            <div className="mt-4 space-y-3">
              <audio src={take.url} controls className="w-full max-w-md" />
              <ul className="space-y-1">
                {take.res.checks.map((c) => (
                  <li key={c.key} className={`flex items-start gap-2 text-sm ${c.ok ? (c.skipped ? 'text-ink-4' : 'text-data-green') : 'text-data-red-text'}`}>
                    {c.ok ? <Check className="mt-0.5 size-4 shrink-0" /> : <X className="mt-0.5 size-4 shrink-0" />}{c.msg}
                  </li>
                ))}
              </ul>
              {failed.length > 0
                ? <p className="text-sm font-semibold text-white">Fix the red {failed.length === 1 ? 'one' : 'ones'} and retake.</p>
                : <p className="text-sm text-ink-2">The checks pass. Now listen once: does it sound like you telling a friend? If not, retake.</p>}
              <div className="flex flex-wrap items-center gap-3">
                <button onClick={() => send(true)} disabled={!take.res.ok || phase === 'sending'}
                  className="inline-flex h-10 items-center gap-2 rounded-full bg-brand-accent px-5 text-sm font-semibold text-brand-bg hover:bg-brand-accent-hover disabled:opacity-40">
                  {phase === 'sending' && <Loader2 className="size-4 animate-spin" />}Use this take and render
                </button>
              </div>
            </div>
          )}
          <button onClick={() => send(false)} disabled={phase === 'sending' || phase === 'recording'} className="mt-3 text-xs text-ink-3 hover:text-white hover:underline disabled:opacity-40">Render without voice</button>
          {err && <p className="mt-2 text-sm text-data-red-text">{err}</p>}
        </>
      )}
    </div>
  );
}
