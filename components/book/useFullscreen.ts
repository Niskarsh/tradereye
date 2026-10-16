"use client";
import { useEffect, useRef, useState } from 'react';

/** Full screen for one card (controls + chart): `full` while it is full screen, `height` = room left for the chart. */
export function useFullscreen<T extends HTMLElement>(reserve = 130) {
  const ref = useRef<T>(null);
  const [full, setFull] = useState(false);
  const [height, setHeight] = useState(700);
  useEffect(() => {
    const sync = () => { const on = document.fullscreenElement === ref.current; setFull(on); if (on) setHeight(Math.max(320, window.innerHeight - reserve)); };
    document.addEventListener('fullscreenchange', sync); window.addEventListener('resize', sync);
    return () => { document.removeEventListener('fullscreenchange', sync); window.removeEventListener('resize', sync); };
  }, [reserve]);
  const toggle = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void ref.current?.requestFullscreen?.(); };
  return { ref, full, height, toggle };
}
