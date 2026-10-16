"use client";
import React from 'react';

/**
 * A loading bar. With `value` (0..1) it fills up; without it a stripe slides (size of the job unknown).
 * `label` is shown above it, e.g. "Loading from S3… 12/31".
 */
export function ProgressBar({ value, label, className = '' }: { value?: number; label?: string; className?: string }) {
  const pct = value === undefined ? undefined : Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={`space-y-1 ${className}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      {label && (
        <div className="flex items-center justify-between text-[11px] text-ink-2">
          <span>{label}</span>
          {pct !== undefined && <span className="font-mono text-ink-3">{pct}%</span>}
        </div>
      )}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
        {pct === undefined
          ? <div className="progress-indet h-full w-1/4 rounded-full bg-brand-accent" />
          : <div className="h-full rounded-full bg-brand-accent transition-[width] duration-200" style={{ width: `${Math.max(3, pct)}%` }} />}
      </div>
    </div>
  );
}

/** The chart area while it loads: same height as the chart, with the bar in the middle (so the page does not jump). */
export function LoadingPanel({ height, value, label }: { height: number; value?: number; label: string }) {
  return (
    <div className="flex w-full items-center justify-center rounded-xl bg-brand-bg" style={{ height }}>
      <ProgressBar value={value} label={label} className="w-full max-w-sm px-6" />
    </div>
  );
}
