import type { Drawing, DrawingStyle, Theme } from '../types';

/** A drawing's anchor on screen. */
export interface Pt { x: number; y: number }

/** What a drawing tool can ask the chart while it draws. */
export interface DrawEnv {
  width: number; height: number; theme: Theme; selected: boolean;
  price(y: number): number;
  y(price: number): number;
  fmt(price: number): string;
  /** bars between two anchors' times (signed) and their total volume */
  span(t1: number, t2: number): { bars: number; volume: number; seconds: number };
}

export interface ToolDef {
  type: string; label: string; group: 'Lines' | 'Shapes' | 'Fibonacci' | 'Positions' | 'Measure' | 'Text';
  /** anchors to place with clicks; 0 = freehand (press and drag) */
  points: number;
  defaultStyle: Partial<DrawingStyle>;
  render(c: CanvasRenderingContext2D, p: Pt[], d: Drawing, env: DrawEnv): void;
  /** true when (x, y) is on the drawing */
  hit(p: Pt[], x: number, y: number, d: Drawing, env: DrawEnv): boolean;
  /** the anchors as they are saved come from the clicks; some tools derive more (positions) */
  init?(d: Drawing, env: DrawEnv): void;
  /** where the drag handles are (defaults to the anchors) */
  handles?(p: Pt[], d: Drawing, env: DrawEnv): Pt[];
  /** move handle h to (x, y): change d.points (defaults to moving that anchor) */
  moveHandle?(d: Drawing, h: number, at: { t: number; p: number }, env: DrawEnv): void;
  /** the prices to mark on the price scale while selected */
  axisPrices?(d: Drawing): number[];
}

const TOL = 6;

export function distToSeg(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** the segment a->b stretched to the edges of the pane (left / right as asked) */
export function extend(a: Pt, b: Pt, w: number, left: boolean, right: boolean): [Pt, Pt] {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) < 1e-9) return [a, b];
  const k = dy / dx;
  const L: Pt = left ? (b.x >= a.x ? { x: -10, y: a.y + k * (-10 - a.x) } : { x: w + 10, y: a.y + k * (w + 10 - a.x) }) : a;
  const R: Pt = right ? (b.x >= a.x ? { x: w + 10, y: a.y + k * (w + 10 - a.x) } : { x: -10, y: a.y + k * (-10 - a.x) }) : b;
  return [L, R];
}

export function stroke(c: CanvasRenderingContext2D, s: DrawingStyle) {
  c.strokeStyle = s.color;
  c.lineWidth = s.width;
  c.setLineDash(s.dash === 'dashed' ? [6, 4] : s.dash === 'dotted' ? [1.5, 3] : []);
}

function line(c: CanvasRenderingContext2D, a: Pt, b: Pt) { c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); }

/** a small filled label box */
export function tag(c: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string, fg = '#0A1118', align: 'left' | 'center' | 'right' = 'center') {
  const lines = text.split('\n');
  const w = Math.max(...lines.map((l) => c.measureText(l).width)) + 10, h = lines.length * 14 + 6;
  const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  c.setLineDash([]);
  c.fillStyle = bg;
  c.beginPath();
  if (c.roundRect) c.roundRect(x0, y - h / 2, w, h, 3); else c.rect(x0, y - h / 2, w, h);
  c.fill();
  c.fillStyle = fg;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  lines.forEach((l, i) => c.fillText(l, x0 + w / 2, y - h / 2 + 10 + i * 14));
}

const lineTool = (type: string, label: string, left: boolean, right: boolean, arrow = false): ToolDef => ({
  type, label, group: 'Lines', points: 2, defaultStyle: { extendLeft: left, extendRight: right },
  render(c, p, d, env) {
    stroke(c, d.style);
    const [a, b] = extend(p[0], p[1], env.width, !!d.style.extendLeft, !!d.style.extendRight);
    line(c, a, b);
    if (arrow) {
      const ang = Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x), s = 8 + d.style.width * 2;
      c.setLineDash([]);
      c.beginPath();
      c.moveTo(p[1].x, p[1].y);
      c.lineTo(p[1].x - s * Math.cos(ang - 0.45), p[1].y - s * Math.sin(ang - 0.45));
      c.moveTo(p[1].x, p[1].y);
      c.lineTo(p[1].x - s * Math.cos(ang + 0.45), p[1].y - s * Math.sin(ang + 0.45));
      c.stroke();
    }
    if (d.style.text) { c.fillStyle = d.style.color; c.textAlign = 'center'; c.textBaseline = 'bottom'; c.fillText(d.style.text, (p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2 - 4); }
  },
  hit(p, x, y, d, env) { const [a, b] = extend(p[0], p[1], env.width, !!d.style.extendLeft, !!d.style.extendRight); return distToSeg(x, y, a, b) < TOL; },
});

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618];
const FIB_COLORS = ['#787B86', '#E03F53', '#E8873A', '#1DC995', '#00BCD4', '#8FA8C2', '#787B86', '#DFB15B'];

function positionTool(type: 'long' | 'short'): ToolDef {
  const dir = type === 'long' ? 1 : -1;
  return {
    type, label: type === 'long' ? 'Long position' : 'Short position', group: 'Positions', points: 1, defaultStyle: { showLabels: true },
    // points: [entry {t, p}, target {t: right edge, p: target}, stop {t: entry time, p: stop}]
    init(d, env) {
      const e = d.points[0];
      const risk = Math.abs(env.price(env.y(e.p) + 40) - e.p) || e.p * 0.005;
      const span = Math.max(600, env.span(e.t, e.t).seconds);
      d.points = [e, { t: e.t + span * 20, p: e.p + dir * risk * 2 }, { t: e.t, p: e.p - dir * risk }];
    },
    handles(p) { return [p[0], { x: p[1].x, y: p[1].y }, { x: p[0].x, y: p[2].y }, { x: p[1].x, y: p[0].y }]; },
    moveHandle(d, h, at) {
      const [e, tg, st] = d.points;
      if (h === 0) { const dp = at.p - e.p, dt = at.t - e.t; d.points = [{ t: at.t, p: at.p }, { t: tg.t + dt, p: tg.p + dp }, { t: at.t, p: st.p + dp }]; }
      else if (h === 1) { if ((at.p - e.p) * dir > 0) tg.p = at.p; tg.t = Math.max(e.t + 1, at.t); }
      else if (h === 2) { if ((e.p - at.p) * dir > 0) st.p = at.p; }
      else if (h === 3) tg.t = Math.max(e.t + 1, at.t);
    },
    axisPrices: (d) => [d.points[0].p, d.points[1].p, d.points[2].p],
    render(c, p, d, env) {
      const [e, tg, st] = d.points;
      const x0 = p[0].x, x1 = p[1].x, ye = p[0].y, yt = p[1].y, ys = p[2].y;
      c.setLineDash([]);
      c.fillStyle = 'rgba(29,201,149,0.18)'; c.fillRect(x0, Math.min(ye, yt), x1 - x0, Math.abs(yt - ye));
      c.fillStyle = 'rgba(224,63,83,0.18)'; c.fillRect(x0, Math.min(ye, ys), x1 - x0, Math.abs(ys - ye));
      c.strokeStyle = '#8FA8C2'; c.lineWidth = 1; line(c, { x: x0, y: ye }, { x: x1, y: ye });
      if (!d.style.showLabels && !env.selected) return;
      const rr = Math.abs(tg.p - e.p) / Math.max(1e-9, Math.abs(e.p - st.p));
      const pct = (a: number) => `${(((a - e.p) / e.p) * 100).toFixed(2)}%`;
      const mid = (x0 + x1) / 2;
      tag(c, `Target: ${env.fmt(tg.p)} (${pct(tg.p)})`, mid, yt + (dir === 1 ? -12 : 12), '#1DC995');
      tag(c, `Stop: ${env.fmt(st.p)} (${pct(st.p)})`, mid, ys + (dir === 1 ? 12 : -12), '#E03F53', '#E8EAF0');
      tag(c, `${type === 'long' ? 'Long' : 'Short'} ${env.fmt(e.p)} · R:R ${rr.toFixed(2)}`, mid, ye, '#1E2D3D', '#E8EAF0');
    },
    hit(p, x, y) {
      const x0 = Math.min(p[0].x, p[1].x), x1 = Math.max(p[0].x, p[1].x), top = Math.min(p[1].y, p[2].y), bot = Math.max(p[1].y, p[2].y);
      return x >= x0 && x <= x1 && y >= top && y <= bot;
    },
  };
}

const defs: ToolDef[] = [
  lineTool('trend', 'Trend line', false, false),
  lineTool('ray', 'Ray', false, true),
  lineTool('extended', 'Extended line', true, true),
  lineTool('arrow', 'Arrow', false, false, true),
  {
    type: 'hline', label: 'Horizontal line', group: 'Lines', points: 1, defaultStyle: { showLabels: true },
    render(c, p, d, env) { stroke(c, d.style); line(c, { x: 0, y: p[0].y }, { x: env.width, y: p[0].y }); if (d.style.text) { c.fillStyle = d.style.color; c.textAlign = 'left'; c.textBaseline = 'bottom'; c.fillText(d.style.text, 6, p[0].y - 3); } },
    hit: (p, _x, y) => Math.abs(y - p[0].y) < TOL,
    axisPrices: (d) => [d.points[0].p],
  },
  {
    type: 'hray', label: 'Horizontal ray', group: 'Lines', points: 1, defaultStyle: { showLabels: true },
    render(c, p, d, env) { stroke(c, d.style); line(c, p[0], { x: env.width, y: p[0].y }); },
    hit: (p, x, y) => x >= p[0].x - TOL && Math.abs(y - p[0].y) < TOL,
    axisPrices: (d) => [d.points[0].p],
  },
  {
    type: 'vline', label: 'Vertical line', group: 'Lines', points: 1, defaultStyle: {},
    render(c, p, d, env) { stroke(c, d.style); line(c, { x: p[0].x, y: 0 }, { x: p[0].x, y: env.height }); },
    hit: (p, x) => Math.abs(x - p[0].x) < TOL,
  },
  {
    type: 'cross', label: 'Cross line', group: 'Lines', points: 1, defaultStyle: {},
    render(c, p, d, env) { stroke(c, d.style); line(c, { x: p[0].x, y: 0 }, { x: p[0].x, y: env.height }); line(c, { x: 0, y: p[0].y }, { x: env.width, y: p[0].y }); },
    hit: (p, x, y) => Math.abs(x - p[0].x) < TOL || Math.abs(y - p[0].y) < TOL,
    axisPrices: (d) => [d.points[0].p],
  },
  {
    type: 'channel', label: 'Parallel channel', group: 'Lines', points: 3, defaultStyle: { fill: 'rgba(143,168,194,0.08)' },
    render(c, p, d) {
      const off = p.length > 2 ? p[2].y - (p[0].y + ((p[1].y - p[0].y) * (p[2].x - p[0].x)) / ((p[1].x - p[0].x) || 1)) : 0;
      const a2 = { x: p[0].x, y: p[0].y + off }, b2 = { x: p[1].x, y: p[1].y + off };
      if (d.style.fill) { c.fillStyle = d.style.fill; c.beginPath(); c.moveTo(p[0].x, p[0].y); c.lineTo(p[1].x, p[1].y); c.lineTo(b2.x, b2.y); c.lineTo(a2.x, a2.y); c.closePath(); c.fill(); }
      stroke(c, d.style); line(c, p[0], p[1]); line(c, a2, b2);
      c.setLineDash([4, 4]); c.lineWidth = 1; line(c, { x: p[0].x, y: p[0].y + off / 2 }, { x: p[1].x, y: p[1].y + off / 2 });
    },
    hit(p, x, y) {
      const off = p[2].y - (p[0].y + ((p[1].y - p[0].y) * (p[2].x - p[0].x)) / ((p[1].x - p[0].x) || 1));
      return distToSeg(x, y, p[0], p[1]) < TOL || distToSeg(x, y, { x: p[0].x, y: p[0].y + off }, { x: p[1].x, y: p[1].y + off }) < TOL;
    },
  },
  {
    type: 'rect', label: 'Rectangle', group: 'Shapes', points: 2, defaultStyle: { fill: 'rgba(223,177,91,0.12)' },
    render(c, p, d) {
      const x = Math.min(p[0].x, p[1].x), y = Math.min(p[0].y, p[1].y), w = Math.abs(p[1].x - p[0].x), h = Math.abs(p[1].y - p[0].y);
      if (d.style.fill) { c.fillStyle = d.style.fill; c.fillRect(x, y, w, h); }
      stroke(c, d.style); c.strokeRect(x, y, w, h);
      if (d.style.text) { c.fillStyle = d.style.color; c.textAlign = 'left'; c.textBaseline = 'top'; c.fillText(d.style.text, x + 4, y + 4); }
    },
    hit(p, x, y) {
      const x0 = Math.min(p[0].x, p[1].x), x1 = Math.max(p[0].x, p[1].x), y0 = Math.min(p[0].y, p[1].y), y1 = Math.max(p[0].y, p[1].y);
      return x >= x0 - TOL && x <= x1 + TOL && y >= y0 - TOL && y <= y1 + TOL;
    },
  },
  {
    type: 'fib', label: 'Fib retracement', group: 'Fibonacci', points: 2, defaultStyle: { showLabels: true },
    render(c, p, d, env) {
      const [a, b] = d.points;
      const x0 = Math.min(p[0].x, p[1].x), x1 = d.style.extendRight ? env.width : Math.max(p[0].x, p[1].x);
      c.setLineDash([]);
      FIB.forEach((lv, i) => {
        const price = b.p + (a.p - b.p) * lv, y = env.y(price);
        if (i < FIB.length - 1) {
          const y2 = env.y(b.p + (a.p - b.p) * FIB[i + 1]);
          c.globalAlpha = 0.08; c.fillStyle = FIB_COLORS[i]; c.fillRect(x0, Math.min(y, y2), x1 - x0, Math.abs(y2 - y)); c.globalAlpha = 1;
        }
        c.strokeStyle = FIB_COLORS[i]; c.lineWidth = 1; line(c, { x: x0, y }, { x: x1, y });
        if (d.style.showLabels) { c.fillStyle = FIB_COLORS[i]; c.textAlign = 'right'; c.textBaseline = 'middle'; c.fillText(`${lv} (${env.fmt(price)})`, x0 - 4, y); }
      });
      stroke(c, { ...d.style, dash: 'dashed', width: 1 }); line(c, p[0], p[1]);
    },
    hit(p, x, y, d, env) {
      const [a, b] = d.points, x0 = Math.min(p[0].x, p[1].x), x1 = Math.max(p[0].x, p[1].x);
      if (x < x0 - TOL || x > x1 + TOL) return false;
      return FIB.some((lv) => Math.abs(env.y(b.p + (a.p - b.p) * lv) - y) < TOL);
    },
  },
  positionTool('long'),
  positionTool('short'),
  {
    type: 'measure', label: 'Date & price range', group: 'Measure', points: 2, defaultStyle: {},
    render(c, p, d, env) {
      const [a, b] = d.points;
      const up = b.p >= a.p, col = up ? 'rgba(41,98,255,0.18)' : 'rgba(224,63,83,0.18)';
      const x = Math.min(p[0].x, p[1].x), y = Math.min(p[0].y, p[1].y);
      c.fillStyle = col; c.fillRect(x, y, Math.abs(p[1].x - p[0].x), Math.abs(p[1].y - p[0].y));
      c.strokeStyle = up ? '#2962FF' : '#E03F53'; c.lineWidth = 1; c.setLineDash([]);
      line(c, { x: (p[0].x + p[1].x) / 2, y: p[0].y }, { x: (p[0].x + p[1].x) / 2, y: p[1].y });
      line(c, { x: p[0].x, y: (p[0].y + p[1].y) / 2 }, { x: p[1].x, y: (p[0].y + p[1].y) / 2 });
      const s = env.span(a.t, b.t), diff = b.p - a.p;
      const dur = Math.abs(s.seconds) >= 86400 ? `${Math.round(Math.abs(s.seconds) / 86400)}d` : `${Math.floor(Math.abs(s.seconds) / 3600)}h ${Math.round((Math.abs(s.seconds) % 3600) / 60)}m`;
      const vol = s.volume >= 1e7 ? `${(s.volume / 1e7).toFixed(2)} Cr` : s.volume >= 1e5 ? `${(s.volume / 1e5).toFixed(2)} L` : `${Math.round(s.volume)}`;
      tag(c, `${diff >= 0 ? '+' : ''}${env.fmt(diff)} (${((diff / a.p) * 100).toFixed(2)}%)\n${Math.abs(s.bars)} bars, ${dur}\nVol ${vol}`, (p[0].x + p[1].x) / 2, Math.max(p[0].y, p[1].y) + 30, up ? '#2962FF' : '#E03F53', '#E8EAF0');
    },
    hit(p, x, y) {
      const x0 = Math.min(p[0].x, p[1].x), x1 = Math.max(p[0].x, p[1].x), y0 = Math.min(p[0].y, p[1].y), y1 = Math.max(p[0].y, p[1].y);
      return x >= x0 && x <= x1 && y >= y0 && y <= y1;
    },
  },
  {
    type: 'text', label: 'Text', group: 'Text', points: 1, defaultStyle: { text: 'Text', fontSize: 14 },
    render(c, p, d) {
      c.font = `${d.style.fontSize ?? 14}px -apple-system, BlinkMacSystemFont, Roboto, sans-serif`;
      c.fillStyle = d.style.color; c.textAlign = 'left'; c.textBaseline = 'top';
      (d.style.text ?? '').split('\n').forEach((l, i) => c.fillText(l, p[0].x, p[0].y + i * ((d.style.fontSize ?? 14) + 4)));
    },
    hit(p, x, y, d) {
      const fs = d.style.fontSize ?? 14, lines = (d.style.text ?? '').split('\n');
      const w = Math.max(20, ...lines.map((l) => l.length * fs * 0.6));
      return x >= p[0].x - 4 && x <= p[0].x + w && y >= p[0].y - 4 && y <= p[0].y + lines.length * (fs + 4);
    },
  },
  {
    type: 'brush', label: 'Brush', group: 'Shapes', points: 0, defaultStyle: { width: 2 },
    render(c, p, d) {
      if (p.length < 2) return;
      stroke(c, d.style); c.lineJoin = 'round'; c.lineCap = 'round';
      c.beginPath(); c.moveTo(p[0].x, p[0].y); for (const q of p.slice(1)) c.lineTo(q.x, q.y); c.stroke();
      c.lineCap = 'butt';
    },
    hit(p, x, y) { for (let i = 1; i < p.length; i++) if (distToSeg(x, y, p[i - 1], p[i]) < TOL) return true; return false; },
    handles: () => [],
  },
];

const REG = new Map(defs.map((d) => [d.type, d]));
export function getTool(type: string): ToolDef | undefined { return REG.get(type); }
export function listTools(): ToolDef[] { return [...REG.values()]; }
export function registerTool(t: ToolDef) { REG.set(t.type, t); }
