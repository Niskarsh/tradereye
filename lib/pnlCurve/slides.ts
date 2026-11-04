import { finalOf, type PositionCard } from './card';
import { extremes, type Curve, type CurveMode } from './curve';
import { CURVE_COLORS as C, drawCurve, hhmm, inr } from './draw';

/**
 * The images of the daily post, drawn in the browser (no AI, no server): the curve, the positions card, one 10-minute
 * chart per stock. 1080 x 1350 for the post (Instagram's tallest feed shape), 1080 x 1920 for a Story.
 */

export const POST_W = 1080, POST_H = 1350, STORY_H = 1920;
export const CHART_CSS_W = 540, CHART_CSS_H = 600;
const HANDLE = '@candlesbeforecubicles';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const niceDate = (d: string) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const f = (px: number, weight = 400) => `${weight} ${px}px Inter, system-ui, -apple-system, 'Segoe UI', sans-serif`;
const px2 = (n?: number) => (n === undefined ? '-' : n.toFixed(2));

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

/** Lines of one position on the card; used to measure before drawing so a busy day still fits. */
function cardLines(p: PositionCard, mode: CurveMode) {
  const slip = p.slippage;
  const orders = p.orders.map((o) => `${hhmm(o.t)}  ${o.side === 'BUY' ? 'Buy' : 'Sell'} ${o.qty} @ ${o.price.toFixed(2)}`);
  const slipLine = slip ? `${slip.kind === 'STOP' ? 'Stop' : 'Target'} ${slip.ref.toFixed(2)} → filled ${slip.fill.toFixed(2)}: ${slip.inr === 0 ? 'no slippage' : slip.inr > 0 ? `slippage ₹${Math.round(slip.inr).toLocaleString('en-IN')}` : `better by ₹${Math.round(-slip.inr).toLocaleString('en-IN')}`}` : 'Slippage: -';
  return { orders, slipLine, value: mode === 'net' ? p.net : p.gross };
}

export function cardSlide(cards: PositionCard[], curve: Curve, mode: CurveMode): HTMLCanvasElement {
  const [c, g] = canvas(POST_W, POST_H);
  const end = finalOf(curve, mode);
  g.textBaseline = 'alphabetic';
  g.font = f(30, 700); g.fillStyle = C.text; g.fillText(`${niceDate(curve.date)} · Positions`, 44, 80);
  g.font = f(40, 800); g.fillStyle = end >= 0 ? C.up : C.down; g.textAlign = 'right';
  g.fillText(`${inr(end)} ${mode}`, POST_W - 44, 82); g.textAlign = 'left';

  const heightOf = (p: PositionCard) => 186 + cardLines(p, mode).orders.length * 40;
  const total = cards.reduce((s, p) => s + heightOf(p), 0);
  const room = POST_H - 120 - 90;
  const k = Math.min(1, room / Math.max(total, 1));
  g.save(); g.translate(0, 112); g.scale(k, k);
  const w = POST_W / k;
  let y = 0;
  for (const p of cards) {
    const { orders, slipLine, value } = cardLines(p, mode);
    g.fillStyle = C.grid; g.fillRect(44, y, w - 88, 2);
    g.font = f(42, 800); g.fillStyle = C.white; g.fillText(p.symbol, 44, y + 58);
    const nameW = g.measureText(p.symbol).width;
    g.font = f(26, 700); g.fillStyle = p.direction === 'LONG' ? C.up : C.down;
    g.fillText(`${p.direction} ${p.qty}${p.openQty ? ` · ${Math.abs(p.openQty)} open` : ''}`, 44 + nameW + 22, y + 56);
    g.font = f(42, 800); g.fillStyle = value >= 0 ? C.up : C.down; g.textAlign = 'right';
    g.fillText(inr(value), w - 44, y + 58); g.textAlign = 'left';
    g.font = f(29, 500); g.fillStyle = C.white;
    g.fillText(`Buy ${px2(p.avgBuy)}   ·   Sell ${px2(p.avgSell)}   ·   Charges ₹${Math.round(p.charges).toLocaleString('en-IN')}`, 44, y + 104);
    g.font = f(27, 400); g.fillStyle = C.text;
    orders.forEach((o, i) => g.fillText(o, 44, y + 146 + i * 40));
    g.font = f(27, 600); g.fillStyle = C.gold;
    g.fillText(slipLine, 44, y + 146 + orders.length * 40);
    y += heightOf(p);
  }
  g.restore();
  footer(g, POST_W, POST_H);
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
