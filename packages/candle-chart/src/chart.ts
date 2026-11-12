import { heikinAshi, indexAtOrBefore, intervalLabel, intervalMinutes, intervalSeconds, isIntraday, localDayStart, localParts } from './data';
import { axisLabel, fmtCountdown, fmtPrice, fmtTime, fmtValue, fmtVolume } from './format';
import { getIndicator, type IndicatorDef } from './indicators/registry';
import { getTool, stroke, tag, type DrawEnv, type Pt } from './drawings/tools';
import { classicCandles, DARK, NSE } from './theme';
import type {
  Anchor, Annotations, Bar, CandleStyle, ChartEvent, OrderLine, VolCandleStyle, ChartState, ChartType, CompareSeries, Drawing, DrawingStyle, IndicatorState, Interval, Marker,
  ScaleMode, Theme, TimeOpts,
} from './types';
import { ChartSettingsDialog, DrawingBar, IndicatorDialog, el, icon, popupMenu } from './ui';

export interface ChartOptions {
  theme?: Theme; time?: TimeOpts; interval?: Interval; symbol?: string; precision?: number;
  /** text under the symbol in the legend (exchange, company name) */
  description?: string;
  state?: Partial<ChartState>;
  /** price step for dragged order lines (NSE: 0.05) */
  tick?: number;
}

interface Ind { st: IndicatorState; def: IndicatorDef; out: Record<string, number[]> }
interface Pane { id: string; ratio: number; top: number; h: number; min: number; max: number; auto: boolean; legend?: HTMLDivElement }
type Drag =
  | { kind: 'pan'; x: number; y: number; right: number; pane: Pane; min: number; max: number }
  | { kind: 'price'; y: number; pane: Pane; min: number; max: number }
  | { kind: 'time'; x: number; spacing: number }
  | { kind: 'sep'; y: number; a: Pane; b: Pane; ra: number; rb: number; ha: number; hb: number }
  | { kind: 'move'; d: Drawing; orig: Anchor[]; at: { i: number; p: number }; moved: boolean }
  | { kind: 'handle'; d: Drawing; h: number; moved: boolean }
  | { kind: 'brush'; d: Drawing }
  | { kind: 'order'; id: string; y0: number; p0: number; moved: boolean }
  | { kind: 'pinch'; d0: number; spacing: number; i0: number; x0: number };

const AXIS_W = 70, TIME_H = 26, MIN_SPACING = 1.2, MAX_SPACING = 80, RIGHT_GAP = 6;
let uid = 0;
/** dark or light text, whichever reads on this colour */
function inkOn(color: string): string {
  let r = 200, g = 200, b = 200;
  const hex = /^#([0-9a-f]{6})/i.exec(color), rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
  if (hex) { const n = parseInt(hex[1], 16); r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255; }
  else if (rgb) { r = +rgb[1]; g = +rgb[2]; b = +rgb[3]; }
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0A1118' : '#FFFFFF';
}
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const newId = (p: string) => `${p}${Date.now().toString(36)}${(uid++).toString(36)}`;

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target), p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

/**
 * A financial chart: candles and other series, indicators in panes, drawing tools, annotations, compare lines.
 * Framework free: give it an element; it fills it and follows the element's size.
 */
export class Chart {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private c: CanvasRenderingContext2D;
  private theme: Theme;
  private time: TimeOpts;
  private interval: Interval;
  private symbol: string;
  private description: string;
  private precision: number;

  private raw: Bar[] = [];
  private bars: Bar[] = [];
  private type: ChartType = 'candles';
  private scaleMode: ScaleMode = 'linear';
  private candles: CandleStyle;
  private volCandles: VolCandleStyle = { base: 0.35, effect: 1 };
  private grid = true;
  private sessionBreaks = true;
  private legendCollapsed = false;
  private inds: Ind[] = [];
  private panes: Pane[] = [{ id: 'main', ratio: 3, top: 0, h: 0, min: 0, max: 1, auto: true }];
  private compare: (CompareSeries & { byT: Map<number, number> })[] = [];
  private layers = new Map<string, Annotations>();
  private hiddenLayers = new Set<string>();

  private drawings: Drawing[] = [];
  private drawingsHidden = false;
  private selected: Drawing | null = null;
  private creating: Drawing | null = null;
  private tool: string | null = null;
  private magnet: 'off' | 'weak' | 'strong' = 'weak';
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  private spacing = 8;
  private right = 0; // logical bar index at the right edge of the plot
  private W = 0; private H = 0; private dpr = 1;
  private plotW = 0; private plotH = 0;
  private mouse: { x: number; y: number } | null = null;
  private extCross: number | null = null;
  private drag: Drag | null = null;
  private orders: OrderLine[] = [];
  private orderPreview: { id: string; price: number } | null = null;
  private bidAsk: { bid?: number; ask?: number } = {};
  /** net position shown between SELL and BUY in the quote box (0 / undefined = flat) */
  private posQty: number | undefined;
  private quoteEl: HTMLDivElement | null = null;
  private tick = 0.05;
  private touches = new Map<number, { x: number; y: number }>();
  private cornerBtn!: HTMLButtonElement;
  private liveBtn!: HTMLButtonElement;
  private downAt: { x: number; y: number } | null = null;
  private frame = 0;
  private historyAsked = 0;
  private listeners = new Set<(e: ChartEvent) => void>();
  private ro: ResizeObserver;
  private clock: ReturnType<typeof setInterval>;
  private legendMain: HTMLDivElement;
  private tooltip: HTMLDivElement;
  private drawingBar: DrawingBar;
  private dialog: IndicatorDialog | ChartSettingsDialog | null = null;
  private destroyed = false;

  constructor(container: HTMLElement, opts: ChartOptions = {}) {
    this.theme = opts.theme ?? DARK;
    this.time = opts.time ?? NSE;
    this.interval = opts.interval ?? '10';
    this.symbol = opts.symbol ?? '';
    this.description = opts.description ?? '';
    this.precision = opts.precision ?? 2;
    this.candles = classicCandles(this.theme);
    this.tick = opts.tick ?? 0.05;
    this.root = el('div', { class: 'cc-root', tabindex: '0' }) as HTMLDivElement;
    Object.assign(this.root.style, { position: 'relative', width: '100%', height: '100%', overflow: 'hidden', outline: 'none', background: this.theme.bg, font: this.theme.font, userSelect: 'none', touchAction: 'none' });
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    this.root.appendChild(this.canvas);
    this.c = this.canvas.getContext('2d')!;
    this.legendMain = el('div', { class: 'cc-legend' }) as HTMLDivElement;
    this.root.appendChild(this.legendMain);
    this.tooltip = el('div', { class: 'cc-tip' }) as HTMLDivElement;
    Object.assign(this.tooltip.style, { position: 'absolute', display: 'none', pointerEvents: 'none', zIndex: '6', background: this.theme.panelBg, border: `1px solid ${this.theme.panelBorder}`, color: this.theme.text, padding: '6px 8px', borderRadius: '6px', maxWidth: '280px', whiteSpace: 'pre-wrap', fontSize: '11px', lineHeight: '1.35' });
    this.root.appendChild(this.tooltip);
    // TradingView's corner: reset the scales; and "go to the latest bar" when scrolled back
    const small = (title: string, label: string) => {
      const b = el('button', { title, style: `position:absolute;z-index:5;display:flex;align-items:center;justify-content:center;background:${this.theme.panelBg};border:1px solid ${this.theme.panelBorder};color:${this.theme.text};border-radius:6px;cursor:pointer;font-size:12px;line-height:1` }, [label]) as HTMLButtonElement;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      this.root.appendChild(b);
      return b;
    };
    this.cornerBtn = small('Reset the price and time scales (Alt+R)', '⟲');
    Object.assign(this.cornerBtn.style, { right: '4px', bottom: '3px', width: `${AXIS_W - 10}px`, height: `${TIME_H - 6}px` });
    this.cornerBtn.addEventListener('click', () => this.resetScales());
    this.liveBtn = small('Go to the latest bar', '»');
    Object.assign(this.liveBtn.style, { right: `${AXIS_W + 8}px`, bottom: `${TIME_H + 8}px`, width: '26px', height: '24px', display: 'none' });
    this.liveBtn.addEventListener('click', () => this.scrollToRealtime());
    this.drawingBar = new DrawingBar(this.root, this.theme, {
      change: (patch) => this.patchSelected(patch),
      remove: () => this.deleteSelected(),
      lock: () => { if (this.selected) { this.pushUndo(); this.selected.locked = !this.selected.locked; this.emitDrawings(); this.drawingBar.show(this.selected, getTool(this.selected.type)!); this.invalidate(); } },
      clone: () => this.cloneSelected(),
    });
    container.appendChild(this.root);
    if (opts.state) this.setState(opts.state);
    this.bind();
    this.ro = new ResizeObserver(() => this.invalidate());
    this.ro.observe(this.root);
    this.clock = setInterval(() => { if (this.raw.length && isIntraday(this.interval)) this.invalidate(); }, 1000);
    this.invalidate();
  }

  /* ======================= public API ======================= */

  on(fn: (e: ChartEvent) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(e: ChartEvent) { for (const f of this.listeners) { try { f(e); } catch { /* a listener's error is its own */ } } }

  /** Replace the data (a new symbol or interval): the view jumps to the latest bars. */
  setBars(bars: Bar[]) {
    this.raw = bars.slice();
    this.recompute();
    this.right = this.bars.length - 1 + RIGHT_GAP;
    this.historyAsked = 0;
    for (const p of this.panes) p.auto = true;
    this.invalidate();
  }

  /** Older bars loaded on scroll: the view stays where it was. */
  prependBars(older: Bar[]) {
    const first = this.raw[0]?.t ?? Infinity;
    const add = older.filter((b) => b.t < first);
    if (!add.length) { this.historyAsked = -1; return; } // nothing older exists: stop asking
    this.raw = [...add, ...this.raw];
    this.right += add.length;
    this.recompute();
    this.historyAsked = 0;
    this.invalidate();
  }

  /** Live update: the same series with its last bar changed or new bars added. Follows the latest bar if it was in view. */
  updateBars(bars: Bar[]) {
    const n0 = this.bars.length;
    const following = this.right >= n0 - 1 - 0.5;
    if (bars.length && this.raw.length && bars[0].t !== this.raw[0].t) {
      // the caller rebuilt the series from a later start: keep older history we already had
      const first = bars[0].t;
      this.raw = [...this.raw.filter((b) => b.t < first), ...bars];
    } else this.raw = bars.slice();
    this.recompute();
    if (following) this.right += this.bars.length - n0;
    this.invalidate();
  }

  getBars(): Bar[] { return this.raw; }

  setInterval(iv: Interval) { this.interval = iv; this.renderLegendStructure(); this.invalidate(); }
  getInterval(): Interval { return this.interval; }
  setSymbol(symbol: string, description = '', precision = this.precision) { this.symbol = symbol; this.description = description; this.precision = precision; this.selected = null; this.drawingBar.hide(); this.renderLegendStructure(); this.invalidate(); }

  setType(t: ChartType) { this.type = t; this.recompute(); this.emit({ type: 'stateChange' }); this.invalidate(); }
  getType(): ChartType { return this.type; }
  setScaleMode(m: ScaleMode) { this.scaleMode = m; this.panes[0].auto = true; this.emit({ type: 'stateChange' }); this.invalidate(); }
  getScaleMode(): ScaleMode { return this.scaleMode; }
  /** volume on the price pane is the 'vol' indicator (removable and customisable like any other) */
  hasVolume(): boolean { return this.inds.some((x) => x.def.special === 'volume'); }
  setVolumeVisible(on: boolean) {
    const has = this.inds.find((x) => x.def.special === 'volume');
    if (on && !has) this.addIndicator('vol');
    else if (!on && has) this.removeIndicator(has.st.id);
  }
  setCandleStyle(c: CandleStyle) { this.candles = { ...c }; this.emit({ type: 'stateChange' }); this.invalidate(); }
  getCandleStyle(): CandleStyle { return { ...this.candles }; }
  /** Chart settings (candle colours, grid, session breaks). `onApply` also gets whether to copy it to the other charts. */
  openSettings(opts: { allOption?: boolean; title?: string; onApply?: (st: ChartState, all: boolean) => void; onPreview?: (vc: VolCandleStyle, type: ChartType) => void } = {}) {
    this.dialog?.close();
    const before = { type: this.type, candles: { ...this.candles }, volCandles: { ...this.volCandles } };
    this.dialog = new ChartSettingsDialog(this.root, this.theme, { type: this.type, candles: this.candles, grid: this.grid, sessionBreaks: this.sessionBreaks, volCandles: this.volCandles }, opts.allOption ? (opts.title ?? true) : false, (v, all) => {
      if (v.type !== this.type) { this.type = v.type; this.recompute(); }
      this.candles = v.candles;
      this.volCandles = { ...v.volCandles }; this.grid = v.grid; this.sessionBreaks = v.sessionBreaks;
      this.emit({ type: 'stateChange' });
      this.invalidate();
      opts.onApply?.(this.getState(), all);
    }, () => { this.dialog = null; }, (v) => {
      // live preview while a slider moves (Cancel puts it back)
      this.volCandles = { ...v.volCandles };
      if (v.type !== this.type) { this.type = v.type; this.recompute(); }
      opts.onPreview?.(v.volCandles, v.type);
      this.invalidate();
    }, () => {
      this.type = before.type; this.candles = before.candles; this.volCandles = before.volCandles;
      this.recompute(); this.invalidate();
      opts.onPreview?.(before.volCandles, before.type);
    });
  }

  getState(): ChartState {
    return {
      type: this.type, scaleMode: this.scaleMode, candles: { ...this.candles }, grid: this.grid, sessionBreaks: this.sessionBreaks, volCandles: { ...this.volCandles },
      indicators: this.inds.map((x) => JSON.parse(JSON.stringify(x.st))),
      panes: this.panes.map((p) => ({ id: p.id, ratio: p.ratio })),
    };
  }

  setState(s: Partial<ChartState>) {
    if (s.type) this.type = s.type;
    if (s.scaleMode) this.scaleMode = s.scaleMode;
    if (s.candles) this.candles = { ...s.candles };
    if (s.volCandles) this.volCandles = { base: clamp01(s.volCandles.base), effect: Number.isFinite(s.volCandles.effect) ? Math.max(0, Math.min(3, s.volCandles.effect)) : 1 };
    if (s.grid !== undefined) this.grid = s.grid;
    if (s.sessionBreaks !== undefined) this.sessionBreaks = s.sessionBreaks;
    if (s.indicators) {
      this.inds = [];
      for (const st of s.indicators) { const def = getIndicator(st.defId); if (def) this.inds.push({ st: this.fillState(def, st), def, out: {} }); }
    }
    if (s.showVolume && !this.hasVolume()) { const def = getIndicator('vol')!; this.inds.unshift({ st: this.fillState(def, { id: newId('i'), defId: 'vol', inputs: {}, plots: {}, visible: true, pane: 'main' }), def, out: {} }); }
    this.syncPanes(s.panes);
    this.recompute();
    this.invalidate();
  }

  /** Add a built-in indicator; returns its id. */
  addIndicator(defId: string, inputs: Record<string, number | string | boolean> = {}): string | undefined {
    const def = getIndicator(defId);
    if (!def) return undefined;
    const id = newId('i');
    const st = this.fillState(def, { id, defId, inputs, plots: {}, visible: true, pane: def.overlay ? 'main' : `p_${id}` });
    this.inds.push({ st, def, out: {} });
    this.syncPanes();
    this.recompute();
    this.emit({ type: 'stateChange' });
    this.invalidate();
    return id;
  }
  removeIndicator(id: string) {
    this.inds = this.inds.filter((x) => x.st.id !== id);
    this.syncPanes();
    this.renderLegendStructure();
    this.emit({ type: 'stateChange' });
    this.invalidate();
  }
  updateIndicator(id: string, patch: Partial<IndicatorState>) {
    const x = this.inds.find((i) => i.st.id === id);
    if (!x) return;
    Object.assign(x.st, patch);
    this.recompute();
    this.emit({ type: 'stateChange' });
    this.invalidate();
  }
  openIndicatorSettings(id: string) {
    const x = this.inds.find((i) => i.st.id === id);
    if (!x) return;
    this.dialog?.close();
    this.dialog = new IndicatorDialog(this.root, this.theme, x.def, x.st, (st) => this.updateIndicator(id, st), () => { this.dialog = null; });
  }

  /* drawings */
  setDrawings(list: Drawing[]) { this.drawings = JSON.parse(JSON.stringify(list)); this.selected = null; this.drawingBar.hide(); this.undoStack = []; this.redoStack = []; this.invalidate(); }
  getDrawings(): Drawing[] { return JSON.parse(JSON.stringify(this.drawings)); }
  setTool(type: string | null) { this.tool = type && getTool(type) ? type : null; this.creating = null; this.root.style.cursor = this.tool ? 'crosshair' : ''; this.invalidate(); }
  getTool(): string | null { return this.tool; }
  setMagnet(m: 'off' | 'weak' | 'strong') { this.magnet = m; }
  setDrawingsHidden(h: boolean) { this.drawingsHidden = h; if (h) { this.selected = null; this.drawingBar.hide(); } this.invalidate(); }
  deleteSelected() { if (!this.selected) return; this.pushUndo(); this.drawings = this.drawings.filter((d) => d !== this.selected); this.selected = null; this.drawingBar.hide(); this.emitDrawings(); this.invalidate(); }
  clearDrawings() { if (!this.drawings.length) return; this.pushUndo(); this.drawings = []; this.selected = null; this.drawingBar.hide(); this.emitDrawings(); this.invalidate(); }
  undo() { const s = this.undoStack.pop(); if (s === undefined) return; this.redoStack.push(JSON.stringify(this.drawings)); this.drawings = JSON.parse(s); this.selected = null; this.drawingBar.hide(); this.emitDrawings(); this.invalidate(); }
  redo() { const s = this.redoStack.pop(); if (s === undefined) return; this.undoStack.push(JSON.stringify(this.drawings)); this.drawings = JSON.parse(s); this.selected = null; this.drawingBar.hide(); this.emitDrawings(); this.invalidate(); }

  /* annotations (app-owned, grouped in layers) */
  setAnnotations(layer: string, a: Annotations | null) { if (a) this.layers.set(layer, a); else this.layers.delete(layer); this.invalidate(); }
  setLayerVisible(layer: string, on: boolean) { if (on) this.hiddenLayers.delete(layer); else this.hiddenLayers.add(layer); this.invalidate(); }

  /** Compare lines (another symbol at the same interval). Any compare puts the price scale in percent, as TradingView does. */
  setCompare(list: CompareSeries[]) {
    this.compare = list.map((s) => ({ ...s, byT: new Map(s.bars.map((b) => [b.t, b.c])) }));
    this.renderLegendStructure();
    this.panes[0].auto = true;
    this.invalidate();
  }

  /** Live orders / the position as lines (drag to move, ✕ to cancel); replaces the previous set and any drag preview. */
  setOrderLines(lines: OrderLine[]) { this.orders = lines.slice(); this.orderPreview = null; this.invalidate(); }
  /** Best bid / ask as dashed lines (undefined hides them). */
  setBidAsk(bid?: number, ask?: number) {
    if (this.bidAsk.bid === bid && this.bidAsk.ask === ask) return;
    this.bidAsk = { bid, ask };
    this.renderQuote();
    this.invalidate();
  }
  /** The position size shown in the quote box (TradingView's SELL | spread | BUY under the symbol). */
  setPositionQty(q: number | undefined) { if (this.posQty === q) return; this.posQty = q; this.renderQuote(); }

  /** SELL bid | spread over position | BUY ask, like TradingView's box under the symbol (display only) */
  private renderQuote() {
    const box = this.quoteEl;
    if (!box) return;
    const { bid, ask } = this.bidAsk;
    if (!(bid && ask)) { box.style.display = 'none'; return; }
    const f = (v: number) => fmtPrice(v, this.precision);
    const q = this.posQty;
    box.style.display = 'flex';
    box.innerHTML = '';
    const side = (price: number, label: string, bg: string) => el('div', { style: `display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:64px;padding:2px 8px;border-radius:5px;background:${bg};color:#fff;line-height:15px` }, [
      el('span', { style: 'font-weight:600;font-size:12.5px' }, [f(price)]), el('span', { style: 'font-size:10px;letter-spacing:.04em;opacity:.9' }, [label])]);
    box.append(
      side(bid, 'SELL', '#C93545'),
      el('div', { style: `display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:42px;padding:0 4px;line-height:15px;color:${this.theme.text}` }, [
        el('span', { style: `font-size:10.5px;color:${this.theme.textMuted}` }, [f(ask - bid)]),
        el('span', { title: 'Position size', style: `font-size:11.5px;font-weight:600;border:1px solid ${this.theme.panelBorder};border-radius:4px;padding:0 5px;color:${q ? (q > 0 ? this.theme.up : this.theme.down) : this.theme.textMuted}` }, [q ? `${q > 0 ? '+' : ''}${q}` : '0'])]),
      side(ask, 'BUY', '#2962FF'),
    );
  }

  /** true when a price or time scale was changed by hand (the reset button is worth showing) */
  isScaled(): boolean { return this.panes.some((p) => !p.auto) || Math.abs(this.right - (this.bars.length - 1 + RIGHT_GAP)) > 1; }

  /** Show another chart's crosshair time here (synced layouts). */
  setCrosshairTime(t: number | null) { this.extCross = t; this.invalidate(); }

  scrollToRealtime() { this.right = this.bars.length - 1 + RIGHT_GAP; this.invalidate(); }
  resetScales() { for (const p of this.panes) p.auto = true; this.scrollToRealtime(); }
  /** Show the bars between two times (inclusive). */
  showRange(from: number, to: number) {
    const a = indexAtOrBefore(this.bars, from), b = indexAtOrBefore(this.bars, to);
    if (a < 0 || b < 0) return;
    const n = Math.max(5, b - a + 1);
    this.spacing = Math.max(MIN_SPACING, Math.min(MAX_SPACING, (this.plotW || 600) / (n + 4)));
    this.right = b + 2;
    this.invalidate();
  }

  /** A PNG of the chart with the symbol and interval written on it. */
  screenshot(): string {
    this.render();
    const out = document.createElement('canvas');
    out.width = this.canvas.width; out.height = this.canvas.height;
    const c = out.getContext('2d')!;
    c.drawImage(this.canvas, 0, 0);
    c.scale(this.dpr, this.dpr);
    c.font = `600 13px ${this.theme.font.replace(/^\d+px\s*/, '')}`;
    c.fillStyle = this.theme.text; c.textBaseline = 'top';
    c.fillText(`${this.symbol} · ${intervalLabel(this.interval)}`, 10, 8);
    return out.toDataURL('image/png');
  }

  focus() { this.root.focus(); }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    clearInterval(this.clock);
    this.ro.disconnect();
    this.dialog?.close();
    this.root.remove();
    this.listeners.clear();
  }

  /* ======================= state helpers ======================= */

  private fillState(def: IndicatorDef, st: IndicatorState): IndicatorState {
    const inputs: IndicatorState['inputs'] = {};
    for (const i of def.inputs) inputs[i.key] = st.inputs?.[i.key] ?? i.default;
    const plots: IndicatorState['plots'] = {};
    for (const p of def.plots) plots[p.key] = { color: st.plots?.[p.key]?.color ?? p.color, width: st.plots?.[p.key]?.width ?? p.width ?? 2, visible: st.plots?.[p.key]?.visible ?? true, dash: st.plots?.[p.key]?.dash ?? 'solid' };
    return { id: st.id, defId: def.id, inputs, plots, visible: st.visible ?? true, pane: def.overlay ? 'main' : (st.pane && st.pane !== 'main' ? st.pane : `p_${st.id}`) };
  }

  private syncPanes(saved?: { id: string; ratio: number }[]) {
    const ids = ['main', ...new Set(this.inds.map((x) => x.st.pane).filter((p) => p !== 'main'))];
    const old = new Map(this.panes.map((p) => [p.id, p]));
    const ratio = new Map((saved ?? []).map((p) => [p.id, p.ratio]));
    for (const p of this.panes) p.legend?.remove();
    this.panes = ids.map((id) => {
      const o = old.get(id);
      return { id, ratio: ratio.get(id) ?? o?.ratio ?? (id === 'main' ? 3 : 1), top: 0, h: 0, min: o?.min ?? 0, max: o?.max ?? 1, auto: o?.auto ?? true };
    });
    this.renderLegendStructure();
  }

  private recompute() {
    this.bars = this.type === 'heikin' ? heikinAshi(this.raw) : this.raw;
    const ctx = { time: this.time, intervalMin: intervalMinutes(this.interval) };
    const intraday = isIntraday(this.interval);
    for (const x of this.inds) {
      try { x.out = x.def.intradayOnly && !intraday ? {} : x.def.compute(this.raw, x.st.inputs, ctx); }
      catch { x.out = {}; }
    }
    this.renderLegendStructure();
  }

  private pushUndo() { this.undoStack.push(JSON.stringify(this.drawings)); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = []; }
  private emitDrawings() { this.emit({ type: 'drawingsChange' }); }
  private patchSelected(patch: Partial<DrawingStyle>) {
    if (!this.selected) return;
    this.pushUndo();
    this.selected.style = { ...this.selected.style, ...patch };
    this.emitDrawings();
    this.invalidate();
  }
  private cloneSelected() {
    if (!this.selected) return;
    this.pushUndo();
    const d: Drawing = JSON.parse(JSON.stringify(this.selected));
    d.id = newId('d');
    const step = intervalSeconds(this.interval) * 3;
    d.points = d.points.map((p) => ({ t: p.t + step, p: p.p }));
    this.drawings.push(d);
    this.selected = d;
    this.drawingBar.show(d, getTool(d.type)!);
    this.emitDrawings();
    this.invalidate();
  }

  /* ======================= coordinates ======================= */

  private x(i: number) { return this.plotW - (this.right - i) * this.spacing; }
  private idx(x: number) { return this.right - (this.plotW - x) / this.spacing; }

  /** a time -> a (possibly fractional, possibly beyond the data) bar index */
  private tIdx(t: number): number {
    const n = this.bars.length;
    if (!n) return 0;
    const iv = intervalSeconds(this.interval);
    if (t > this.bars[n - 1].t) return n - 1 + (t - this.bars[n - 1].t) / iv;
    if (t < this.bars[0].t) return (t - this.bars[0].t) / iv;
    return indexAtOrBefore(this.bars, t);
  }
  /** a bar index -> a time (beyond the data the interval is stepped) */
  private idxT(i: number): number {
    const n = this.bars.length, iv = intervalSeconds(this.interval);
    if (!n) return 0;
    const k = Math.round(i);
    if (k >= n) return this.bars[n - 1].t + (k - n + 1) * iv;
    if (k < 0) return this.bars[0].t + k * iv;
    return this.bars[k].t;
  }

  /** the value shown on a pane's scale for a price (log / percent on the main pane) */
  private f(pane: Pane, v: number): number {
    if (pane.id !== 'main') return v;
    if (this.mode() === 'log') return Math.log(Math.max(1e-9, v));
    if (this.mode() === 'percent') { const b = this.base(); return b ? (v / b - 1) * 100 : v; }
    return v;
  }
  private fInv(pane: Pane, y: number): number {
    if (pane.id !== 'main') return y;
    if (this.mode() === 'log') return Math.exp(y);
    if (this.mode() === 'percent') { const b = this.base(); return b ? b * (1 + y / 100) : y; }
    return y;
  }
  private mode(): ScaleMode { return this.compare.length ? 'percent' : this.scaleMode; }
  private baseCache = { right: NaN, spacing: NaN, n: 0, v: 0 };
  private base(): number {
    const k = this.baseCache;
    if (k.right === this.right && k.spacing === this.spacing && k.n === this.bars.length) return k.v;
    const i = Math.max(0, Math.min(this.bars.length - 1, Math.ceil(this.idx(0))));
    k.right = this.right; k.spacing = this.spacing; k.n = this.bars.length; k.v = this.bars[i]?.c ?? 0;
    return k.v;
  }
  private yOf(pane: Pane, v: number) { return pane.top + ((pane.max - this.f(pane, v)) / (pane.max - pane.min || 1)) * pane.h; }
  private vOf(pane: Pane, y: number) { return this.fInv(pane, pane.max - ((y - pane.top) / (pane.h || 1)) * (pane.max - pane.min)); }
  private paneAt(y: number): Pane | undefined { return this.panes.find((p) => y >= p.top && y < p.top + p.h); }
  private main(): Pane { return this.panes[0]; }

  private anchorAt(x: number, y: number): Anchor {
    const m = this.main();
    const i = Math.round(this.idx(x));
    let p = this.vOf(m, y);
    if (this.magnet !== 'off' && i >= 0 && i < this.bars.length) {
      const b = this.bars[i];
      let best = p, dist = Infinity;
      for (const v of [b.o, b.h, b.l, b.c]) { const d = Math.abs(this.yOf(m, v) - y); if (d < dist) { dist = d; best = v; } }
      if (this.magnet === 'strong' || dist < 14) p = best;
    }
    return { t: this.idxT(i), p };
  }

  private env(d: Drawing): DrawEnv {
    const m = this.main();
    return {
      width: this.plotW, height: this.plotH, theme: this.theme, selected: d === this.selected,
      price: (y) => this.vOf(m, y), y: (p) => this.yOf(m, p), fmt: (p) => fmtPrice(p, this.precision),
      span: (t1, t2) => {
        const a = Math.round(this.tIdx(t1)), b = Math.round(this.tIdx(t2));
        let vol = 0;
        for (let i = Math.max(0, Math.min(a, b)); i <= Math.min(this.bars.length - 1, Math.max(a, b)); i++) vol += this.bars[i].v;
        return { bars: b - a, volume: vol, seconds: t2 - t1 || intervalSeconds(this.interval) };
      },
    };
  }
  private pts(d: Drawing): Pt[] { const m = this.main(); return d.points.map((a) => ({ x: this.x(this.tIdx(a.t)), y: this.yOf(m, a.p) })); }

  /* ======================= events ======================= */

  private bind() {
    const cv = this.canvas;
    const pos = (e: PointerEvent | WheelEvent | MouseEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cv.addEventListener('pointerdown', (e) => {
      this.root.focus({ preventScroll: true });
      this.emit({ type: 'focus' });
      if (e.button !== 0) return;
      const { x, y } = pos(e);
      cv.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch') {
        this.touches.set(e.pointerId, { x, y });
        if (this.touches.size === 2) {
          // two fingers: pinch to zoom the time scale around their middle
          const [a, b] = [...this.touches.values()];
          const mx = (a.x + b.x) / 2;
          this.drag = { kind: 'pinch', d0: Math.max(10, Math.abs(a.x - b.x)), spacing: this.spacing, i0: this.idx(mx), x0: mx };
          return;
        }
      }
      this.downAt = { x, y };
      this.onDown(x, y, e);
    });
    cv.addEventListener('pointermove', (e) => {
      const { x, y } = pos(e);
      if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) this.touches.set(e.pointerId, { x, y });
      const dr = this.drag;
      if (dr?.kind === 'pinch') {
        const [a, b] = [...this.touches.values()];
        if (a && b) {
          this.spacing = Math.max(MIN_SPACING, Math.min(MAX_SPACING, dr.spacing * (Math.max(10, Math.abs(a.x - b.x)) / dr.d0)));
          this.right = dr.i0 + (this.plotW - dr.x0) / this.spacing;
          this.clampRight();
          this.invalidate();
        }
        return;
      }
      this.mouse = { x, y };
      this.onMove(x, y);
    });
    const up = (e: PointerEvent) => {
      const { x, y } = pos(e);
      try { cv.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      this.touches.delete(e.pointerId);
      if (this.drag?.kind === 'pinch') { if (this.touches.size === 0) this.drag = null; return; }
      this.onUp(x, y);
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { if (!this.drag) { this.mouse = null; this.tooltip.style.display = 'none'; this.emit({ type: 'crosshair', t: null }); this.invalidate(); } });
    cv.addEventListener('dblclick', (e) => {
      const { x, y } = pos(e);
      const pane = this.paneAt(y);
      if (x > this.plotW && pane) { pane.auto = true; this.invalidate(); return; }
      if (y > this.plotH) { this.spacing = 8; this.scrollToRealtime(); return; }
      const hit = this.hitDrawing(x, y);
      if (hit && getTool(hit.type)?.type === 'text') { const t = prompt('Text', hit.style.text ?? ''); if (t !== null) { this.selected = hit; this.patchSelected({ text: t }); } }
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x, y } = pos(e);
      if (x > this.plotW) {
        const pane = this.paneAt(y);
        if (pane) { const k = Math.exp(e.deltaY * 0.002), mid = (pane.max + pane.min) / 2, half = ((pane.max - pane.min) / 2) * k; pane.auto = false; pane.min = mid - half; pane.max = mid + half; this.invalidate(); }
        return;
      }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) { this.right += (e.shiftKey ? e.deltaY : e.deltaX) / this.spacing; this.clampRight(); this.invalidate(); return; }
      const i0 = this.idx(x);
      this.spacing = Math.max(MIN_SPACING, Math.min(MAX_SPACING, this.spacing * Math.exp(-e.deltaY * 0.0015)));
      this.right = i0 + (this.plotW - x) / this.spacing;
      this.clampRight();
      this.invalidate();
    }, { passive: false });
    cv.addEventListener('contextmenu', (e) => { if (this.tool || this.creating) { e.preventDefault(); this.creating = null; this.setTool(null); this.emit({ type: 'toolDone' }); } });
    this.root.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); this.redo(); return; }
      if (k === 'delete' || k === 'backspace') { if (this.selected) { e.preventDefault(); this.deleteSelected(); } return; }
      if (k === 'escape') { if (this.creating || this.tool) { this.creating = null; this.setTool(null); this.emit({ type: 'toolDone' }); } else if (this.selected) { this.selected = null; this.drawingBar.hide(); this.emit({ type: 'select', drawing: null }); this.invalidate(); } return; }
      if (e.altKey && k === 'r') { e.preventDefault(); this.resetScales(); }
      if (k === 'arrowleft' || k === 'arrowright') { e.preventDefault(); this.right += (k === 'arrowleft' ? -1 : 1) * Math.max(1, 40 / this.spacing); this.clampRight(); this.invalidate(); }
    });
  }

  private clampRight() {
    const n = this.bars.length;
    const visible = this.plotW / this.spacing;
    this.right = Math.max(Math.min(5, n - 1), Math.min(n - 1 + visible * 0.8, this.right));
  }

  private hitDrawing(x: number, y: number): Drawing | null {
    if (this.drawingsHidden || y > this.main().top + this.main().h) return null;
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i], t = getTool(d.type);
      if (!t || d.hidden) continue;
      if (t.hit(this.pts(d), x, y, d, this.env(d))) return d;
    }
    return null;
  }
  private handlesOf(d: Drawing): Pt[] { const t = getTool(d.type)!; const p = this.pts(d); return t.handles ? t.handles(p, d, this.env(d)) : p; }

  private hitMarker(x: number, y: number): Marker | null {
    for (const [name, a] of this.layers) {
      if (this.hiddenLayers.has(name)) continue;
      for (const m of a.markers ?? []) { const p = this.markerPos(m); if (p && Math.hypot(p.x - x, p.y - y) < 9) return m; }
    }
    return null;
  }

  private onDown(x: number, y: number, e: PointerEvent) {
    const pane = this.paneAt(y);
    // separators
    for (let k = 1; k < this.panes.length; k++) {
      const p = this.panes[k];
      if (Math.abs(y - p.top) < 4 && x < this.plotW) { this.drag = { kind: 'sep', y, a: this.panes[k - 1], b: p, ra: this.panes[k - 1].ratio, rb: p.ratio, ha: this.panes[k - 1].h, hb: p.h }; return; }
    }
    if (y > this.plotH) { this.drag = { kind: 'time', x, spacing: this.spacing }; return; }
    if (x > this.plotW) { if (pane) this.drag = { kind: 'price', y, pane, min: pane.min, max: pane.max }; return; }
    const main = this.main();
    const inMain = y < main.top + main.h;
    // live order lines: ✕ cancels, the box or the line drags
    if (inMain && !this.tool) {
      const hit = this.hitOrder(x, y);
      if (hit) {
        if (hit.part === 'x') { this.emit({ type: 'orderCancel', id: hit.line.id }); return; }
        if (hit.line.draggable) { this.drag = { kind: 'order', id: hit.line.id, y0: y, p0: hit.line.price, moved: false }; return; }
      }
    }
    // placing a drawing
    if (this.tool && inMain) {
      const def = getTool(this.tool)!;
      const a = this.anchorAt(x, y);
      if (def.points === 0) {
        const d: Drawing = { id: newId('d'), type: def.type, points: [a], style: this.styleFor(def.type) };
        this.creating = d;
        this.drag = { kind: 'brush', d };
        return;
      }
      if (!this.creating) {
        const d: Drawing = { id: newId('d'), type: def.type, points: [a], style: this.styleFor(def.type) };
        if (def.points === 1) { this.finishCreate(d); return; }
        d.points.push({ ...a });
        this.creating = d;
      } else {
        this.creating.points[this.creating.points.length - 1] = a;
        if (this.creating.points.length >= def.points) this.finishCreate(this.creating);
        else this.creating.points.push({ ...a });
      }
      this.invalidate();
      return;
    }
    // handles of the selected drawing
    if (this.selected && !this.selected.locked && !this.drawingsHidden) {
      const hs = this.handlesOf(this.selected);
      const h = hs.findIndex((p) => Math.hypot(p.x - x, p.y - y) < 8);
      if (h >= 0) { this.pushUndo(); this.drag = { kind: 'handle', d: this.selected, h, moved: false }; return; }
    }
    const hit = inMain ? this.hitDrawing(x, y) : null;
    if (hit) {
      this.select(hit);
      if (!hit.locked) { this.pushUndo(); this.drag = { kind: 'move', d: hit, orig: hit.points.map((p) => ({ ...p })), at: { i: this.idx(x), p: this.vOf(main, y) }, moved: false }; }
      return;
    }
    const mk = this.hitMarker(x, y);
    if (mk) { this.emit({ type: 'markerClick', marker: mk }); return; }
    if (this.selected) { this.selected = null; this.drawingBar.hide(); this.emit({ type: 'select', drawing: null }); }
    if (pane) this.drag = { kind: 'pan', x, y, right: this.right, pane, min: pane.min, max: pane.max };
    void e;
    this.invalidate();
  }

  private styleFor(type: string): DrawingStyle {
    const def = getTool(type)!;
    return { color: type === 'measure' ? '#2962FF' : this.theme.accent, width: 2, dash: 'solid', ...def.defaultStyle } as DrawingStyle;
  }

  private finishCreate(d: Drawing) {
    const def = getTool(d.type)!;
    def.init?.(d, this.env(d));
    if (d.type === 'text') { const t = prompt('Text', d.style.text ?? 'Text'); if (t === null || !t.trim()) { this.creating = null; this.setTool(null); this.emit({ type: 'toolDone' }); return; } d.style.text = t; }
    this.pushUndo();
    this.drawings.push(d);
    this.creating = null;
    this.select(d);
    this.setTool(null);
    this.emit({ type: 'toolDone' });
    this.emitDrawings();
    this.invalidate();
  }

  private select(d: Drawing) {
    this.selected = d;
    this.drawingBar.show(d, getTool(d.type)!);
    this.emit({ type: 'select', drawing: d });
    this.invalidate();
  }

  private onMove(x: number, y: number) {
    const dr = this.drag;
    if (dr) {
      switch (dr.kind) {
        case 'pan': {
          this.right = dr.right - (x - dr.x) / this.spacing;
          this.clampRight();
          if (!dr.pane.auto) { const dv = ((y - dr.y) / dr.pane.h) * (dr.max - dr.min); dr.pane.min = dr.min + dv; dr.pane.max = dr.max + dv; }
          this.root.style.cursor = 'grabbing';
          break;
        }
        case 'price': {
          const k = Math.exp((y - dr.y) * 0.006), mid = (dr.max + dr.min) / 2, half = ((dr.max - dr.min) / 2) * k;
          dr.pane.auto = false; dr.pane.min = mid - half; dr.pane.max = mid + half;
          break;
        }
        case 'time': {
          this.spacing = Math.max(MIN_SPACING, Math.min(MAX_SPACING, dr.spacing * Math.exp((x - dr.x) * 0.008)));
          this.clampRight();
          break;
        }
        case 'sep': {
          const total = dr.ra + dr.rb, hh = dr.ha + dr.hb;
          const ha = Math.max(30, Math.min(hh - 30, dr.ha + (y - dr.y)));
          dr.a.ratio = (total * ha) / hh; dr.b.ratio = total - dr.a.ratio;
          break;
        }
        case 'move': {
          const m = this.main(), di = Math.round(this.idx(x) - dr.at.i), dp = this.vOf(m, y) - dr.at.p;
          dr.moved = true;
          dr.d.points = dr.orig.map((a) => ({ t: this.idxT(Math.round(this.tIdx(a.t)) + di), p: a.p + dp }));
          break;
        }
        case 'handle': {
          dr.moved = true;
          const def = getTool(dr.d.type)!, at = this.anchorAt(x, y);
          if (def.moveHandle) def.moveHandle(dr.d, dr.h, at, this.env(dr.d)); else dr.d.points[dr.h] = at;
          break;
        }
        case 'order': {
          const m = this.main();
          const p = Math.round(this.vOf(m, y) / this.tick) * this.tick;
          if (Math.abs(y - dr.y0) > 2) dr.moved = true;
          this.orderPreview = { id: dr.id, price: Math.round(p * 100) / 100 };
          this.root.style.cursor = 'ns-resize';
          break;
        }
        case 'pinch': break;
        case 'brush': {
          const last = dr.d.points[dr.d.points.length - 1], a = this.anchorAt(x, y);
          const lp = { x: this.x(this.tIdx(last.t)), y: this.yOf(this.main(), last.p) };
          if (Math.hypot(lp.x - x, lp.y - y) > 3) dr.d.points.push({ t: a.t, p: this.vOf(this.main(), y) });
          break;
        }
      }
      this.invalidate();
      return;
    }
    if (this.creating) {
      const a = this.anchorAt(x, y);
      this.creating.points[this.creating.points.length - 1] = a;
    }
    // cursor + tooltip
    let cursor = this.tool ? 'crosshair' : 'crosshair';
    this.tooltip.style.display = 'none';
    if (x > this.plotW) cursor = 'ns-resize';
    else if (y > this.plotH) cursor = 'ew-resize';
    else if (this.panes.slice(1).some((p) => Math.abs(y - p.top) < 4)) cursor = 'row-resize';
    else if (!this.tool && this.hitOrder(x, y)) { const h = this.hitOrder(x, y)!; cursor = h.part === 'x' ? 'pointer' : h.line.draggable ? 'ns-resize' : 'default'; }
    else if (!this.tool) {
      if (this.selected && this.handlesOf(this.selected).some((p) => Math.hypot(p.x - x, p.y - y) < 8)) cursor = 'move';
      else if (this.hitDrawing(x, y)) cursor = 'pointer';
      else {
        const mk = this.hitMarker(x, y);
        if (mk) {
          cursor = 'pointer';
          if (mk.tooltip) {
            this.tooltip.textContent = mk.tooltip;
            this.tooltip.style.display = 'block';
            const tx = Math.min(x + 14, this.W - 290);
            this.tooltip.style.left = `${Math.max(4, tx)}px`; this.tooltip.style.top = `${Math.max(4, y - 10)}px`;
          }
        }
      }
    }
    this.root.style.cursor = cursor;
    const t = x < this.plotW && y < this.plotH && this.bars.length ? this.idxT(Math.round(this.idx(x))) : null;
    const pane = this.paneAt(y);
    this.emit({ type: 'crosshair', t, price: pane === this.main() ? this.vOf(this.main(), y) : undefined });
    this.invalidate();
  }

  private onUp(x: number, y: number) {
    const dr = this.drag;
    this.drag = null;
    this.root.style.cursor = '';
    if (dr?.kind === 'order') {
      if (dr.moved && this.orderPreview && this.orderPreview.price !== dr.p0) this.emit({ type: 'orderMove', id: dr.id, price: this.orderPreview.price, from: dr.p0 });
      else this.orderPreview = null;
    } else if (dr?.kind === 'brush') {
      if (dr.d.points.length > 1) { this.pushUndo(); this.drawings.push(dr.d); this.select(dr.d); this.emitDrawings(); }
      this.creating = null; this.setTool(null); this.emit({ type: 'toolDone' });
    } else if (dr && (dr.kind === 'move' || dr.kind === 'handle')) {
      if (dr.moved) this.emitDrawings(); else this.undoStack.pop();
    } else if (dr?.kind === 'sep') this.emit({ type: 'stateChange' });
    // press-drag-release places a two-point drawing in one go
    if (this.creating && this.downAt && Math.hypot(x - this.downAt.x, y - this.downAt.y) > 6 && this.creating.points.length === 2 && getTool(this.creating.type)!.points === 2) {
      this.creating.points[1] = this.anchorAt(x, y);
      this.finishCreate(this.creating);
    }
    this.downAt = null;
    this.invalidate();
  }

  /* ======================= rendering ======================= */

  invalidate() {
    if (this.destroyed || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  private layout() {
    const r = this.root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(50, Math.floor(r.width)), H = Math.max(50, Math.floor(r.height));
    if (W !== this.W || H !== this.H || dpr !== this.dpr) {
      const keepRightEdge = this.plotW;
      this.W = W; this.H = H; this.dpr = dpr;
      this.canvas.width = W * dpr; this.canvas.height = H * dpr;
      if (!keepRightEdge && this.bars.length) this.right = this.bars.length - 1 + RIGHT_GAP;
    }
    this.plotW = this.W - AXIS_W; this.plotH = this.H - TIME_H;
    const total = this.panes.reduce((a, p) => a + p.ratio, 0);
    let top = 0;
    this.panes.forEach((p, i) => {
      p.top = top;
      p.h = i === this.panes.length - 1 ? this.plotH - top : Math.round((p.ratio / total) * this.plotH);
      top += p.h;
    });
  }

  private visible(): [number, number] {
    const n = this.bars.length;
    return [Math.max(0, Math.floor(this.idx(0))), Math.min(n - 1, Math.ceil(this.idx(this.plotW)))];
  }

  private autoscale(from: number, to: number) {
    for (const pane of this.panes) {
      if (!pane.auto) continue;
      let lo = Infinity, hi = -Infinity;
      const take = (v: number) => { if (Number.isFinite(v)) { const f = this.f(pane, v); if (f < lo) lo = f; if (f > hi) hi = f; } };
      if (pane.id === 'main') {
        for (let i = from; i <= to; i++) { const b = this.bars[i]; if (this.type === 'line' || this.type === 'area') take(b.c); else { take(b.h); take(b.l); } }
        for (const s of this.compare) { const b0 = this.compareBase(s); for (let i = from; i <= to; i++) { const v = this.compareAt(s, i, b0); if (v !== undefined) take(v); } }
      }
      let fixed: [number, number] | undefined;
      for (const x of this.inds) {
        if (x.st.pane !== pane.id || !x.st.visible || x.def.special) continue;
        if (x.def.range) fixed = x.def.range;
        for (const p of x.def.plots) {
          if (!x.st.plots[p.key]?.visible) continue;
          const a = x.out[p.key]; if (!a) continue;
          const abs = p.kind === 'columns';
          for (let i = from; i <= to; i++) take(abs ? Math.abs(a[i]) : a[i]);
          if (p.kind === 'histogram' || abs) take(0);
        }
      }
      if (fixed && pane.id !== 'main') { lo = Math.min(lo, fixed[0]); hi = Math.max(hi, fixed[1]); }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
      if (hi - lo < 1e-9) { const m = Math.abs(hi) * 0.01 || 1; hi += m; lo -= m; }
      const pad = (hi - lo) * (pane.id === 'main' ? 0.08 : 0.1);
      pane.min = lo - pad; pane.max = hi + pad;
      const vol = pane.id === 'main' ? this.inds.find((x) => x.def.special === 'volume' && x.st.visible) : undefined;
      if (vol) { const f = Math.min(0.6, (Number(vol.st.inputs.height) || 18) / 100); pane.min -= ((hi - lo + 2 * pad) * f) / (1 - f) * 0.7; } // room for the volume columns
    }
  }

  private compareBase(s: { byT: Map<number, number> }): number {
    const i = Math.max(0, Math.ceil(this.idx(0)));
    for (let k = i; k < this.bars.length; k++) { const v = s.byT.get(this.bars[k].t); if (v !== undefined) return v; }
    return NaN;
  }
  /** the compare symbol at bar i, put on the main symbol's price scale (same % move from the first bar in view) */
  private compareAt(s: { byT: Map<number, number> }, i: number, base: number): number | undefined {
    const b = this.bars[i]; if (!b) return undefined;
    const v = s.byT.get(b.t);
    if (v === undefined || !Number.isFinite(base)) return undefined;
    return this.base() * (v / base);
  }

  private render() {
    if (this.destroyed) return;
    this.layout();
    const c = this.c, th = this.theme;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.font = th.font;
    c.fillStyle = th.bg;
    c.fillRect(0, 0, this.W, this.H);
    if (!this.bars.length) {
      c.fillStyle = th.textMuted; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('No data', this.plotW / 2, this.plotH / 2);
      this.drawAxesFrame();
      this.updateLegendValues(-1);
      return;
    }
    this.clampRight();
    const [from, to] = this.visible();
    if (from < 30 && this.historyAsked === 0 && this.raw.length) { this.historyAsked = 1; this.emit({ type: 'needHistory', before: this.raw[0].t }); }
    this.autoscale(from, to);
    const ticks = this.timeTicks(from, to);

    // grid
    c.lineWidth = 1;
    c.strokeStyle = th.grid;
    c.setLineDash([]);
    c.beginPath();
    if (this.grid) for (const tk of ticks) { const x = Math.round(this.x(tk.i)) + 0.5; c.moveTo(x, 0); c.lineTo(x, this.plotH); }
    if (this.grid) for (const p of this.panes) for (const v of this.priceTicks(p)) { const y = Math.round(p.top + ((p.max - v) / (p.max - p.min)) * p.h) + 0.5; c.moveTo(0, y); c.lineTo(this.plotW, y); }
    c.stroke();
    // session breaks (intraday)
    if (this.sessionBreaks && isIntraday(this.interval) && intervalMinutes(this.interval) < 240) {
      // session breaks: a dashed yellow line where a new day starts
      c.strokeStyle = 'rgba(245,197,66,0.7)'; c.lineWidth = 1; c.setLineDash([5, 4]); c.beginPath();
      for (let i = Math.max(1, from); i <= to; i++) {
        if (localDayStart(this.bars[i].t, this.time.tzOffsetSec) !== localDayStart(this.bars[i - 1].t, this.time.tzOffsetSec)) { const x = Math.round(this.x(i - 0.5)) + 0.5; c.moveTo(x, 0); c.lineTo(x, this.plotH); }
      }
      c.stroke(); c.setLineDash([]);
    }

    for (const pane of this.panes) {
      c.save();
      c.beginPath(); c.rect(0, pane.top, this.plotW, pane.h); c.clip();
      if (pane.id === 'main') {
        this.drawZones(pane);
        for (const x of this.inds) if (x.st.pane === 'main' && x.st.visible && x.def.special === 'volume') this.drawVolume(pane, x, from, to);
        for (const x of this.inds) if (x.st.pane === 'main' && x.st.visible && x.def.special === 'vpvr') this.drawVpvr(pane, x, from, to);
        this.drawSeries(pane, from, to);
        for (const x of this.inds) if (x.st.pane === 'main' && x.st.visible && !x.def.special) this.drawIndicator(pane, x, from, to);
        this.drawCompare(pane, from, to);
        this.drawLevels(pane);
        this.drawLastPriceLine(pane);
        this.drawBidAsk(pane);
        this.drawMarkers();
        if (!this.drawingsHidden) this.drawDrawings();
        this.drawOrders(pane);
      } else {
        for (const x of this.inds) if (x.st.pane === pane.id && x.st.visible) this.drawIndicator(pane, x, from, to);
      }
      c.restore();
    }
    // pane separators
    c.strokeStyle = th.axisLine; c.lineWidth = 1; c.beginPath();
    for (const p of this.panes.slice(1)) { c.moveTo(0, p.top + 0.5); c.lineTo(this.W, p.top + 0.5); }
    c.stroke();
    this.drawAxesFrame();
    this.drawPriceAxes();
    this.drawTimeAxis(ticks);
    this.drawCrosshair();
    this.positionLegends();
    this.cornerBtn.style.color = this.isScaled() ? this.theme.accent : this.theme.textMuted;
    this.liveBtn.style.display = this.right < this.bars.length - 1 - 2 ? 'flex' : 'none';
    const hover = this.mouse && this.mouse.x < this.plotW && this.mouse.y < this.plotH ? Math.round(this.idx(this.mouse.x)) : this.extCross !== null ? Math.round(this.tIdx(this.extCross)) : -1;
    this.updateLegendValues(hover >= 0 && hover < this.bars.length ? hover : this.bars.length - 1);
  }

  private drawAxesFrame() {
    const c = this.c, th = this.theme;
    c.strokeStyle = th.axisLine; c.lineWidth = 1; c.setLineDash([]);
    c.beginPath(); c.moveTo(this.plotW + 0.5, 0); c.lineTo(this.plotW + 0.5, this.H); c.moveTo(0, this.plotH + 0.5); c.lineTo(this.W, this.plotH + 0.5); c.stroke();
  }

  private priceTicks(p: Pane): number[] {
    const step = niceStep(p.max - p.min, Math.max(2, p.h / 45));
    const out: number[] = [];
    for (let v = Math.ceil(p.min / step) * step; v <= p.max; v += step) out.push(v);
    return out;
  }

  /** time-axis ticks: important ones first (year > month > day > hour > half hour), never closer than ~80 px */
  private timeTicks(from: number, to: number): { i: number; w: number }[] {
    const tz = this.time.tzOffsetSec, cand: { i: number; w: number }[] = [];
    const intraday = isIntraday(this.interval);
    for (let i = Math.max(0, from); i <= to; i++) {
      const a = localParts(this.bars[i].t, tz), b = i ? localParts(this.bars[i - 1].t, tz) : null;
      let w = 0;
      if (!b || a.y !== b.y) w = 5;
      else if (a.mo !== b.mo) w = 4;
      else if (a.d !== b.d) w = 3;
      else if (intraday && Math.floor(a.min / 60) !== Math.floor(b.min / 60)) w = 2;
      else if (intraday && Math.floor(a.min / 30) !== Math.floor(b.min / 30)) w = 1;
      if (!intraday && w === 3) w = 1;
      if (!intraday && /W$|M$/.test(this.interval) && w < 4) w = 0;
      if (w > 0) cand.push({ i, w });
    }
    const minGap = 80;
    const picked: { i: number; w: number }[] = [];
    for (const t of [...cand].sort((p, q) => q.w - p.w || p.i - q.i)) {
      const x = this.x(t.i);
      if (picked.every((p) => Math.abs(this.x(p.i) - x) >= minGap)) picked.push(t);
    }
    return picked.sort((p, q) => p.i - q.i);
  }

  private drawSeries(pane: Pane, from: number, to: number) {
    const c = this.c, th = this.theme, sp = this.spacing;
    const bw = Math.max(1, Math.round(sp * 0.72) - (sp > 4 ? 1 : 0));
    // volume candles (TradingView's): every candle gets a base body (a third of its slot, so it still reads as a candle),
    // and the rest of the slot fills in proportion to its volume against the biggest volume in view. Relative, not
    // absolute: zooming or scrolling rescales to what is on screen.
    let vmax = 0;
    if (this.type === 'volume') for (let i = from; i <= to; i++) vmax = Math.max(vmax, this.bars[i].v);
    const { base, effect } = this.volCandles;
    const widthOf = (v: number) => {
      if (this.type !== 'volume' || !(vmax > 0)) return bw;
      const full = Math.max(1, sp * 0.94 - (sp > 4 ? 1 : 0));
      // effect up to 1: volume fills that much of the rest of the slot; above 1: a contrast curve (quiet candles get
      // thinner, the busiest still fill their slot)
      const ratio = Math.min(1, v / vmax);
      const share = effect <= 1 ? effect * ratio : Math.pow(ratio, effect);
      return Math.max(Math.min(2, full), Math.round(full * (base + (1 - base) * share)));
    };
    if (this.type === 'line' || this.type === 'area') {
      c.beginPath();
      for (let i = from; i <= to; i++) { const x = this.x(i), y = this.yOf(pane, this.bars[i].c); if (i === from) c.moveTo(x, y); else c.lineTo(x, y); }
      if (this.type === 'area') {
        c.save();
        const g = c.createLinearGradient(0, pane.top, 0, pane.top + pane.h);
        g.addColorStop(0, 'rgba(223,177,91,0.28)'); g.addColorStop(1, 'rgba(223,177,91,0.02)');
        c.lineTo(this.x(to), pane.top + pane.h); c.lineTo(this.x(from), pane.top + pane.h); c.closePath();
        c.fillStyle = g; c.fill();
        c.restore();
        c.beginPath();
        for (let i = from; i <= to; i++) { const x = this.x(i), y = this.yOf(pane, this.bars[i].c); if (i === from) c.moveTo(x, y); else c.lineTo(x, y); }
      }
      c.strokeStyle = th.line; c.lineWidth = 2; c.setLineDash([]); c.stroke();
      return;
    }
    for (let i = from; i <= to; i++) {
      const b = this.bars[i], up = b.c >= b.o;
      const x = Math.round(this.x(i));
      const yo = this.yOf(pane, b.o), yc = this.yOf(pane, b.c), yh = this.yOf(pane, b.h), yl = this.yOf(pane, b.l);
      const cs = this.candles;
      if (this.type === 'bars') {
        c.strokeStyle = up ? cs.upBorder : cs.downBorder; c.lineWidth = Math.max(1, Math.min(2, sp / 6));
        c.beginPath(); c.moveTo(x + 0.5, yh); c.lineTo(x + 0.5, yl);
        const tick = Math.max(2, bw / 2);
        c.moveTo(x - tick, yo); c.lineTo(x + 0.5, yo); c.moveTo(x + 0.5, yc); c.lineTo(x + tick + 1, yc); c.stroke();
        continue;
      }
      c.fillStyle = up ? cs.upWick : cs.downWick;
      c.fillRect(x, Math.round(yh), 1, Math.max(1, Math.round(yl) - Math.round(yh)));
      const top = Math.round(Math.min(yo, yc)), h = Math.max(1, Math.round(Math.abs(yc - yo)));
      const w = widthOf(b.v);
      const left = x - Math.floor(w / 2);
      const hollow = this.type === 'hollow' && up;
      c.fillStyle = hollow ? th.bg : up ? cs.upBody : cs.downBody;
      c.fillRect(left, top, w, h);
      // the outline (always for hollow up candles); at 1-2 px wide a candle is all outline anyway
      if ((cs.border || hollow) && w >= 3) {
        c.strokeStyle = up ? cs.upBorder : cs.downBorder; c.lineWidth = 1;
        c.strokeRect(left + 0.5, top + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
      } else if (cs.border && w < 3) { c.fillStyle = up ? cs.upBorder : cs.downBorder; c.fillRect(left, top, w, h); }
    }
  }

  private drawVolume(pane: Pane, x: Ind, from: number, to: number) {
    const c = this.c;
    let max = 0;
    for (let i = from; i <= to; i++) max = Math.max(max, this.raw[i]?.v ?? 0);
    if (!max) return;
    const ps = x.st.plots;
    const h = pane.h * Math.min(0.6, (Number(x.st.inputs.height) || 18) / 100), base = pane.top + pane.h;
    const bw = Math.max(1, Math.round(this.spacing * 0.72) - (this.spacing > 4 ? 1 : 0));
    for (let i = from; i <= to; i++) {
      const b = this.raw[i]; if (!b) continue;
      const up = b.c >= b.o, p = up ? ps.up : ps.down;
      if (!p?.visible) continue;
      const vh = (b.v / max) * h;
      c.fillStyle = p.color;
      c.fillRect(Math.round(this.x(i)) - Math.floor(bw / 2), base - vh, bw, vh);
    }
    const ma = x.out.ma;
    if (ma && ps.ma?.visible) {
      c.strokeStyle = ps.ma.color; c.lineWidth = ps.ma.width; c.setLineDash([]);
      c.beginPath();
      let pen = false;
      for (let i = from; i <= to; i++) { const v = ma[i]; if (!Number.isFinite(v)) { pen = false; continue; } const y = base - (v / max) * h; if (pen) c.lineTo(this.x(i), y); else { c.moveTo(this.x(i), y); pen = true; } }
      c.stroke();
    }
  }

  private drawIndicator(pane: Pane, x: Ind, from: number, to: number) {
    const c = this.c;
    const yv = (v: number) => (pane.id === 'main' ? this.yOf(pane, v) : pane.top + ((pane.max - v) / (pane.max - pane.min || 1)) * pane.h);
    const valOf = (k: string | number, i: number) => (typeof k === 'number' ? k : x.out[k]?.[i]);
    // fills first
    for (const f of x.def.fills ?? []) {
      if (typeof f.a === 'string' && !x.st.plots[f.a]?.visible) continue;
      c.fillStyle = f.color;
      if (typeof f.a === 'number' && typeof f.b === 'number') { const y1 = yv(f.a), y2 = yv(f.b); c.fillRect(0, Math.min(y1, y2), this.plotW, Math.abs(y2 - y1)); continue; }
      let run: number[] = [];
      const flush = () => {
        if (run.length > 1) {
          c.beginPath();
          run.forEach((i, k) => { const px = this.x(i), py = yv(valOf(f.a, i)!); if (k) c.lineTo(px, py); else c.moveTo(px, py); });
          for (let k = run.length - 1; k >= 0; k--) c.lineTo(this.x(run[k]), yv(valOf(f.b, run[k])!));
          c.closePath(); c.fill();
        }
        run = [];
      };
      for (let i = from; i <= to; i++) { const a = valOf(f.a, i), b = valOf(f.b, i); if (Number.isFinite(a) && Number.isFinite(b)) run.push(i); else flush(); }
      flush();
    }
    for (const h of x.def.hlines ?? []) {
      const y = Math.round(yv(h.value)) + 0.5;
      c.strokeStyle = h.color ?? this.theme.textMuted; c.lineWidth = 1; c.setLineDash(h.dash === 'solid' ? [] : h.dash === 'dotted' ? [1, 3] : [4, 4]);
      c.beginPath(); c.moveTo(0, y); c.lineTo(this.plotW, y); c.stroke();
    }
    c.setLineDash([]);
    for (const p of x.def.plots) {
      const ps = x.st.plots[p.key];
      const a = x.out[p.key];
      if (!ps?.visible || !a) continue;
      const kind = p.kind ?? 'line';
      if (kind === 'histogram' || kind === 'columns') {
        const zero = yv(0), bw = Math.max(1, Math.round(this.spacing * (kind === 'columns' ? 0.72 : 0.5)));
        for (let i = from; i <= to; i++) {
          const v = a[i]; if (!Number.isFinite(v)) continue;
          const shown = kind === 'columns' ? Math.abs(v) : v;
          const y = yv(shown);
          let col = ps.color;
          if (p.signColors) {
            const prev = a[i - 1];
            const rising = Number.isFinite(prev) ? Math.abs(v) >= Math.abs(prev) : true;
            col = v >= 0 ? (rising || !p.signColors[2] ? p.signColors[0] : p.signColors[2]) : (rising || !p.signColors[3] ? p.signColors[1] : p.signColors[3]);
          }
          c.fillStyle = col;
          c.fillRect(Math.round(this.x(i)) - Math.floor(bw / 2), Math.min(y, zero), bw, Math.max(1, Math.abs(zero - y)));
        }
        continue;
      }
      c.strokeStyle = ps.color; c.fillStyle = ps.color; c.lineWidth = ps.width;
      c.setLineDash(ps.dash === 'dashed' ? [6, 4] : ps.dash === 'dotted' ? [1.5, 3] : []);
      if (kind === 'dots') {
        for (let i = from; i <= to; i++) { const v = a[i]; if (Number.isFinite(v)) { c.beginPath(); c.arc(this.x(i), yv(v), Math.max(1.5, Math.min(3, this.spacing / 4)), 0, Math.PI * 2); c.fill(); } }
        continue;
      }
      c.beginPath();
      let pen = false, prevY = 0;
      // session indicators (VWAP, opening range) start fresh each day: no line across the overnight gap
      const daily = !!x.def.intradayOnly, tz = this.time.tzOffsetSec;
      for (let i = from; i <= to; i++) {
        const v = a[i];
        if (!Number.isFinite(v)) { pen = false; continue; }
        if (daily && i > 0 && localDayStart(this.raw[i].t, tz) !== localDayStart(this.raw[i - 1].t, tz)) pen = false;
        const px = this.x(i), py = yv(v);
        if (!pen) { c.moveTo(kind === 'step' ? px - this.spacing / 2 : px, py); pen = true; }
        else if (kind === 'step') { if (Math.abs(py - prevY) > 0.5) { c.moveTo(px - this.spacing / 2, py); } c.lineTo(px + this.spacing / 2, py); }
        else c.lineTo(px, py);
        if (kind === 'step') c.lineTo(px + this.spacing / 2, py);
        prevY = py;
      }
      c.stroke();
      c.setLineDash([]);
    }
  }

  private drawVpvr(pane: Pane, x: Ind, from: number, to: number) {
    const rows = Math.max(6, Number(x.st.inputs.rows) || 24), vaPct = (Number(x.st.inputs.va) || 70) / 100;
    let lo = Infinity, hi = -Infinity;
    for (let i = from; i <= to; i++) { lo = Math.min(lo, this.raw[i].l); hi = Math.max(hi, this.raw[i].h); }
    if (!(hi > lo)) return;
    const step = (hi - lo) / rows, up = new Array<number>(rows).fill(0), dn = new Array<number>(rows).fill(0);
    for (let i = from; i <= to; i++) {
      const b = this.raw[i];
      const r0 = Math.max(0, Math.min(rows - 1, Math.floor((b.l - lo) / step))), r1 = Math.max(0, Math.min(rows - 1, Math.floor((b.h - lo) / step)));
      const share = b.v / (r1 - r0 + 1);
      for (let r = r0; r <= r1; r++) { if (b.c >= b.o) up[r] += share; else dn[r] += share; }
    }
    const tot = up.map((u, i) => u + dn[i]);
    const max = Math.max(...tot);
    if (!max) return;
    const poc = tot.indexOf(max);
    // value area: grow from the POC towards the bigger neighbour until vaPct of the volume is in
    const all = tot.reduce((a, v) => a + v, 0);
    let a = poc, b = poc, inVa = tot[poc];
    while (inVa < all * vaPct && (a > 0 || b < rows - 1)) {
      const na = a > 0 ? tot[a - 1] : -1, nb = b < rows - 1 ? tot[b + 1] : -1;
      if (nb >= na) { b++; inVa += tot[b]; } else { a--; inVa += tot[a]; }
    }
    const c = this.c, wMax = this.plotW * 0.28, ps = x.st.plots;
    for (let r = 0; r < rows; r++) {
      const y1 = this.yOf(pane, lo + (r + 1) * step), y2 = this.yOf(pane, lo + r * step);
      const h = Math.max(1, Math.abs(y2 - y1) - 1), wu = (up[r] / max) * wMax, wd = (dn[r] / max) * wMax;
      const fade = r < a || r > b ? 0.45 : 1;
      c.globalAlpha = fade;
      c.fillStyle = ps.up?.color ?? 'rgba(29,201,149,0.35)'; c.fillRect(this.plotW - wu - wd, Math.min(y1, y2), wu, h);
      c.fillStyle = ps.down?.color ?? 'rgba(224,63,83,0.35)'; c.fillRect(this.plotW - wd, Math.min(y1, y2), wd, h);
    }
    c.globalAlpha = 1;
    if (ps.poc?.visible !== false) {
      const y = Math.round(this.yOf(pane, lo + (poc + 0.5) * step)) + 0.5;
      c.strokeStyle = ps.poc?.color ?? '#DFB15B'; c.lineWidth = 1; c.setLineDash([]);
      c.beginPath(); c.moveTo(0, y); c.lineTo(this.plotW, y); c.stroke();
    }
  }

  private drawCompare(pane: Pane, from: number, to: number) {
    const c = this.c;
    for (const s of this.compare) {
      const b0 = this.compareBase(s);
      c.strokeStyle = s.color; c.lineWidth = 2; c.setLineDash([]);
      c.beginPath();
      let pen = false;
      for (let i = from; i <= to; i++) {
        const v = this.compareAt(s, i, b0);
        if (v === undefined) continue;
        const x = this.x(i), y = this.yOf(pane, v);
        if (pen) c.lineTo(x, y); else { c.moveTo(x, y); pen = true; }
      }
      c.stroke();
    }
  }

  private activeLayers() { return [...this.layers].filter(([k]) => !this.hiddenLayers.has(k)).map(([, a]) => a); }

  private drawZones(pane: Pane) {
    const c = this.c;
    for (const a of this.activeLayers()) for (const z of a.zones ?? []) {
      const x1 = this.x(this.tIdx(z.from)) - this.spacing / 2, x2 = this.x(this.tIdx(z.to)) + this.spacing / 2;
      const y1 = this.yOf(pane, z.top), y2 = this.yOf(pane, z.bottom);
      c.fillStyle = z.color; c.fillRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));
      if (z.label) { c.fillStyle = this.theme.textMuted; c.textAlign = 'left'; c.textBaseline = 'top'; c.fillText(z.label, x1 + 4, Math.min(y1, y2) + 3); }
    }
  }

  private drawLevels(pane: Pane) {
    const c = this.c;
    for (const a of this.activeLayers()) for (const l of a.levels ?? []) {
      const y = Math.round(this.yOf(pane, l.price)) + 0.5;
      if (y < pane.top || y > pane.top + pane.h) continue;
      const x1 = l.from !== undefined ? this.x(this.tIdx(l.from)) : 0, x2 = l.to !== undefined ? this.x(this.tIdx(l.to)) : this.plotW;
      c.strokeStyle = l.color; c.lineWidth = l.width ?? 1;
      c.setLineDash(l.dash === 'solid' ? [] : l.dash === 'dotted' ? [1.5, 3] : [6, 4]);
      c.beginPath(); c.moveTo(x1, y); c.lineTo(x2, y); c.stroke();
      c.setLineDash([]);
      if (l.label) {
        c.font = this.theme.font;
        const w = c.measureText(l.label).width + 8, lx = Math.min(x2, this.plotW) - w - 4;
        c.fillStyle = this.theme.bg; c.globalAlpha = 0.85; c.fillRect(lx, y - 14, w, 13); c.globalAlpha = 1;
        c.fillStyle = l.color; c.textAlign = 'left'; c.textBaseline = 'bottom'; c.fillText(l.label, lx + 4, y - 2);
      }
    }
  }

  private markerPos(m: Marker): Pt | null {
    const pane = this.main();
    const i = Math.round(this.tIdx(m.t));
    const b = this.bars[i];
    if (!b) return null;
    const x = this.x(i);
    const gap = 10 + Math.min(6, this.spacing / 2);
    if (m.position === 'price' && m.price !== undefined) return { x, y: this.yOf(pane, m.price) };
    return m.position === 'above' ? { x, y: this.yOf(pane, b.h) - gap } : { x, y: this.yOf(pane, b.l) + gap };
  }

  private drawMarkers() {
    const c = this.c;
    for (const a of this.activeLayers()) for (const m of a.markers ?? []) {
      const p = this.markerPos(m); if (!p || p.x < -10 || p.x > this.plotW + 10) continue;
      c.fillStyle = m.color; c.strokeStyle = this.theme.bg; c.lineWidth = 1; c.setLineDash([]);
      const s = 5;
      c.beginPath();
      switch (m.shape ?? (m.position === 'above' ? 'arrowDown' : 'arrowUp')) {
        case 'arrowDown': c.moveTo(p.x - s, p.y - s); c.lineTo(p.x + s, p.y - s); c.lineTo(p.x, p.y + s); break;
        case 'arrowUp': c.moveTo(p.x - s, p.y + s); c.lineTo(p.x + s, p.y + s); c.lineTo(p.x, p.y - s); break;
        case 'square': c.rect(p.x - s, p.y - s, s * 2, s * 2); break;
        case 'diamond': c.moveTo(p.x, p.y - s - 1); c.lineTo(p.x + s + 1, p.y); c.lineTo(p.x, p.y + s + 1); c.lineTo(p.x - s - 1, p.y); break;
        default: c.arc(p.x, p.y, s, 0, Math.PI * 2);
      }
      c.closePath(); c.fill(); c.stroke();
      if (m.text) {
        c.font = this.theme.font;
        c.fillStyle = m.color; c.textAlign = 'center';
        c.textBaseline = m.position === 'above' ? 'bottom' : 'top';
        c.fillText(m.text, p.x, m.position === 'above' ? p.y - s - 2 : p.y + s + 2);
      }
    }
  }

  private drawDrawings() {
    const c = this.c;
    const list = this.creating ? [...this.drawings, this.creating] : this.drawings;
    for (const d of list) {
      const t = getTool(d.type);
      if (!t || d.hidden) continue;
      c.save();
      c.font = this.theme.font;
      try { t.render(c, this.pts(d), d, this.env(d)); } catch { /* a broken drawing never breaks the chart */ }
      c.restore();
      if (d === this.selected || d === this.creating) {
        c.setLineDash([]);
        for (const h of this.handlesOf(d)) {
          c.fillStyle = this.theme.bg; c.strokeStyle = this.theme.selection; c.lineWidth = 1.5;
          c.beginPath(); c.arc(h.x, h.y, 4.5, 0, Math.PI * 2); c.fill(); c.stroke();
        }
      }
    }
  }

  private orderBox(l: OrderLine, y: number) {
    const c = this.c;
    c.font = this.theme.font;
    const text = `${l.label}${l.qty ? `  ${l.qty}` : ''}${l.extra ? `  ${l.extra}` : ''}`;
    const w = c.measureText(text).width + 12, xw = l.cancellable ? 18 : 0, h = 18;
    const x = Math.max(4, this.plotW - w - xw - 12);
    return { x, y: y - h / 2, w, xw, h, text };
  }
  private hitOrder(x: number, y: number): { line: OrderLine; part: 'box' | 'x' | 'line' } | null {
    const m = this.main();
    for (let k = this.orders.length - 1; k >= 0; k--) {
      const l = this.orders[k];
      const py = this.yOf(m, this.orderPreview?.id === l.id ? this.orderPreview.price : l.price);
      if (py < m.top || py > m.top + m.h) continue;
      const b = this.orderBox(l, py);
      if (y >= b.y && y <= b.y + b.h) {
        if (l.cancellable && x >= b.x + b.w && x <= b.x + b.w + b.xw) return { line: l, part: 'x' };
        if (x >= b.x && x <= b.x + b.w) return { line: l, part: 'box' };
      }
      if (l.draggable && Math.abs(y - py) < 4 && x < this.plotW) return { line: l, part: 'line' };
    }
    return null;
  }
  private drawOrders(pane: Pane) {
    const c = this.c;
    for (const l of this.orders) {
      const price = this.orderPreview?.id === l.id ? this.orderPreview.price : l.price;
      const y = Math.round(this.yOf(pane, price)) + 0.5;
      if (y < pane.top || y > pane.top + pane.h) continue;
      c.strokeStyle = l.color; c.lineWidth = 1; c.setLineDash([4, 3]);
      c.beginPath(); c.moveTo(0, y); c.lineTo(this.plotW, y); c.stroke(); c.setLineDash([]);
      const b = this.orderBox(l, y);
      c.fillStyle = this.theme.bg; c.fillRect(b.x, b.y, b.w + b.xw, b.h);
      c.strokeStyle = l.color; c.strokeRect(b.x + 0.5, b.y + 0.5, b.w + b.xw - 1, b.h - 1);
      c.fillStyle = l.color; c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText(b.text, b.x + 6, y);
      if (b.xw) {
        c.fillStyle = l.color; c.fillRect(b.x + b.w, b.y, b.xw, b.h);
        c.fillStyle = '#0A1118'; c.textAlign = 'center'; c.fillText('✕', b.x + b.w + b.xw / 2, y);
      }
    }
  }
  private drawBidAsk(pane: Pane) {
    const c = this.c;
    for (const [v, col] of [[this.bidAsk.bid, '#4FA3F7'], [this.bidAsk.ask, '#F06B7C']] as const) {
      if (v === undefined || !(v > 0)) continue;
      const y = Math.round(this.yOf(pane, v)) + 0.5;
      if (y < pane.top || y > pane.top + pane.h) continue;
      c.strokeStyle = col; c.lineWidth = 1; c.setLineDash([2, 3]);
      c.beginPath(); c.moveTo(0, y); c.lineTo(this.plotW, y); c.stroke(); c.setLineDash([]);
    }
  }

  private drawLastPriceLine(pane: Pane) {
    const b = this.bars[this.bars.length - 1]; if (!b) return;
    const y = Math.round(this.yOf(pane, b.c)) + 0.5, c = this.c;
    c.strokeStyle = b.c >= b.o ? this.theme.up : this.theme.down; c.lineWidth = 1; c.setLineDash([1, 2]);
    c.beginPath(); c.moveTo(0, y); c.lineTo(this.plotW, y); c.stroke(); c.setLineDash([]);
  }

  private axisTag(y: number, text: string, bg: string, fg = '#FFFFFF', sub?: string) {
    const c = this.c, h = sub ? 30 : 17;
    c.fillStyle = bg;
    c.fillRect(this.plotW + 1, y - 8.5, AXIS_W - 1, h);
    c.fillStyle = fg; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText(text, this.plotW + 6, y);
    if (sub) c.fillText(sub, this.plotW + 6, y + 13);
  }

  private drawPriceAxes() {
    const c = this.c, th = this.theme;
    c.font = th.font;
    for (const p of this.panes) {
      c.save(); c.beginPath(); c.rect(this.plotW, p.top, AXIS_W, p.h); c.clip();
      c.fillStyle = th.textMuted; c.textAlign = 'left'; c.textBaseline = 'middle';
      for (const v of this.priceTicks(p)) {
        const y = p.top + ((p.max - v) / (p.max - p.min)) * p.h;
        if (y < p.top + 8 || y > p.top + p.h - 8) continue;
        let label: string;
        if (p.id === 'main' && this.mode() === 'percent') label = `${v.toFixed(2)}%`;
        else if (p.id === 'main' && this.mode() === 'log') label = fmtPrice(Math.exp(v), this.precision);
        else if (p.id === 'main') label = fmtPrice(v, this.precision);
        else label = fmtValue(v);
        c.fillText(label, this.plotW + 6, y);
      }
      if (p.id === 'main') {
        // levels, selected drawing, compare last values, last price, crosshair
        for (const a of this.activeLayers()) for (const l of a.levels ?? []) if (l.label !== undefined) { const y = this.yOf(p, l.price); if (y > p.top && y < p.top + p.h) this.axisTag(y, fmtPrice(l.price, this.precision), l.color, '#0A1118'); }
        if (this.selected && !this.drawingsHidden) for (const v of getTool(this.selected.type)?.axisPrices?.(this.selected) ?? []) this.axisTag(this.yOf(p, v), fmtPrice(v, this.precision), th.selection, '#0A1118');
        for (const s of this.compare) {
          const b0 = this.compareBase(s), v = this.compareAt(s, this.bars.length - 1, b0);
          if (v !== undefined) this.axisTag(this.yOf(p, v), `${(((v / this.base()) - 1) * 100).toFixed(2)}%`, s.color, '#0A1118');
        }
        // on-price indicators (VWAP, EMAs, ...): their latest value as a tag in their colour, while shown
        {
          const tags: { y: number; text: string; color: string }[] = [];
          for (const x of this.inds) {
            if (x.st.pane !== 'main' || !x.st.visible || x.def.special) continue;
            if (x.def.intradayOnly && !isIntraday(this.interval)) continue;
            for (const pl of x.def.plots) {
              const a = x.out[pl.key], ps = x.st.plots[pl.key];
              if (!a || !ps?.visible) continue;
              const v = a[this.bars.length - 1];
              if (!Number.isFinite(v)) continue;
              const y = this.yOf(p, v);
              if (y > p.top + 6 && y < p.top + p.h - 6) tags.push({ y, text: fmtPrice(v, this.precision), color: ps.color });
            }
          }
          tags.sort((a, b) => a.y - b.y);
          for (let k = 1; k < tags.length; k++) if (tags[k].y - tags[k - 1].y < 17) tags[k].y = tags[k - 1].y + 17;
          for (const t of tags) this.axisTag(t.y, t.text, t.color, inkOn(t.color));
        }
        for (const l of this.orders) { const v = this.orderPreview?.id === l.id ? this.orderPreview.price : l.price; const y = this.yOf(p, v); if (y > p.top && y < p.top + p.h) this.axisTag(y, fmtPrice(v, this.precision), l.color, '#0A1118'); }
        const b = this.bars[this.bars.length - 1];
        if (b) {
          let sub: string | undefined;
          if (isIntraday(this.interval)) {
            const left = b.t + intervalSeconds(this.interval) - Date.now() / 1000;
            const closeT = localDayStart(b.t, this.time.tzOffsetSec) + this.time.sessionCloseMin * 60;
            if (left > 0 && Date.now() / 1000 < closeT) sub = fmtCountdown(Math.min(left, closeT - Date.now() / 1000));
          }
          const label = this.mode() === 'percent' ? `${((b.c / this.base() - 1) * 100).toFixed(2)}%` : fmtPrice(b.c, this.precision);
          this.axisTag(this.yOf(p, b.c), label, b.c >= b.o ? th.up : th.down, '#FFFFFF', sub);
        }
      } else {
        // the last value of each plot (tags pushed apart so none hides another)
        const tags: { y: number; text: string; color: string }[] = [];
        for (const x of this.inds) {
          if (x.st.pane !== p.id || !x.st.visible) continue;
          for (const pl of x.def.plots) {
            const a = x.out[pl.key], ps = x.st.plots[pl.key];
            if (!a || !ps?.visible) continue;
            let v = a[this.bars.length - 1];
            if (!Number.isFinite(v)) continue;
            if (pl.kind === 'columns') v = Math.abs(v);
            tags.push({ y: p.top + ((p.max - v) / (p.max - p.min)) * p.h, text: fmtValue(v), color: ps.color });
          }
        }
        tags.sort((a, b) => a.y - b.y);
        for (let k = 1; k < tags.length; k++) if (tags[k].y - tags[k - 1].y < 17) tags[k].y = tags[k - 1].y + 17;
        for (const t of tags) this.axisTag(t.y, t.text, t.color, '#0A1118');
      }
      if (this.mouse && this.mouse.x < this.plotW && this.mouse.y >= p.top && this.mouse.y < p.top + p.h) {
        const v = p.id === 'main' ? this.vOf(p, this.mouse.y) : p.max - ((this.mouse.y - p.top) / p.h) * (p.max - p.min);
        const label = p.id === 'main' && this.mode() === 'percent' ? `${(((v / this.base()) - 1) * 100).toFixed(2)}%` : p.id === 'main' ? fmtPrice(v, this.precision) : fmtValue(v);
        this.axisTag(this.mouse.y, label, th.panelBorder, th.text);
      }
      c.restore();
    }
  }

  private drawTimeAxis(ticks: { i: number; w: number }[]) {
    const c = this.c, th = this.theme;
    c.save(); c.beginPath(); c.rect(0, this.plotH, this.plotW, TIME_H); c.clip();
    c.font = th.font; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const tk of ticks) {
      c.fillStyle = tk.w >= 3 ? th.text : th.textMuted;
      c.fillText(axisLabel(this.bars[tk.i].t, this.time.tzOffsetSec, tk.w, isIntraday(this.interval)), this.x(tk.i), this.plotH + TIME_H / 2);
    }
    const i = this.mouse && this.mouse.x < this.plotW && this.mouse.y < this.plotH ? Math.round(this.idx(this.mouse.x)) : this.extCross !== null ? Math.round(this.tIdx(this.extCross)) : null;
    if (i !== null) {
      const t = this.idxT(i), label = fmtTime(t, this.time.tzOffsetSec, isIntraday(this.interval));
      const w = c.measureText(label).width + 14, x = this.x(i);
      c.fillStyle = th.panelBorder; c.fillRect(x - w / 2, this.plotH + 1, w, TIME_H - 2);
      c.fillStyle = th.text; c.fillText(label, x, this.plotH + TIME_H / 2);
    }
    c.restore();
  }

  private drawCrosshair() {
    const c = this.c;
    let x: number | null = null, y: number | null = null;
    if (this.mouse && this.mouse.x < this.plotW && this.mouse.y < this.plotH && !this.drag) { x = this.x(Math.round(this.idx(this.mouse.x))); y = this.mouse.y; }
    else if (this.extCross !== null && !this.mouse) x = this.x(Math.round(this.tIdx(this.extCross)));
    if (x === null) return;
    c.strokeStyle = this.theme.crosshair; c.lineWidth = 1; c.setLineDash([4, 4]);
    c.beginPath(); c.moveTo(Math.round(x) + 0.5, 0); c.lineTo(Math.round(x) + 0.5, this.plotH);
    if (y !== null) { c.moveTo(0, Math.round(y) + 0.5); c.lineTo(this.plotW, Math.round(y) + 0.5); }
    c.stroke(); c.setLineDash([]);
  }

  /* ======================= legends (DOM) ======================= */

  private legendVals = new Map<string, HTMLSpanElement>();
  private ohlcEl: HTMLSpanElement | null = null;

  private renderLegendStructure() {
    const th = this.theme;
    this.legendVals.clear();
    const box = this.legendMain;
    box.innerHTML = '';
    Object.assign(box.style, { position: 'absolute', left: '8px', top: '6px', zIndex: '4', pointerEvents: 'none', color: th.text, fontSize: '12px', lineHeight: '18px', maxWidth: `calc(100% - ${AXIS_W + 20}px)` });
    const head = el('div', {}, [
      el('span', { style: 'font-weight:600;margin-right:6px' }, [`${this.symbol}`]),
      el('span', { style: `color:${th.textMuted};margin-right:8px` }, [`· ${intervalLabel(this.interval)}${this.description ? ` · ${this.description}` : ''}`]),
    ]);
    this.ohlcEl = el('span', {}) as HTMLSpanElement;
    head.appendChild(this.ohlcEl);
    box.appendChild(head);
    this.quoteEl = el('div', { style: 'display:none;gap:2px;align-items:stretch;margin:4px 0 2px;width:max-content' }) as HTMLDivElement;
    box.appendChild(this.quoteEl);
    this.renderQuote();
    for (const s of this.compare) {
      const v = el('span', { style: `color:${s.color}` }) as HTMLSpanElement;
      this.legendVals.set(`cmp:${s.id}`, v);
      box.appendChild(el('div', {}, [el('span', { style: `color:${s.color};margin-right:6px` }, [s.label]), v]));
    }
    for (const p of this.panes) p.legend?.remove();
    for (const p of this.panes) {
      const target = p.id === 'main' ? box : (p.legend = el('div', {}) as HTMLDivElement);
      if (p.id !== 'main') {
        Object.assign(p.legend!.style, { position: 'absolute', left: '8px', zIndex: '4', pointerEvents: 'none', color: th.text, fontSize: '12px', lineHeight: '18px' });
        this.root.appendChild(p.legend!);
      }
      const list = this.inds.filter((i) => i.st.pane === p.id);
      const rows: HTMLElement[] = [];
      for (const x of list) {
        const args = x.def.special === 'volume' ? (Number(x.st.inputs.ma) > 0 ? `MA ${x.st.inputs.ma}` : '') : x.def.inputs.filter((i) => i.type !== 'bool').map((i) => x.st.inputs[i.key]).join(' ');
        const row = el('div', { class: 'cc-ind', style: `display:flex;align-items:center;gap:6px;pointer-events:auto;width:max-content;border-radius:4px;padding:0 4px;margin-left:-4px;border:1px solid transparent;cursor:default` });
        const name = el('span', { style: `color:${x.st.visible ? th.text : th.textMuted}` }, [`${x.def.short}${args ? ` ${args}` : ''}`]);
        row.appendChild(name);
        const vals = el('span', {}) as HTMLSpanElement;
        this.legendVals.set(x.st.id, vals);
        row.appendChild(vals);
        const btn = (ic: string, title: string, fn: (b: HTMLElement) => void, always = false) => {
          const b = el('button', { title, style: `display:${always ? 'inline-flex' : 'none'};align-items:center;background:transparent;border:0;color:${th.text};border-radius:4px;padding:1px;cursor:pointer` }, [icon(ic)]);
          b.addEventListener('pointerdown', (e) => e.stopPropagation());
          b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
          b.addEventListener('mouseenter', () => { b.style.background = th.panelBorder; });
          b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
          return b;
        };
        const menu = (at: HTMLElement) => {
          const r = at.getBoundingClientRect(), h = this.root.getBoundingClientRect();
          popupMenu(this.root, this.theme, r.left - h.left, r.bottom - h.top + 2, [
            { label: 'Settings…', fn: () => this.openIndicatorSettings(x.st.id) },
            { label: x.st.visible ? 'Hide' : 'Show', fn: () => this.updateIndicator(x.st.id, { visible: !x.st.visible }) },
            { label: 'Duplicate', fn: () => this.duplicateIndicator(x.st.id) },
            ...(x.def.overlay ? [] : [{ label: 'Reset pane height', fn: () => { const pn = this.panes.find((q) => q.id === x.st.pane); if (pn) { pn.ratio = 1; this.emit({ type: 'stateChange' }); this.invalidate(); } } }]),
            { label: 'Remove', danger: true, fn: () => this.removeIndicator(x.st.id) },
          ]);
        };
        const tools = [
          btn(x.st.visible ? 'eye' : 'eyeOff', x.st.visible ? 'Hide' : 'Show', () => this.updateIndicator(x.st.id, { visible: !x.st.visible }), !x.st.visible),
          btn('gear', 'Settings', () => this.openIndicatorSettings(x.st.id)),
          btn('trash', 'Remove', () => this.removeIndicator(x.st.id)),
          btn('more', 'More', (b) => menu(b)),
        ];
        tools.forEach((t) => row.appendChild(t));
        row.addEventListener('mouseenter', () => { row.style.borderColor = th.panelBorder; row.style.background = `${th.panelBg}cc`; tools.forEach((t) => { t.style.display = 'inline-flex'; }); });
        row.addEventListener('mouseleave', () => { row.style.borderColor = 'transparent'; row.style.background = 'transparent'; tools.forEach((t, k) => { t.style.display = k === 0 && !x.st.visible ? 'inline-flex' : 'none'; }); });
        name.addEventListener('dblclick', () => this.openIndicatorSettings(x.st.id));
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(name); });
        if (p.id === 'main' && this.legendCollapsed) row.style.display = 'none';
        rows.push(row);
        target.appendChild(row);
      }
      // TradingView's arrow under the main legend: fold the indicator list away
      if (p.id === 'main' && list.length) {
        const fold = el('button', { title: this.legendCollapsed ? 'Show indicator legend' : 'Hide indicator legend', style: `pointer-events:auto;margin-top:2px;display:inline-flex;align-items:center;gap:4px;background:${th.panelBg};border:1px solid ${th.panelBorder};color:${th.textMuted};border-radius:4px;padding:0 4px;cursor:pointer;font-size:11px` }, [icon(this.legendCollapsed ? 'down' : 'up'), ...(this.legendCollapsed ? [`${list.length}`] : [])]);
        fold.addEventListener('pointerdown', (e) => e.stopPropagation());
        fold.addEventListener('click', (e) => { e.stopPropagation(); this.legendCollapsed = !this.legendCollapsed; this.renderLegendStructure(); this.invalidate(); });
        target.appendChild(fold);
      }
    }
  }

  duplicateIndicator(id: string) {
    const x = this.inds.find((i) => i.st.id === id);
    if (!x) return;
    const nid = newId('i');
    const st: IndicatorState = { ...JSON.parse(JSON.stringify(x.st)), id: nid, pane: x.def.overlay ? 'main' : `p_${nid}` };
    this.inds.push({ st, def: x.def, out: {} });
    this.syncPanes();
    this.recompute();
    this.emit({ type: 'stateChange' });
    this.invalidate();
  }

  private positionLegends() {
    for (const p of this.panes) if (p.legend) p.legend.style.top = `${p.top + 4}px`;
  }

  private updateLegendValues(i: number) {
    const th = this.theme;
    if (this.ohlcEl) {
      const b = this.bars[i], r = this.raw[i];
      if (!b || !r) this.ohlcEl.textContent = '';
      else {
        const prev = this.bars[i - 1]?.c ?? b.o, ch = b.c - prev, col = b.c >= b.o ? th.up : th.down;
        const f = (v: number) => fmtPrice(v, this.precision);
        this.ohlcEl.innerHTML = '';
        const part = (k: string, v: string) => { this.ohlcEl!.appendChild(el('span', { style: `color:${th.textMuted};margin-left:6px` }, [k])); this.ohlcEl!.appendChild(el('span', { style: `color:${col};margin-left:2px` }, [v])); };
        part('O', f(b.o)); part('H', f(b.h)); part('L', f(b.l)); part('C', f(b.c));
        this.ohlcEl.appendChild(el('span', { style: `color:${col};margin-left:6px` }, [`${ch >= 0 ? '+' : ''}${f(ch)} (${((ch / prev) * 100).toFixed(2)}%)`]));
      }
    }
    for (const x of this.inds) {
      const span = this.legendVals.get(x.st.id);
      if (!span) continue;
      span.innerHTML = '';
      if (!x.st.visible) continue;
      if (x.def.intradayOnly && !isIntraday(this.interval)) { span.appendChild(el('span', { style: `color:${th.textMuted}` }, ['intraday only'])); continue; }
      if (x.def.special === 'volume') {
        const r = this.raw[i];
        if (r) span.appendChild(el('span', { style: `color:${r.c >= r.o ? th.up : th.down};margin-right:6px` }, [fmtVolume(r.v)]));
        const ma = x.out.ma?.[i];
        if (Number.isFinite(ma) && x.st.plots.ma?.visible) span.appendChild(el('span', { style: `color:${x.st.plots.ma.color}` }, [fmtVolume(ma)]));
        continue;
      }
      if (x.def.special === 'vpvr') continue;
      for (const p of x.def.plots) {
        const a = x.out[p.key], ps = x.st.plots[p.key];
        if (!a || !ps?.visible) continue;
        let v = a[i];
        if (!Number.isFinite(v)) continue;
        if (p.kind === 'columns') v = Math.abs(v);
        span.appendChild(el('span', { style: `color:${ps.color};margin-right:6px` }, [fmtValue(v)]));
      }
    }
    for (const s of this.compare) {
      const span = this.legendVals.get(`cmp:${s.id}`);
      const b = this.bars[i];
      if (!span || !b) continue;
      const v = s.byT.get(b.t);
      span.textContent = v !== undefined ? fmtPrice(v, 2) : '—';
    }
  }
}

export { stroke, tag };
