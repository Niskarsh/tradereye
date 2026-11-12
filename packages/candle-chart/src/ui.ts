import type { ToolDef } from './drawings/tools';
import type { IndicatorDef } from './indicators/registry';
import { CANDLE_PRESETS, PALETTE } from './theme';
import type { CandleStyle, ChartType, Drawing, DrawingStyle, IndicatorState, Theme } from './types';

/** Tiny DOM helper: el('div', { class: 'x', style: '...' }, ['text', child]) */
export function el(tag: string, attrs: Record<string, string> = {}, children: (Node | string)[] = []): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

/** one stylesheet for the chart's floating UI: thin scrollbars in the theme's colours */
function ensureStyles(th: Theme) {
  if (typeof document === 'undefined' || document.getElementById('cc-styles')) return;
  const st = document.createElement('style');
  st.id = 'cc-styles';
  st.textContent = `.cc-scroll{scrollbar-width:thin;scrollbar-color:${th.panelBorder} transparent}
.cc-scroll::-webkit-scrollbar{width:8px;height:8px}.cc-scroll::-webkit-scrollbar-track{background:transparent}
.cc-scroll::-webkit-scrollbar-thumb{background:${th.panelBorder};border-radius:8px;border:2px solid ${th.panelBg}}
.cc-scroll::-webkit-scrollbar-thumb:hover{background:${th.textMuted}}
.cc-float select,.cc-float input[type=number]{color-scheme:dark}
.cc-float input[type=range]{accent-color:${th.accent}}`;
  document.head.appendChild(st);
}

/**
 * A popover pinned next to `anchor`, on top of everything (never clipped by a dialog's scroll box). Closes on a press
 * outside it, on Escape, or when the returned function is called. Flips above / left when there is no room.
 */
export function floatPopover(th: Theme, anchor: HTMLElement, content: HTMLElement, onClose?: () => void): () => void {
  ensureStyles(th);
  const pop = el('div', { class: 'cc-float cc-scroll' }) as HTMLDivElement;
  Object.assign(pop.style, { position: 'fixed', zIndex: '2147483001', background: th.panelBg, border: `1px solid ${th.panelBorder}`, borderRadius: '10px', padding: '8px', boxShadow: '0 12px 32px rgba(0,0,0,.5)', color: th.text, font: th.font, maxHeight: '70vh', overflow: 'auto' });
  pop.appendChild(content);
  document.body.appendChild(pop);
  const place = () => {
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    let left = r.left, top = r.bottom + 6;
    if (left + w > window.innerWidth - 8) left = Math.max(8, r.right - w);
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = `${left}px`; pop.style.top = `${top}px`;
  };
  place();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    pop.remove();
    window.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', esc, true);
    window.removeEventListener('resize', close);
    onClose?.();
  };
  const outside = (e: PointerEvent) => { if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => { if (!closed) { window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', esc, true); window.addEventListener('resize', close); } }, 0);
  return close;
}

const btnCss = (th: Theme, on = false) => `background:${on ? th.panelBorder : 'transparent'};border:0;color:${th.text};border-radius:4px;padding:4px 7px;cursor:pointer;font-size:12px;line-height:16px`;

const ICONS: Record<string, string> = {
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.9 9.9 0 0 0 5.4-1.6',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
};
/** a 14 px line icon */
export function icon(name: string): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', name === 'more' ? '3' : '1.8');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.more);
  svg.appendChild(path);
  return svg;
}

/** a small menu at (x, y) inside host; closes on any outside press */
export function popupMenu(host: HTMLElement, th: Theme, x: number, y: number, items: { label: string; fn: () => void; danger?: boolean }[]) {
  host.querySelector('.cc-menu')?.remove();
  const m = el('div', { class: 'cc-menu' }) as HTMLDivElement;
  Object.assign(m.style, { position: 'absolute', left: `${Math.max(4, x)}px`, top: `${y}px`, zIndex: '30', minWidth: '160px', background: th.panelBg, border: `1px solid ${th.panelBorder}`, borderRadius: '8px', padding: '4px', boxShadow: '0 10px 30px rgba(0,0,0,.45)', fontSize: '12px' });
  const close = () => { m.remove(); window.removeEventListener('pointerdown', outside, true); };
  const outside = (e: PointerEvent) => { if (!m.contains(e.target as Node)) close(); };
  for (const it of items) {
    const b = el('button', { style: `display:block;width:100%;text-align:left;background:transparent;border:0;border-radius:5px;padding:6px 10px;cursor:pointer;color:${it.danger ? '#F06B7C' : th.text}` }, [it.label]);
    b.addEventListener('mouseenter', () => { b.style.background = th.panelBorder; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); close(); it.fn(); });
    m.appendChild(b);
  }
  host.appendChild(m);
  setTimeout(() => window.addEventListener('pointerdown', outside, true), 0);
}

/** '#rrggbb' / 'rgba(r,g,b,a)' -> [hex, alpha 0..1] */
function splitColor(v: string): [string, number] {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/i.exec(v.trim());
  if (m) return [`#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`, m[4] === undefined ? 1 : Number(m[4])];
  if (/^#[0-9a-f]{8}$/i.test(v)) return [v.slice(0, 7), parseInt(v.slice(7), 16) / 255];
  if (/^#[0-9a-f]{6}$/i.test(v)) return [v, 1];
  return ['#dfb15b', 1];
}
function joinColor(hex: string, a: number): string {
  if (a >= 0.999) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.round(a * 100) / 100})`;
}

/** Colour picker: the palette, a free choice and opacity (TradingView's picker in small). */
export function colorPicker(th: Theme, value: string, onPick: (c: string, final: boolean) => void): HTMLElement {
  let [hex, alpha] = splitColor(value);
  const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:6px;width:176px' });
  const grid = el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px' });
  for (const c of [...PALETTE, '#FFFFFF', '#000000']) {
    const sw = el('button', { title: c, style: `width:18px;height:18px;border-radius:4px;border:2px solid ${c.toLowerCase() === hex.toLowerCase() ? th.text : th.panelBorder};background:${c};cursor:pointer;padding:0` });
    sw.addEventListener('click', (e) => { e.stopPropagation(); hex = c; onPick(joinColor(hex, alpha), true); });
    grid.appendChild(sw);
  }
  const free = el('input', { type: 'color', value: hex, title: 'Any colour', style: 'width:22px;height:20px;border:0;padding:0;background:none;cursor:pointer' }) as HTMLInputElement;
  free.addEventListener('input', () => { hex = free.value; onPick(joinColor(hex, alpha), false); });
  grid.appendChild(free);
  wrap.appendChild(grid);
  const row = el('label', { style: `display:flex;align-items:center;gap:6px;font-size:11px;color:${th.textMuted}` }, ['Opacity']);
  const op = el('input', { type: 'range', min: '0', max: '100', value: String(Math.round(alpha * 100)), style: 'flex:1' }) as HTMLInputElement;
  const pct = el('span', { style: 'width:30px;text-align:right' }, [`${Math.round(alpha * 100)}%`]);
  op.addEventListener('input', () => { alpha = Number(op.value) / 100; pct.textContent = `${op.value}%`; onPick(joinColor(hex, alpha), false); });
  row.append(op, pct);
  wrap.appendChild(row);
  return wrap;
}

/** a colour swatch button that opens the picker as a floating popover; a palette colour closes it at once */
function swatchButton(th: Theme, value: string, onPick: (c: string) => void): HTMLElement {
  const bg = (c: string) => `linear-gradient(${c},${c}),repeating-conic-gradient(#777 0 25%,#bbb 0 50%) 0 0/8px 8px`;
  const sw = el('button', { title: 'Colour', style: `width:26px;height:22px;border-radius:5px;border:1px solid ${th.panelBorder};background:${bg(value)};cursor:pointer;padding:0;flex:none` });
  let close: (() => void) | null = null;
  sw.addEventListener('click', (e) => {
    e.stopPropagation();
    if (close) { close(); return; }
    close = floatPopover(th, sw, colorPicker(th, value, (c, final) => { value = c; sw.style.background = bg(c); onPick(c); if (final) close?.(); }), () => { close = null; });
  });
  return sw;
}

/** The floating bar over a selected drawing: colour, width, line style, text, lock, clone, delete. */
export class DrawingBar {
  private box: HTMLDivElement;
  private pop: (() => void) | null = null;
  constructor(host: HTMLElement, private th: Theme, private on: { change: (p: Partial<DrawingStyle>) => void; remove: () => void; lock: () => void; clone: () => void }) {
    this.box = el('div', { class: 'cc-dbar' }) as HTMLDivElement;
    Object.assign(this.box.style, { position: 'absolute', top: '34px', left: '50%', transform: 'translateX(-50%)', zIndex: '7', display: 'none', gap: '2px', alignItems: 'center', background: th.panelBg, border: `1px solid ${th.panelBorder}`, borderRadius: '8px', padding: '3px', boxShadow: '0 6px 20px rgba(0,0,0,.35)' });
    this.box.addEventListener('pointerdown', (e) => e.stopPropagation());
    host.appendChild(this.box);
  }
  hide() { this.box.style.display = 'none'; this.closePop(); }
  private closePop() { const c = this.pop; this.pop = null; c?.(); }
  private popup(anchor: HTMLElement, content: HTMLElement) {
    this.closePop();
    this.pop = floatPopover(this.th, anchor, content, () => { this.pop = null; });
  }
  show(d: Drawing, def: ToolDef) {
    const th = this.th, b = this.box;
    b.innerHTML = '';
    b.style.display = 'flex';
    const add = (label: string, title: string, fn: (btn: HTMLElement) => void, on = false) => {
      const x = el('button', { title, style: btnCss(th, on) }, [label]);
      x.addEventListener('click', (e) => { e.stopPropagation(); fn(x); });
      b.appendChild(x);
      return x;
    };
    b.appendChild(el('span', { style: `color:${th.textMuted};font-size:11px;padding:0 6px` }, [def.label]));
    const swatch = add('', 'Colour', (x) => this.popup(x, colorPicker(th, d.style.color, (c, final) => { this.on.change({ color: c }); d = { ...d, style: { ...d.style, color: c } }; if (final) { this.closePop(); this.show(d, def); } })));
    swatch.appendChild(el('span', { style: `display:inline-block;width:14px;height:14px;border-radius:3px;background:${d.style.color};vertical-align:middle` }));
    if (d.style.fill !== undefined) {
      add('Fill', 'Fill colour', (x) => this.popup(x, colorPicker(th, d.style.fill ?? '', (c, final) => { this.on.change({ fill: c }); d = { ...d, style: { ...d.style, fill: c } }; if (final) { this.closePop(); this.show(d, def); } })));
    }
    if (!['text', 'long', 'short', 'measure'].includes(def.type)) {
      add(`${d.style.width}px`, 'Line width', (x) => {
        const list = el('div', { style: 'display:flex;flex-direction:column;gap:2px' });
        for (const w of [1, 2, 3, 4]) { const o = el('button', { style: btnCss(th, w === d.style.width) }, [`${w}px`]); o.addEventListener('click', (e) => { e.stopPropagation(); this.on.change({ width: w }); this.closePop(); this.show({ ...d, style: { ...d.style, width: w } }, def); }); list.appendChild(o); }
        this.popup(x, list);
      });
      add(d.style.dash === 'solid' ? '—' : d.style.dash === 'dashed' ? '- -' : '···', 'Line style', () => {
        const next = d.style.dash === 'solid' ? 'dashed' : d.style.dash === 'dashed' ? 'dotted' : 'solid';
        this.on.change({ dash: next }); this.show({ ...d, style: { ...d.style, dash: next } }, def);
      });
    }
    if (['trend', 'ray', 'extended', 'arrow', 'fib'].includes(def.type)) {
      add('⟷', 'Extend right', () => { const v = !d.style.extendRight; this.on.change({ extendRight: v }); this.show({ ...d, style: { ...d.style, extendRight: v } }, def); }, !!d.style.extendRight);
    }
    if (['text', 'hline', 'trend', 'rect', 'ray', 'extended', 'arrow'].includes(def.type)) {
      add('T', 'Text', () => { const t = prompt('Text', d.style.text ?? ''); if (t !== null) { this.on.change({ text: t }); this.show({ ...d, style: { ...d.style, text: t } }, def); } });
    }
    if (def.type === 'text') {
      add(`${d.style.fontSize ?? 14}`, 'Font size', () => { const n = [12, 14, 18, 24, 32]; const i = (n.indexOf(d.style.fontSize ?? 14) + 1) % n.length; this.on.change({ fontSize: n[i] }); this.show({ ...d, style: { ...d.style, fontSize: n[i] } }, def); });
    }
    add(d.locked ? 'Unlock' : 'Lock', 'Lock (stops moving by mistake)', () => this.on.lock(), !!d.locked);
    add('Clone', 'Clone', () => this.on.clone());
    add('Delete', 'Delete (Del)', () => this.on.remove());
  }
}

/** the dimmed full-window backdrop a dialog sits on (in document.body: never cut by the chart's box) */
function dialogScrim(th: Theme, close: () => void): HTMLDivElement {
  ensureStyles(th);
  const scrim = el('div', { class: 'cc-scrim' }) as HTMLDivElement;
  Object.assign(scrim.style, { position: 'fixed', inset: '0', background: 'rgba(5,9,13,0.6)', zIndex: '2147483000', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px' });
  scrim.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.target === scrim) close(); });
  document.body.appendChild(scrim);
  return scrim;
}

/** Settings of one indicator: its inputs and how each line looks. */
export class IndicatorDialog {
  private box: HTMLDivElement;
  private st: IndicatorState;
  constructor(host: HTMLElement, private th: Theme, private def: IndicatorDef, st: IndicatorState, private onApply: (st: IndicatorState) => void, private onClose: () => void) {
    this.st = JSON.parse(JSON.stringify(st));
    this.box = dialogScrim(th, () => this.close());
    void host;
    this.draw();
  }
  close() { this.box.remove(); window.removeEventListener('keydown', this.esc, true); this.onClose(); }
  private esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.cc-float')) { e.stopPropagation(); this.close(); } };
  private draw() {
    window.removeEventListener('keydown', this.esc, true);
    window.addEventListener('keydown', this.esc, true);
    const th = this.th, d = this.def, st = this.st;
    this.box.innerHTML = '';
    const card = el('div', { style: `background:${th.panelBg};border:1px solid ${th.panelBorder};border-radius:12px;width:min(440px,94vw);max-height:calc(100dvh - 24px);overflow:auto;color:${th.text};font:${th.font};font-size:12.5px;box-shadow:0 20px 50px rgba(0,0,0,.5)`, class: 'cc-scroll cc-float-dialog' });
    card.appendChild(el('div', { style: `padding:12px 14px;border-bottom:1px solid ${th.panelBorder};font-weight:600;font-size:13px` }, [d.name]));
    const body = el('div', { style: 'padding:10px 14px;display:grid;grid-template-columns:1fr auto;gap:8px 12px;align-items:center' });
    const inputCss = `background:${th.bg};border:1px solid ${th.panelBorder};color:${th.text};border-radius:6px;padding:4px 6px;width:110px`;
    if (d.inputs.length) body.appendChild(el('div', { style: `grid-column:1/-1;color:${th.textMuted};font-size:11px;text-transform:uppercase;letter-spacing:.06em` }, ['Inputs']));
    for (const i of d.inputs) {
      body.appendChild(el('label', {}, [i.label]));
      let input: HTMLInputElement | HTMLSelectElement;
      if (i.type === 'source' || i.type === 'select') {
        input = el('select', { style: inputCss }) as HTMLSelectElement;
        for (const o of i.options ?? []) { const op = el('option', { value: o }, [o]) as HTMLOptionElement; if (String(st.inputs[i.key]) === o) op.selected = true; input.appendChild(op); }
        input.addEventListener('change', () => { st.inputs[i.key] = (input as HTMLSelectElement).value; });
      } else if (i.type === 'bool') {
        input = el('input', { type: 'checkbox' }) as HTMLInputElement;
        (input as HTMLInputElement).checked = !!st.inputs[i.key];
        input.addEventListener('change', () => { st.inputs[i.key] = (input as HTMLInputElement).checked; });
      } else {
        input = el('input', { type: 'number', value: String(st.inputs[i.key]), step: String(i.step ?? (i.type === 'int' ? 1 : 0.1)), ...(i.min !== undefined ? { min: String(i.min) } : {}), ...(i.max !== undefined ? { max: String(i.max) } : {}), style: inputCss }) as HTMLInputElement;
        input.addEventListener('change', () => {
          let v = Number((input as HTMLInputElement).value);
          if (!Number.isFinite(v)) v = Number(i.default);
          if (i.type === 'int') v = Math.round(v);
          if (i.min !== undefined) v = Math.max(i.min, v);
          if (i.max !== undefined) v = Math.min(i.max, v);
          st.inputs[i.key] = v;
        });
      }
      body.appendChild(input);
    }
    body.appendChild(el('div', { style: `grid-column:1/-1;color:${th.textMuted};font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-top:6px` }, ['Style']));
    for (const p of d.plots) {
      const ps = st.plots[p.key];
      if (!ps) continue;
      const row = el('div', { style: 'display:flex;align-items:center;gap:6px' });
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = ps.visible;
      cb.addEventListener('change', () => { ps.visible = cb.checked; });
      row.appendChild(cb);
      row.appendChild(el('span', {}, [p.label]));
      body.appendChild(row);
      const right = el('div', { style: 'display:flex;align-items:center;gap:6px' });
      right.appendChild(swatchButton(th, ps.color, (c) => { ps.color = c; }));
      if (!p.kind || p.kind === 'line' || p.kind === 'step') {
        const w = el('select', { style: inputCss.replace('width:110px', 'width:58px') }) as HTMLSelectElement;
        for (const n of [1, 2, 3, 4]) { const o = el('option', { value: String(n) }, [`${n}px`]) as HTMLOptionElement; if (n === ps.width) o.selected = true; w.appendChild(o); }
        w.addEventListener('change', () => { ps.width = Number(w.value); });
        right.appendChild(w);
        const ds = el('select', { style: inputCss.replace('width:110px', 'width:70px') }) as HTMLSelectElement;
        for (const [v, l] of [['solid', '———'], ['dashed', '- - -'], ['dotted', '·····']]) { const o = el('option', { value: v }, [l]) as HTMLOptionElement; if ((ps.dash ?? 'solid') === v) o.selected = true; ds.appendChild(o); }
        ds.addEventListener('change', () => { ps.dash = ds.value as 'solid' | 'dashed' | 'dotted'; });
        right.appendChild(ds);
      }
      body.appendChild(right);
    }
    card.appendChild(body);
    const foot = el('div', { style: `display:flex;justify-content:space-between;gap:8px;padding:10px 14px;border-top:1px solid ${th.panelBorder}` });
    const reset = el('button', { style: btnCss(th) }, ['Defaults']);
    reset.addEventListener('click', () => {
      for (const i of d.inputs) st.inputs[i.key] = i.default;
      for (const p of d.plots) st.plots[p.key] = { color: p.color, width: p.width ?? 2, visible: true, dash: 'solid' };
      this.draw();
    });
    const right = el('div', { style: 'display:flex;gap:8px' });
    const cancel = el('button', { style: btnCss(th) }, ['Cancel']);
    cancel.addEventListener('click', () => this.close());
    const ok = el('button', { style: `${btnCss(th)};background:${th.accent};color:#0A1118;font-weight:600;padding:5px 14px` }, ['OK']);
    ok.addEventListener('click', () => { this.onApply(st); this.close(); });
    right.append(cancel, ok);
    foot.append(reset, right);
    card.appendChild(foot);
    this.box.appendChild(card);
  }
}

export interface ChartSettings { type: ChartType; candles: CandleStyle; grid: boolean; sessionBreaks: boolean }
const TYPES: [ChartType, string][] = [['candles', 'Candles'], ['volume', 'Volume candles'], ['hollow', 'Hollow candles'], ['heikin', 'Heikin Ashi'], ['bars', 'Bars'], ['line', 'Line'], ['area', 'Area']];

/** Chart settings (TradingView's "Symbol" tab in small): candle bodies, outlines and wicks, grid, session breaks. */
export class ChartSettingsDialog {
  private box: HTMLDivElement;
  private v: ChartSettings;
  private all = true;
  constructor(host: HTMLElement, private th: Theme, v: ChartSettings, private allOption: boolean, private onApply: (v: ChartSettings, all: boolean) => void, private onClose: () => void) {
    this.v = JSON.parse(JSON.stringify(v));
    this.box = dialogScrim(th, () => this.close());
    void host;
    this.draw();
  }
  close() { this.box.remove(); window.removeEventListener('keydown', this.esc, true); this.onClose(); }
  private esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.cc-float')) { e.stopPropagation(); this.close(); } };
  private draw() {
    window.removeEventListener('keydown', this.esc, true);
    window.addEventListener('keydown', this.esc, true);
    const th = this.th, v = this.v;
    this.box.innerHTML = '';
    const card = el('div', { style: `background:${th.panelBg};border:1px solid ${th.panelBorder};border-radius:12px;width:min(380px,94vw);max-height:calc(100dvh - 24px);overflow:auto;color:${th.text};font:${th.font};font-size:12.5px;box-shadow:0 20px 50px rgba(0,0,0,.5)`, class: 'cc-scroll cc-float-dialog' });
    card.appendChild(el('div', { style: `padding:12px 14px;border-bottom:1px solid ${th.panelBorder};font-weight:600;font-size:13px` }, ['Chart settings']));
    const body = el('div', { style: 'padding:10px 14px;display:grid;grid-template-columns:1fr auto auto;gap:8px 12px;align-items:center' });
    const head = (t: string) => body.appendChild(el('div', { style: `grid-column:1/-1;color:${th.textMuted};font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-top:4px` }, [t]));
    head('Chart type');
    const types = el('div', { style: 'grid-column:1/-1;display:flex;gap:6px;flex-wrap:wrap' });
    for (const [t, label] of TYPES) {
      const b = el('button', { style: `background:${v.type === t ? th.panelBorder : th.bg};border:1px solid ${v.type === t ? th.accent : th.panelBorder};color:${th.text};border-radius:6px;padding:4px 8px;cursor:pointer` }, [label]);
      b.addEventListener('click', () => { v.type = t; this.draw(); });
      types.appendChild(b);
    }
    body.appendChild(types);
    head('Candle colours');
    const presets = el('div', { style: 'grid-column:1/-1;display:flex;gap:6px;flex-wrap:wrap' });
    for (const p of CANDLE_PRESETS) {
      const b = el('button', { style: `background:${th.bg};border:1px solid ${th.panelBorder};color:${th.text};border-radius:6px;padding:4px 8px;cursor:pointer` }, [p.label]);
      b.addEventListener('click', () => { v.candles = p.style(th); this.draw(); });
      presets.appendChild(b);
    }
    body.appendChild(presets);
    body.append(el('span', { style: `color:${th.textMuted};font-size:11px` }, ['']), el('span', { style: `color:${th.textMuted};font-size:11px` }, ['Up']), el('span', { style: `color:${th.textMuted};font-size:11px` }, ['Down']));
    const pair = (label: string, up: keyof CandleStyle, down: keyof CandleStyle, extra?: HTMLElement) => {
      const l = el('label', { style: 'display:flex;align-items:center;gap:6px' });
      if (extra) l.appendChild(extra);
      l.appendChild(document.createTextNode(label));
      body.append(l, swatchButton(th, String(v.candles[up]), (c) => { (v.candles[up] as string) = c; }), swatchButton(th, String(v.candles[down]), (c) => { (v.candles[down] as string) = c; }));
    };
    pair('Body', 'upBody', 'downBody');
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = v.candles.border;
    cb.addEventListener('change', () => { v.candles.border = cb.checked; });
    pair('Borders', 'upBorder', 'downBorder', cb);
    pair('Wicks', 'upWick', 'downWick');
    head('Canvas');
    const check = (label: string, get: () => boolean, set: (b: boolean) => void) => {
      const c = el('input', { type: 'checkbox' }) as HTMLInputElement;
      c.checked = get();
      c.addEventListener('change', () => set(c.checked));
      body.appendChild(el('label', { style: 'grid-column:1/-1;display:flex;align-items:center;gap:6px' }, [c, label]));
    };
    check('Grid lines', () => v.grid, (b) => { v.grid = b; });
    check('Session breaks (a line between days)', () => v.sessionBreaks, (b) => { v.sessionBreaks = b; });
    if (this.allOption) check('Apply to every chart in the layout', () => this.all, (b) => { this.all = b; });
    card.appendChild(body);
    const foot = el('div', { style: `display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid ${th.panelBorder}` });
    const cancel = el('button', { style: btnCss(th) }, ['Cancel']);
    cancel.addEventListener('click', () => this.close());
    const ok = el('button', { style: `${btnCss(th)};background:${th.accent};color:#0A1118;font-weight:600;padding:5px 14px` }, ['OK']);
    ok.addEventListener('click', () => { this.onApply(this.v, this.allOption && this.all); this.close(); });
    foot.append(cancel, ok);
    card.appendChild(foot);
    this.box.appendChild(card);
  }
}
