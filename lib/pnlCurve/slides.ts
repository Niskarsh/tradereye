import { dayHook, finalOf, positionStats, type AlgoCompare, type PositionCard } from './card';
import { extremes, type Curve, type CurveMode } from './curve';
import { CURVE_COLORS as C, drawCurve, hhmm, inr } from './draw';

/**
 * The images of the daily post, drawn in the browser (no AI, no server): the curve, the positions card, one 10-minute
 * chart per stock. 1080 x 1350 for the post (Instagram's tallest feed shape), 1080 x 1920 for a Story.
 */

export const POST_W = 1080, POST_H = 1350, STORY_H = 1920;
export const CHART_CSS_W = 540, CHART_CSS_H = 600;
const HANDLE = '@candlesbeforecubicles';
const PANEL = '#121C27';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const niceDate = (d: string) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const f = (px: number, weight = 400) => `${weight} ${px}px Inter, system-ui, -apple-system, 'Segoe UI', sans-serif`;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = C.bg; g.fillRect(0, 0, w, h);
  return [c, g];
}
function footer(g: CanvasRenderingContext2D, w: number, h: number) {
  g.font = f(26, 600); g.fillStyle = C.gold; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
  g.fillText(HANDLE, w - 44, h - 34);
  g.textAlign = 'left';
}

export function curveSlide(curve: Curve, mode: CurveMode, height = POST_H): HTMLCanvasElement {
  const [c, g] = canvas(POST_W, height);
  const end = finalOf(curve, mode), open = curve.positions.some((p) => p.openQty !== 0);
  const top = height > POST_H ? 250 : 50;
  g.textBaseline = 'alphabetic';
  g.font = f(30, 700); g.fillStyle = C.text;
  g.fillText(`${niceDate(curve.date)} · P&L ${mode === 'net' ? 'after charges' : 'before charges'}${open ? ` · as of ${hhmm(curve.times[curve.times.length - 1])}` : ''}`, 44, top + 30);
  g.font = f(104, 800); g.fillStyle = end >= 0 ? C.up : C.down;
  g.fillText(inr(end), 44, top + 138);
  const gross = finalOf(curve, 'gross'), net = finalOf(curve, 'net');
  const ex = extremes(curve.overall[mode], curve.times);
  g.font = f(30, 500); g.fillStyle = C.white;
  g.fillText(`Gross ${inr(gross)}  ·  Charges ₹${Math.round(curve.charges).toLocaleString('en-IN')}  ·  Net ${inr(net)}`, 44, top + 192);
  if (ex) {
    g.fillStyle = C.text;
    const given = ex.high.value - end;
    g.fillText(`Peak ${inr(ex.high.value)} at ${hhmm(ex.high.t)}${given >= 1 ? `, gave back ₹${Math.round(given).toLocaleString('en-IN')}` : ''}`, 44, top + 236);
  }
  const chartY = top + 262, bottom = height > POST_H ? 250 : 90;
  g.save(); g.translate(0, chartY);
  drawCurve(g, POST_W, height - chartY - bottom, curve, mode, { scale: 2 });
  g.restore();
  footer(g, POST_W, height);
  return c;
}

/** Words wrapped to a width. */
function wrap(g: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(' ')) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && g.measureText(next).width > width) { out.push(cur); cur = w; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

function panel(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  g.beginPath(); g.roundRect(x, y, w, h, 24);
  g.fillStyle = PANEL; g.fill();
  g.strokeStyle = C.grid; g.lineWidth = 2; g.stroke();
}

/** The position's P&L while it was open, with its zero line. */
function sparkline(g: CanvasRenderingContext2D, line: number[], x: number, y: number, w: number, h: number) {
  if (line.length < 2) return;
  const lo = Math.min(0, ...line), hi = Math.max(0, ...line), span = Math.max(hi - lo, 1);
  const Y = (v: number) => y + h - ((v - lo) / span) * h;
  g.strokeStyle = C.text; g.lineWidth = 2; g.setLineDash([6, 8]);
  g.beginPath(); g.moveTo(x, Y(0)); g.lineTo(x + w, Y(0)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = (line.at(-1) ?? 0) >= 0 ? C.up : C.down; g.lineWidth = 5; g.lineJoin = 'round';
  g.beginPath();
  line.forEach((v, i) => { const px = x + (i / (line.length - 1)) * w; if (i) g.lineTo(px, Y(v)); else g.moveTo(px, Y(v)); });
  g.stroke();
}

const held = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`);
const PAD = 36, SPARK = 130, STAT = 104;

function positionPanel(g: CanvasRenderingContext2D, p: PositionCard, curve: Curve, mode: CurveMode, algo: AlgoCompare | undefined, x: number, y: number, w: number, compact: boolean, draw: boolean): number {
  const st = positionStats(p, curve, mode), value = mode === 'net' ? p.net : p.gross, slip = p.slippage;
  const inner = w - PAD * 2;
  const orders = wrapOrders(g, p, inner);
  const extra = [
    slip ? `${slip.kind === 'STOP' ? 'Stop' : 'Target'} ${slip.ref.toFixed(2)}, filled ${slip.fill.toFixed(2)}: ${slip.inr === 0 ? 'no slippage' : slip.inr > 0 ? `slipped ₹${Math.round(slip.inr).toLocaleString('en-IN')}` : `better by ₹${Math.round(-slip.inr).toLocaleString('en-IN')}`}` : '',
    algo ? (algo.steppedIn ? `Algo's plan alone: ${inr(algo.planInr)}. I stepped in: ${inr(algo.myInr)}.` : 'Algo picked it. I left it alone.') : '',
  ].filter(Boolean);
  const h = PAD + 56 + (compact ? 0 : 24 + SPARK) + 24 + STAT + 22 + orders.length * 38 + extra.length * 38 + PAD - 8;
  if (!draw) return h;
  panel(g, x, y, w, h);
  const l = x + PAD, r = x + w - PAD;
  let cy = y + PAD + 42;
  g.textBaseline = 'alphabetic';
  g.font = f(44, 800); g.fillStyle = C.white; g.fillText(p.symbol, l, cy);
  const nameW = g.measureText(p.symbol).width;
  g.font = f(26, 700); g.fillStyle = C.text;
  g.fillText(`${p.direction} ${p.qty}${p.openQty ? ` · ${Math.abs(p.openQty)} open` : ''}`, l + nameW + 20, cy - 2);
  g.font = f(50, 800); g.fillStyle = value >= 0 ? C.up : C.down; g.textAlign = 'right';
  g.fillText(inr(value), r, cy + 2); g.textAlign = 'left';
  cy += 14;
  if (!compact) { sparkline(g, st.line, l, cy + 24, inner, SPARK); cy += 24 + SPARK; }
  cy += 24;
  const stats: [string, string, string][] = [['BEST', inr(st.best), st.best > 0 ? C.up : C.white], ['WORST', inr(st.worst), st.worst < 0 ? C.down : C.white], ['HELD', held(st.heldMin), C.white]];
  stats.forEach(([label, val, colour], i) => {
    const tx = l + (inner / 3) * i;
    g.font = f(24, 700); g.fillStyle = C.text; g.fillText(label, tx, cy + 28);
    g.font = f(42, 800); g.fillStyle = colour; g.fillText(val, tx, cy + 80);
  });
  cy += STAT + 22;
  g.font = f(28, 500); g.fillStyle = C.white;
  orders.forEach((o, i) => g.fillText(o, l, cy + 22 + i * 38));
  cy += orders.length * 38;
  g.font = f(28, 600); g.fillStyle = C.gold;
  extra.forEach((o, i) => g.fillText(o, l, cy + 22 + i * 38));
  return h;
}

function wrapOrders(g: CanvasRenderingContext2D, p: PositionCard, width: number): string[] {
  g.font = f(28, 500);
  return wrap(g, `${p.orders.map((o) => `${hhmm(o.t)} ${o.side === 'BUY' ? 'Buy' : 'Sell'} ${o.qty} @ ${o.price.toFixed(2)}`).join('  ·  ').replace(/ /g, ' ').replace(/  ·  /g, '  ·  ')}  ·  Charges ₹${Math.round(p.charges).toLocaleString('en-IN')}`.replace(/  ·  /g, ' · '), width);
}

/** The positions slide: a headline that says the day's story, then a panel per position, the whole block centred. */
export function cardSlide(cards: PositionCard[], curve: Curve, mode: CurveMode, algo: AlgoCompare[] = [], height = POST_H): HTMLCanvasElement {
  const [c, g] = canvas(POST_W, height);
  const story = height > POST_H;
  const safeTop = story ? 250 : 50, safeBottom = story ? 250 : 84;
  const compact = cards.length > 2;
  g.font = f(72, 800);
  const hook = wrap(g, dayHook(curve, mode, algo), POST_W - 88);
  const headH = 44 + hook.length * 84 + 28;
  const algoOf = (p: PositionCard) => algo.find((a) => a.symbol === p.symbol);
  const panelW = POST_W - 88, GAP = 22;
  const heights = cards.map((p) => positionPanel(g, p, curve, mode, algoOf(p), 44, 0, panelW, compact, false));
  const total = headH + heights.reduce((s, h) => s + h, 0) + GAP * Math.max(0, cards.length - 1);
  const room = height - safeTop - safeBottom;
  const k = Math.min(1, room / Math.max(total, 1));
  // centred in the room, and scaled from the middle so a busy day still fits
  const tx = (POST_W - POST_W * k) / 2, ty = safeTop + (room - total * k) / 2;
  g.save(); g.translate(tx, ty); g.scale(k, k);
  g.textBaseline = 'alphabetic';
  g.font = f(30, 700); g.fillStyle = C.text;
  g.fillText(`${niceDate(curve.date)} · ${inr(finalOf(curve, mode))} ${mode === 'net' ? 'after charges' : 'before charges'}`, 44, 30);
  g.font = f(72, 800); g.fillStyle = C.white;
  hook.forEach((l, i) => g.fillText(l, 44, 44 + 72 + i * 84));
  let y = headH;
  cards.forEach((p, i) => { positionPanel(g, p, curve, mode, algoOf(p), 44, y, panelW, compact, true); y += heights[i] + GAP; });
  g.restore();
  footer(g, POST_W, height);
  return c;
}

export function chartSlide(chart: HTMLCanvasElement, card: PositionCard, date: string, mode: CurveMode): HTMLCanvasElement {
  const [c, g] = canvas(POST_W, POST_H);
  const value = mode === 'net' ? card.net : card.gross;
  g.textBaseline = 'alphabetic';
  g.font = f(46, 800); g.fillStyle = C.white; g.fillText(card.symbol, 44, 68);
  const nameW = g.measureText(card.symbol).width;
  g.font = f(27, 600); g.fillStyle = C.text; g.fillText(`${card.direction} · 10 min · ${niceDate(date)}`, 44 + nameW + 22, 66);
  g.font = f(46, 800); g.fillStyle = value >= 0 ? C.up : C.down; g.textAlign = 'right'; g.fillText(inr(value), POST_W - 44, 68); g.textAlign = 'left';
  const y = 96, h = POST_H - y - 70;
  g.drawImage(chart, 0, 0, chart.width, chart.height, 0, y, POST_W, Math.min(h, (chart.height / chart.width) * POST_W));
  footer(g, POST_W, POST_H);
  return c;
}

/** Any slide on a Story-shaped background, centred. */
export function storyFrame(slide: HTMLCanvasElement): HTMLCanvasElement {
  const [c, g] = canvas(POST_W, STORY_H);
  g.drawImage(slide, 0, Math.round((STORY_H - slide.height) / 2));
  return c;
}

export const toJpeg = (c: HTMLCanvasElement) => c.toDataURL('image/jpeg', 0.92);
