import type { ImageSpec, TradeChart } from '@/lib/medium/article';

/**
 * Draws the Medium images on a canvas, from the article's real data only (never AI-generated), in his colours:
 * off-white, gold, emerald, matte red. Each becomes a PNG he downloads and uploads to Medium by hand.
 * Banner: 1400 x 788 (Medium's feed preview crops to roughly this). Others: 1400 x 800.
 */

export const PAL = {
  bg: '#F7F4EC', card: '#FFFFFF', ink: '#1B1D21', ink2: '#4A4E55', mute: '#8A8D93', grid: '#E7E1D3',
  gold: '#C29A3E', goldSoft: '#E9D9AE', green: '#1E9E74', red: '#B5444F',
};
const FONT = 'Inter, "Helvetica Neue", Arial, sans-serif';
const IST = 19800;
const hhmm = (t: number) => new Date((t + IST) * 1000).toISOString().slice(11, 16);

export function sizeOf(spec: ImageSpec): [number, number] { return spec.data.kind === 'banner' ? [1400, 788] : [1400, 800]; }

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

function frame(ctx: CanvasRenderingContext2D, W: number, H: number, title: string, sub?: string) {
  ctx.fillStyle = PAL.bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = PAL.gold; ctx.fillRect(60, 56, 56, 6);
  ctx.fillStyle = PAL.ink; ctx.font = `700 40px ${FONT}`; ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, 60, 112);
  if (sub) { ctx.fillStyle = PAL.ink2; ctx.font = `400 24px ${FONT}`; ctx.fillText(sub, 60, 148); }
  ctx.fillStyle = PAL.mute; ctx.font = `600 18px ${FONT}`; ctx.textAlign = 'right';
  ctx.fillText('CANDLES BEFORE CUBICLES · real data from tradereye', W - 60, H - 30);
  ctx.textAlign = 'left';
}

/** Price chart of one trade: 5-minute candles, his entries / adds / exits, his real stop when he had one. */
function drawTrade(ctx: CanvasRenderingContext2D, W: number, H: number, c: TradeChart, box = { x: 60, y: 180, w: W - 200, h: H - 270 }) {
  const prices = c.candles.flatMap((b) => [b.h, b.l]).concat(c.marks.map((m) => m.price), c.stop ? [c.stop] : []);
  const hi = Math.max(...prices), lo = Math.min(...prices), pad = (hi - lo) * 0.08 || 1;
  const top = hi + pad, bot = lo - pad;
  const y = (p: number) => box.y + ((top - p) / (top - bot)) * box.h;
  const n = c.candles.length, step = box.w / n, bw = Math.max(2, step * 0.62);
  const x = (i: number) => box.x + step * i + step / 2;
  const t0 = c.candles[0].t;
  const xt = (t: number) => box.x + ((t - t0) / 300) * step + step / 2;
  // grid + price scale
  ctx.font = `500 18px ${FONT}`; ctx.fillStyle = PAL.mute; ctx.strokeStyle = PAL.grid; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const p = bot + ((top - bot) * k) / 4, yy = y(p);
    ctx.beginPath(); ctx.moveTo(box.x, yy); ctx.lineTo(box.x + box.w, yy); ctx.stroke();
    ctx.fillText(p.toFixed(p < 100 ? 2 : 1), box.x + box.w + 12, yy + 6);
  }
  c.candles.forEach((b, i) => { if (i % 6 === 0) ctx.fillText(hhmm(b.t), x(i) - 24, box.y + box.h + 30); });
  // stop
  if (c.stop) {
    ctx.setLineDash([10, 8]); ctx.strokeStyle = PAL.red; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(box.x, y(c.stop)); ctx.lineTo(box.x + box.w, y(c.stop)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = PAL.red; ctx.font = `700 16px ${FONT}`; ctx.fillText('MY STOP', box.x + 6, y(c.stop) - 8);
  }
  // candles
  c.candles.forEach((b, i) => {
    const up = b.c >= b.o; ctx.strokeStyle = ctx.fillStyle = up ? PAL.green : PAL.red; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x(i), y(b.h)); ctx.lineTo(x(i), y(b.l)); ctx.stroke();
    const yo = y(b.o), yc = y(b.c);
    ctx.fillRect(x(i) - bw / 2, Math.min(yo, yc), bw, Math.max(2, Math.abs(yc - yo)));
  });
  // his orders
  for (const m of c.marks) {
    const mx = xt(m.t), my = y(m.price), isExit = m.role === 'EXIT';
    ctx.fillStyle = isExit ? PAL.ink : PAL.gold; ctx.strokeStyle = PAL.card; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(mx, my, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.font = `800 16px ${FONT}`; ctx.fillStyle = isExit ? PAL.ink : PAL.gold;
    const label = m.role === 'ENTRY' ? 'IN' : m.role === 'ADD' ? 'ADD' : 'OUT';
    ctx.fillText(label, mx + 16, my + (isExit ? 22 : -14));
  }
}

function drawBanner(ctx: CanvasRenderingContext2D, W: number, H: number, title: string, kicker: string, bg?: ImageSpec) {
  ctx.fillStyle = PAL.bg; ctx.fillRect(0, 0, W, H);
  // faint real data behind the title: the article's own chart / bars / curve
  if (bg) {
    ctx.save(); ctx.globalAlpha = 0.16;
    if (bg.data.kind === 'trade') drawTrade(ctx, W, H, bg.data.chart, { x: 0, y: 40, w: W, h: H - 80 });
    else if (bg.data.kind === 'iterations') drawBars(ctx, W, H, bg.data.bars, { x: 40, y: 60, w: W - 80, h: H - 120 }, false);
    else if (bg.data.kind === 'equity') drawCurve(ctx, W, H, bg.data.points, { x: 0, y: 60, w: W, h: H - 120 }, false);
    ctx.restore();
  }
  ctx.fillStyle = PAL.gold; ctx.fillRect(80, 150, 90, 10);
  ctx.fillStyle = PAL.gold; ctx.font = `800 26px ${FONT}`; ctx.fillText(kicker.toUpperCase(), 80, 120);
  let size = 92;
  let lines: string[] = [];
  for (; size >= 52; size -= 4) { ctx.font = `900 ${size}px ${FONT}`; lines = wrap(ctx, title || 'Untitled', W - 160); if (lines.length <= 3) break; }
  ctx.fillStyle = PAL.ink;
  lines.slice(0, 4).forEach((l, i) => ctx.fillText(l, 80, 250 + i * size * 1.12));
  ctx.fillStyle = PAL.mute; ctx.font = `700 22px ${FONT}`;
  ctx.fillText('CANDLES BEFORE CUBICLES', 80, H - 56);
}

function drawBars(ctx: CanvasRenderingContext2D, W: number, H: number, bars: { label: string; value: number }[], box = { x: 60, y: 190, w: W - 120, h: H - 290 }, labels = true) {
  if (!bars.length) return;
  const max = Math.max(1, ...bars.map((b) => Math.abs(b.value)));
  const zero = box.y + box.h / 2, scale = (box.h / 2 - 30) / max;
  const step = box.w / bars.length, bw = Math.min(90, step * 0.6);
  ctx.strokeStyle = PAL.ink2; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(box.x, zero); ctx.lineTo(box.x + box.w, zero); ctx.stroke();
  bars.forEach((b, i) => {
    const cx = box.x + step * i + step / 2, h = b.value * scale;
    ctx.fillStyle = b.value >= 0 ? PAL.green : PAL.red;
    ctx.fillRect(cx - bw / 2, h >= 0 ? zero - h : zero, bw, Math.max(3, Math.abs(h)));
    if (!labels) return;
    ctx.fillStyle = PAL.ink; ctx.font = `800 22px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText(`${b.value >= 0 ? '+' : '−'}${Math.abs(b.value)}R`, cx, h >= 0 ? zero - h - 12 : zero - h + 30);
    ctx.fillStyle = PAL.ink2; ctx.font = `600 20px ${FONT}`;
    ctx.fillText(b.label, cx, h >= 0 ? zero + 30 : zero - 14);
    ctx.textAlign = 'left';
  });
}

function drawCurve(ctx: CanvasRenderingContext2D, W: number, H: number, pts: { label: string; value: number }[], box = { x: 90, y: 190, w: W - 200, h: H - 290 }, labels = true, unit = 'R') {
  if (pts.length < 2) return;
  const vals = pts.map((p) => p.value), hi = Math.max(0, ...vals), lo = Math.min(0, ...vals), pad = (hi - lo) * 0.1 || 1;
  const top = hi + pad, bot = lo - pad;
  const y = (v: number) => box.y + ((top - v) / (top - bot)) * box.h, x = (i: number) => box.x + (box.w * i) / (pts.length - 1);
  ctx.strokeStyle = PAL.grid; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(box.x, y(0)); ctx.lineTo(box.x + box.w, y(0)); ctx.stroke();
  const last = vals[vals.length - 1];
  ctx.strokeStyle = last >= 0 ? PAL.green : PAL.red; ctx.lineWidth = 5; ctx.lineJoin = 'round';
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.value)) : ctx.moveTo(x(i), y(p.value)))); ctx.stroke();
  if (!labels) return;
  pts.forEach((p, i) => { ctx.fillStyle = p.value >= (i ? pts[i - 1].value : 0) ? PAL.green : PAL.red; ctx.beginPath(); ctx.arc(x(i), y(p.value), 6, 0, Math.PI * 2); ctx.fill(); });
  const fmt = (v: number) => (v === 0 ? (unit === '₹' ? '₹0' : '0R') : unit === '₹' ? `${v >= 0 ? '+' : '−'}₹${Math.abs(v).toLocaleString('en-IN')}` : `${v >= 0 ? '+' : '−'}${Math.abs(v)}R`);
  ctx.fillStyle = PAL.ink; ctx.font = `800 30px ${FONT}`; ctx.fillText(fmt(last), x(pts.length - 1) - 10 - ctx.measureText(fmt(last)).width, y(last) - 20);
  ctx.fillStyle = PAL.mute; ctx.font = `500 18px ${FONT}`;
  ctx.fillText(fmt(hi), 10, y(hi) + 6); ctx.fillText(fmt(lo), 10, y(lo) + 6);
  ctx.fillText(`${pts.length - 1} trades, in order`, box.x, box.y + box.h + 34);
}

function drawScoreboard(ctx: CanvasRenderingContext2D, W: number, weeks: { week: string; me: number; algo: number; winner: string }[], season: { me: number; algo: number }) {
  ctx.font = `900 120px ${FONT}`; ctx.textAlign = 'center';
  ctx.fillStyle = season.me >= season.algo ? PAL.green : PAL.ink2; ctx.fillText(String(season.me), W / 2 - 220, 330);
  ctx.fillStyle = PAL.gold; ctx.fillText('–', W / 2, 330);
  ctx.fillStyle = season.algo > season.me ? PAL.green : PAL.ink2; ctx.fillText(String(season.algo), W / 2 + 220, 330);
  ctx.font = `800 30px ${FONT}`; ctx.fillStyle = PAL.ink;
  ctx.fillText('ME', W / 2 - 220, 380); ctx.fillText('ALGO', W / 2 + 220, 380);
  const rows = weeks.slice(-6);
  ctx.font = `600 26px ${FONT}`;
  rows.forEach((w, i) => {
    const yy = 450 + i * 44, r = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v)}R`;
    ctx.fillStyle = PAL.ink2; ctx.fillText(`Week of ${w.week.slice(8)}/${w.week.slice(5, 7)}`, W / 2, yy);
    ctx.fillStyle = w.winner === 'me' ? PAL.green : w.me < 0 ? PAL.red : PAL.ink; ctx.fillText(r(w.me), W / 2 - 220, yy);
    ctx.fillStyle = w.winner === 'algo' ? PAL.green : w.algo < 0 ? PAL.red : PAL.ink; ctx.fillText(r(w.algo), W / 2 + 220, yy);
  });
  ctx.textAlign = 'left';
}

/** Draws one image on the canvas (sized here). `title` / `kicker` feed the banner; `bg` is the banner's faint backdrop. */
export function drawImage(canvas: HTMLCanvasElement, spec: ImageSpec, opts: { title: string; kicker: string; bg?: ImageSpec }) {
  const [W, H] = sizeOf(spec);
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const d = spec.data;
  if (d.kind === 'banner') { drawBanner(ctx, W, H, opts.title, opts.kicker, opts.bg); return; }
  if (d.kind === 'trade') {
    frame(ctx, W, H, `${d.chart.label} · ${d.chart.dir === 'LONG' ? 'Long' : 'Short'} · ${d.chart.result}`, `${d.chart.date} · 5-minute candles · gold = in, black = out`);
    drawTrade(ctx, W, H, d.chart);
  } else if (d.kind === 'equity') {
    frame(ctx, W, H, spec.title, `Running total, ${d.unit === 'R' ? 'in R (risk units)' : 'in ₹'}, after charges`);
    drawCurve(ctx, W, H, d.points, undefined, true, d.unit);
  } else if (d.kind === 'iterations') {
    frame(ctx, W, H, spec.title, 'Best strategy of each iteration, months it never trained on');
    drawBars(ctx, W, H, d.bars);
  } else if (d.kind === 'scoreboard') {
    frame(ctx, W, H, 'Me vs my algo', 'Weeks won, frozen scores in R after charges');
    drawScoreboard(ctx, W, d.weeks, d.season);
  }
}

/** File name for the download: article-short, image id. */
export const fileName = (title: string, id: string) => `${(title || 'medium').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}-${id}.png`;
