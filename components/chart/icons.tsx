/** Small line icons for the drawing toolbar (24 x 24, stroke = currentColor). */
const P: Record<string, string> = {
  cursor: 'M5 3l13 8-6 1.5L9 19z',
  trend: 'M4 19L20 5M4 19a1.5 1.5 0 1 0 0 .01M20 5a1.5 1.5 0 1 0 0 .01',
  ray: 'M4 18L21 6M4 18a1.5 1.5 0 1 0 0 .01',
  extended: 'M2 19L22 5',
  arrow: 'M4 19L19 6M19 6h-7M19 6v7',
  hline: 'M2 12h20M12 12a1.5 1.5 0 1 0 0 .01',
  hray: 'M7 12h15M7 12a1.5 1.5 0 1 0 0 .01',
  vline: 'M12 2v20',
  cross: 'M12 2v20M2 12h20',
  channel: 'M3 15L17 5M7 20L21 10',
  rect: 'M4 6h16v12H4z',
  fib: 'M3 5h18M3 10h18M3 14h18M3 19h18',
  long: 'M4 4h16v8H4zM4 12h16v8H4z M8 8h8',
  short: 'M4 4h16v8H4zM4 12h16v8H4z M8 16h8',
  measure: 'M12 3v18M3 12h18M7 7l-4 5 4 5M17 7l4 5-4 5',
  text: 'M5 5h14M12 5v15M9 20h6',
  brush: 'M4 18c3 0 3-4 6-4s2 4 5 4 3-6 5-8',
  magnet: 'M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4zM6 8h4M14 8h4',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.9 9.9 0 0 0 5.4-1.6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
};

export function ToolIcon({ name, className = 'size-[18px]' }: { name: string; className?: string }) {
  const d = P[name] ?? P.trend;
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
