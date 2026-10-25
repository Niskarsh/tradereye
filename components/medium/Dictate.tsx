"use client";
import React, { useEffect, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';

/**
 * Browser dictation for an answer box (Chrome's speech recognition, Indian English). Each finished phrase is added to
 * the end of the answer; he edits the text after. Hidden where the browser has no speech recognition.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = { lang: string; continuous: boolean; interimResults: boolean; start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null };
const ctor = (): (new () => Rec) | undefined => (typeof window === 'undefined' ? undefined : (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);

export default function Dictate({ onText }: { onText: (text: string) => void }) {
  const [on, setOn] = useState(false);
  const [ok, setOk] = useState(false);
  const rec = useRef<Rec | null>(null);
  const cb = useRef(onText);
  useEffect(() => { cb.current = onText; }, [onText]);
  useEffect(() => { setOk(!!ctor()); return () => rec.current?.stop(); }, []);
  if (!ok) return null;
  const toggle = () => {
    if (on) { rec.current?.stop(); return; }
    const C = ctor()!;
    const r = new C();
    r.lang = 'en-IN'; r.continuous = true; r.interimResults = false;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) cb.current(String(e.results[i][0].transcript).trim());
    };
    r.onend = () => setOn(false);
    r.onerror = () => setOn(false);
    rec.current = r; r.start(); setOn(true);
  };
  return (
    <button type="button" onClick={toggle} title={on ? 'Stop dictation' : 'Dictate (speak your answer)'}
      className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors ${on ? 'border-data-red bg-data-red/15 text-data-red-text' : 'border-line-strong text-ink-2 hover:border-brand-accent hover:text-brand-accent'}`}>
      {on ? <><MicOff className="size-3.5" /> Stop</> : <><Mic className="size-3.5" /> Dictate</>}
    </button>
  );
}
