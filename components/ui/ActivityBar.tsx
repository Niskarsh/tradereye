"use client";
import { useEffect, useState } from 'react';

/**
 * A thin gold bar along the top of every page while something he started is loading (any button, link or form that
 * calls the server). It appears only if the wait is longer than a quarter second, so quick clicks do not flicker.
 *
 * Background work (the co-pilot's market poll, the order-book saves every 2 minutes) does not show it: a request
 * counts only if it starts within 1.5 s of a click or key press, or while another counted request is still running
 * (so a chain of requests started by one click keeps the bar up until the last one finishes).
 */
const DELAY_MS = 250;
const AFTER_INPUT_MS = 1500;

let installed = false;
let active = 0;
let lastInput = 0;
const listeners = new Set<(n: number) => void>();
const emit = () => { for (const l of listeners) l(active); };

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const mark = () => { lastInput = Date.now(); };
  window.addEventListener('pointerdown', mark, true);
  window.addEventListener('keydown', mark, true);
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const counted = active > 0 || Date.now() - lastInput < AFTER_INPUT_MS;
    if (!counted) return orig(input, init);
    active++; emit();
    return orig(input, init).finally(() => { active--; emit(); });
  };
}

export function ActivityBar() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    install();
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = (n: number) => {
      if (n > 0) { if (!t) t = setTimeout(() => setShow(true), DELAY_MS); }
      else { if (t) clearTimeout(t); t = null; setShow(false); }
    };
    listeners.add(on);
    return () => { listeners.delete(on); if (t) clearTimeout(t); };
  }, []);
  if (!show) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[200] h-0.5 overflow-hidden bg-brand-accent/15" aria-hidden>
      <div className="progress-indet h-full w-1/3 bg-brand-accent" />
    </div>
  );
}
