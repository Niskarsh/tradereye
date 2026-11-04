import { extremes, tradedRange, type Curve, type CurveMode } from './curve';

/**
 * Draws the P&L curve on any canvas: the journal's live chart and the post / Story images use this same code, so what
 * goes out is what the journal shows. Overall line: thick, green above zero, red below (like Dhan). With more than one
 * position each gets a thin labelled line, so you can see which one moved the total.
 */

export const CURVE_COLORS = { bg: '#0A1118', grid: 'rgba(36,52,70,0.6)', text: '#7C8899', white: '#E8EAF0', up: '#1DC995', down: '#F06B7C', gold: '#DFB15B' };
const POSITION_COLORS = ['#DFB15B', '#E8EAF0', '#E8873A', '#B9A77C', '#8FB5A8', '#D9A7A0', '#A9B4C2', '#C98F4E'];
const IST = 19800_000;
export const hhmm = (ms: number) => new Date(ms + IST).toISOString().slice(11, 16);

export function inr(n: number, signed = true): string {
  const v = Math.round(Math.abs(n));
  const sign = n < 0 && v !== 0 ? '-' : signed && v !== 0 ? '+' : '';
  return `${sign}₹${v.toLocaleString('en-IN')}`;
}

function niceStep(range: number, ticks: number): number {
  const raw = Math.max(range, 1) / Math.max(1, ticks);
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? 10 * p;
}

export interface DrawOptions {
  /** multiplies fonts and line widths (the images are drawn larger than the page's chart) */
  scale?: number;
  /** minute under the pointer: crosshair and the values at that minute */
  hover?: number;
  /** minutes shown (fractional indexes into curve.times) and, once moved by hand, the rupee scale. Default: the traded part. */
  view?: { from: number; to: number; lo?: number; hi?: number };
}

/** Where things landed, so the page can turn a pointer position into a minute or a rupee value. */
export interface CurveGeom { left: number; top: number; plotW: number; plotH: number; from: number; to: number; lo: number; hi: number }

export function drawCurve(g: CanvasRenderingContext2D, W: number, H: number, curve: Curve, mode: CurveMode, o: DrawOptions = {}): CurveGeom | undefined {
  const s = o.scale ?? 1;
  const font = (px: number, weight = '') => `${weight} ${px * s}px Inter, system-ui, -apple-system, 'Segoe UI', sans-serif`.trim();
  g.fillStyle = CURVE_COLORS.bg; g.fillRect(0, 0, W, H);
  const n = curve.times.length;
  const overall = curve.overall[mode];
  const showPositions = curve.positions.length > 1;
  const left = 62 * s, right = (showPositions ? 118 : 16) * s, top = 26 * s, bottom = 26 * s;
  const plotW = W - left - right, plotH = H - top - bottom;
  if (n === 0 || plotW <= 0 || plotH <= 0) return undefined;
  const range = o.view ?? tradedRange(curve);
  const from = range.from, to = Math.max(range.to, from + 1);
  const i0 = Math.max(0, Math.floor(from)), i1 = Math.min(n - 1, Math.ceil(to));

  const seen = (v: number[]) => v.slice(i0, i1 + 1);
  const all = [...seen(overall), ...(showPositions ? curve.positions.flatMap((p) => seen(p[mode])) : [])];
  let lo = o.view?.lo ?? Math.min(...all, Infinity), hi = o.view?.hi ?? Math.max(...all, -Infinity);
  if (o.view?.lo === undefined || o.view?.hi === undefined) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 0; }
    const pad = Math.max((hi - lo) * 0.12, 10);
    lo -= pad; hi += pad;
  }
  const X = (i: number) => left + ((i - from) / (to - from)) * plotW;
  const Y = (v: number) => top + ((hi - v) / (hi - lo)) * plotH;

  // grid and scale
  g.font = font(11); g.textBaseline = 'middle'; g.textAlign = 'right';
  const step = niceStep(hi - lo, plotH / (46 * s));
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    g.fillStyle = CURVE_COLORS.grid; g.fillRect(left, Math.round(Y(v)), plotW, Math.max(1, s * 0.6));
    g.fillStyle = CURVE_COLORS.text; g.fillText(inr(v, false), left - 7 * s, Y(v));
  }
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  // a round step for the minutes in view, on clock times
  const room = Math.max(1, plotW / (s * 62));
  const every = [5, 10, 15, 30, 60, 120, 240].find((m) => (to - from) / m <= room) ?? 240;
  for (let i = i0; i <= i1; i++) {
    const m = Math.round((curve.times[i] + IST) / 60_000) % 1440;
    if (m % every !== 0) continue;
    g.fillStyle = CURVE_COLORS.grid; g.fillRect(Math.round(X(i)), top, Math.max(1, s * 0.6), plotH);
    g.fillStyle = CURVE_COLORS.text; g.fillText(hhmm(curve.times[i]), Math.max(left + 16 * s, Math.min(X(i), left + plotW - 16 * s)), H - 8 * s);
  }
  // zero line
  if (lo <= 0 && hi >= 0) {
    g.strokeStyle = CURVE_COLORS.text; g.lineWidth = Math.max(1, s); g.setLineDash([4 * s, 4 * s]);
    g.beginPath(); g.moveTo(left, Y(0)); g.lineTo(left + plotW, Y(0)); g.stroke(); g.setLineDash([]);
  }

  const path = (vals: number[]) => { g.beginPath(); for (let i = i0; i <= i1; i++) { if (i === i0) g.moveTo(X(i), Y(vals[i])); else g.lineTo(X(i), Y(vals[i])); } };

  // everything on the lines stays inside the plot when zoomed or dragged
  g.save(); g.beginPath(); g.rect(left, top, plotW, plotH); g.clip();

  // position lines, under the overall line
  g.lineJoin = 'round';
  if (showPositions) curve.positions.forEach((p, k) => {
    g.strokeStyle = POSITION_COLORS[k % POSITION_COLORS.length]; g.lineWidth = 1.4 * s; g.globalAlpha = 0.85;
    path(p[mode]); g.stroke(); g.globalAlpha = 1;
  });

  // overall: soft fill to zero and the line itself, each coloured by its side of zero
  const zero = Math.max(top, Math.min(top + plotH, Y(0)));
  for (const [color, y0, h] of [[CURVE_COLORS.up, top, zero - top], [CURVE_COLORS.down, zero, top + plotH - zero]] as [string, number, number][]) {
    if (h <= 0) continue;
    g.save(); g.beginPath(); g.rect(left, y0, plotW, h); g.clip();
    path(overall); g.lineTo(X(i1), Y(0)); g.lineTo(X(i0), Y(0)); g.closePath();
    g.fillStyle = color; g.globalAlpha = 0.12; g.fill(); g.globalAlpha = 1;
    path(overall); g.strokeStyle = color; g.lineWidth = 2.6 * s; g.stroke();
    g.restore();
  }
  g.restore();

  // the day's high and low, with their times
  const ex = extremes(overall, curve.times);
  if (ex && ex.high.value !== ex.low.value) {
    for (const [e, color, above] of [[ex.high, CURVE_COLORS.up, true], [ex.low, CURVE_COLORS.down, false]] as const) {
      const i = curve.times.indexOf(e.t), x = X(i), y = Y(e.value);
      if (i < from || i > to || y < top || y > top + plotH) continue;
      g.fillStyle = color; g.beginPath(); g.arc(x, y, 3.6 * s, 0, Math.PI * 2); g.fill();
      const label = `${above ? 'High' : 'Low'} ${inr(e.value)} · ${hhmm(e.t)}`;
      g.font = font(11, '700');
      const w = g.measureText(label).width;
      const lx = Math.max(left + 2 * s, Math.min(x - w / 2, left + plotW - w - 2 * s));
      g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = color;
      g.fillText(label, lx, above ? Math.max(top - 8 * s, y - 9 * s) : Math.min(top + plotH + 16 * s, y + 18 * s));
    }
  }

  // labels at the end of each position line, moved apart so they never sit on each other
  if (showPositions) {
    const rows = curve.positions.map((p, k) => ({ y: Math.max(top + 10 * s, Math.min(top + plotH - 14 * s, Y(p[mode][i1]))), sym: p.symbol, val: p[mode][i1], color: POSITION_COLORS[k % POSITION_COLORS.length] })).sort((a, b) => a.y - b.y);
    const gap = 27 * s;
    for (let i = 1; i < rows.length; i++) rows[i].y = Math.max(rows[i].y, rows[i - 1].y + gap);
    const over = rows.length ? rows[rows.length - 1].y + gap / 2 - (top + plotH) : 0;
    if (over > 0) rows.forEach((r) => { r.y -= over; });
    g.textAlign = 'left';
    for (const r of rows) {
      g.fillStyle = r.color; g.font = font(10, '700'); g.textBaseline = 'alphabetic';
      g.fillText(r.sym.slice(0, 13), left + plotW + 7 * s, r.y);
      g.font = font(10); g.fillText(inr(r.val), left + plotW + 7 * s, r.y + 12 * s);
    }
  }

  // crosshair
  if (o.hover !== undefined && o.hover >= 0 && o.hover < n) {
    const i = o.hover, x = X(i);
    g.fillStyle = 'rgba(232,234,240,0.35)'; g.fillRect(x, top, 1, plotH);
    g.fillStyle = overall[i] >= 0 ? CURVE_COLORS.up : CURVE_COLORS.down;
    g.beginPath(); g.arc(x, Y(overall[i]), 3.6 * s, 0, Math.PI * 2); g.fill();
    const parts = [hhmm(curve.times[i]), `Overall ${inr(overall[i])}`, ...(showPositions ? curve.positions.map((p) => `${p.symbol} ${inr(p[mode][i])}`) : [])];
    g.font = font(10.5, '600'); g.textAlign = 'left'; g.textBaseline = 'middle';
    const w = g.measureText(parts.join('   ')).width + 12;
    g.fillStyle = 'rgba(10,17,24,0.9)'; g.fillRect(left, 0, Math.min(w, plotW + right), 20 * s);
    g.fillStyle = CURVE_COLORS.white; g.fillText(parts.join('   '), left + 6, 10 * s);
  }
  return { left, top, plotW, plotH, from, to, lo, hi };
}
