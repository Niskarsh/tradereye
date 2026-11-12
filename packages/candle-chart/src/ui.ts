import type { ToolDef } from './drawings/tools';
import type { IndicatorDef } from './indicators/registry';
import { PALETTE } from './theme';
import type { Drawing, DrawingStyle, IndicatorState, Theme } from './types';

/** Tiny DOM helper: el('div', { class: 'x', style: '...' }, ['text', child]) */
export function el(tag: string, attrs: Record<string, string> = {}, children: (Node | string)[] = []): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

const btnCss = (th: Theme, on = false) => `background:${on ? th.panelBorder : 'transparent'};border:0;color:${th.text};border-radius:4px;padding:4px 7px;cursor:pointer;font-size:12px;line-height:16px`;

/** Colour picker: the palette plus a free choice. */
function colorPicker(th: Theme, value: string, onPick: (c: string) => void): HTMLElement {
  const wrap = el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;max-width:170px' });
  for (const c of PALETTE) {
    const sw = el('button', { title: c, style: `width:18px;height:18px;border-radius:4px;border:2px solid ${c === value ? th.text : 'transparent'};background:${c};cursor:pointer;padding:0` });
    sw.addEventListener('click', (e) => { e.stopPropagation(); onPick(c); });
    wrap.appendChild(sw);
  }
  const free = el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value) ? value : '#dfb15b', style: 'width:22px;height:20px;border:0;padding:0;background:none;cursor:pointer' }) as HTMLInputElement;
  free.addEventListener('input', () => onPick(free.value));
  wrap.appendChild(free);
  return wrap;
}

/** The floating bar over a selected drawing: colour, width, line style, text, lock, clone, delete. */
export class DrawingBar {
  private box: HTMLDivElement;
  private pop: HTMLDivElement | null = null;
  constructor(host: HTMLElement, private th: Theme, private on: { change: (p: Partial<DrawingStyle>) => void; remove: () => void; lock: () => void; clone: () => void }) {
    this.box = el('div', { class: 'cc-dbar' }) as HTMLDivElement;
    Object.assign(this.box.style, { position: 'absolute', top: '34px', left: '50%', transform: 'translateX(-50%)', zIndex: '7', display: 'none', gap: '2px', alignItems: 'center', background: th.panelBg, border: `1px solid ${th.panelBorder}`, borderRadius: '8px', padding: '3px', boxShadow: '0 6px 20px rgba(0,0,0,.35)' });
    this.box.addEventListener('pointerdown', (e) => e.stopPropagation());
    host.appendChild(this.box);
  }
  hide() { this.box.style.display = 'none'; this.closePop(); }
  private closePop() { this.pop?.remove(); this.pop = null; }
  private popup(anchor: HTMLElement, content: HTMLElement) {
    this.closePop();
    const p = el('div', {}, [content]) as HTMLDivElement;
    Object.assign(p.style, { position: 'absolute', top: '100%', left: `${anchor.offsetLeft}px`, marginTop: '4px', background: this.th.panelBg, border: `1px solid ${this.th.panelBorder}`, borderRadius: '8px', padding: '8px', zIndex: '8' });
    this.box.appendChild(p);
    this.pop = p;
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
    const swatch = add('', 'Colour', (x) => this.popup(x, colorPicker(th, d.style.color, (c) => { this.on.change({ color: c }); this.closePop(); this.show({ ...d, style: { ...d.style, color: c } }, def); })));
    swatch.appendChild(el('span', { style: `display:inline-block;width:14px;height:14px;border-radius:3px;background:${d.style.color};vertical-align:middle` }));
    if (d.style.fill !== undefined) {
      add('Fill', 'Fill colour', (x) => this.popup(x, colorPicker(th, d.style.fill ?? '', (c) => { const fill = `${c}26`; this.on.change({ fill }); this.closePop(); this.show({ ...d, style: { ...d.style, fill } }, def); })));
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

/** Settings of one indicator: its inputs and how each line looks. */
export class IndicatorDialog {
  private box: HTMLDivElement;
  private st: IndicatorState;
  constructor(host: HTMLElement, private th: Theme, private def: IndicatorDef, st: IndicatorState, private onApply: (st: IndicatorState) => void, private onClose: () => void) {
    this.st = JSON.parse(JSON.stringify(st));
    const scrim = el('div') as HTMLDivElement;
    Object.assign(scrim.style, { position: 'absolute', inset: '0', background: 'rgba(5,9,13,0.55)', zIndex: '20', display: 'flex', alignItems: 'center', justifyContent: 'center' });
    scrim.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.target === scrim) this.close(); });
    scrim.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.close(); });
    this.box = scrim;
    host.appendChild(scrim);
    this.draw();
  }
  close() { this.box.remove(); this.onClose(); }
  private draw() {
    const th = this.th, d = this.def, st = this.st;
    this.box.innerHTML = '';
    const card = el('div', { style: `background:${th.panelBg};border:1px solid ${th.panelBorder};border-radius:12px;min-width:300px;max-width:min(420px,92%);max-height:85%;overflow:auto;color:${th.text};font-size:12px;box-shadow:0 20px 50px rgba(0,0,0,.5)` });
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
      const sw = el('button', { title: 'Colour', style: `width:20px;height:20px;border-radius:4px;border:1px solid ${th.panelBorder};background:${ps.color};cursor:pointer;padding:0` });
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        const pick = colorPicker(th, ps.color, (c) => { ps.color = c; this.draw(); });
        const holder = el('div', { style: `grid-column:1/-1;background:${th.bg};padding:6px;border-radius:6px` }, [pick]);
        right.parentElement?.insertBefore(holder, right.nextSibling);
      });
      right.appendChild(sw);
      if (!p.kind || p.kind === 'line' || p.kind === 'step') {
        const w = el('select', { style: inputCss.replace('width:110px', 'width:64px') }) as HTMLSelectElement;
        for (const n of [1, 2, 3, 4]) { const o = el('option', { value: String(n) }, [`${n}px`]) as HTMLOptionElement; if (n === ps.width) o.selected = true; w.appendChild(o); }
        w.addEventListener('change', () => { ps.width = Number(w.value); });
        right.appendChild(w);
      }
      body.appendChild(right);
    }
    card.appendChild(body);
    const foot = el('div', { style: `display:flex;justify-content:space-between;gap:8px;padding:10px 14px;border-top:1px solid ${th.panelBorder}` });
    const reset = el('button', { style: btnCss(th) }, ['Defaults']);
    reset.addEventListener('click', () => {
      for (const i of d.inputs) st.inputs[i.key] = i.default;
      for (const p of d.plots) st.plots[p.key] = { color: p.color, width: p.width ?? 2, visible: true };
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
