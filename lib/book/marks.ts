/** His orders on the order-book chart (journal): where he got in, added, and got out. */

/** One of his orders (fills of the same order already merged). */
export interface TradeMark { t: number; price: number; side: 'BUY' | 'SELL'; qty: number; role: 'ENTRY' | 'ADD' | 'EXIT' }

const IST = 19800_000;

export interface Fill { time: string; side: string; qty: number; price: number }

/** Fills -> his orders (same side within 3 s = one order split into fills), each tagged entry / add / exit. */
export function tradeMarks(date: string, direction: string, fills: Fill[]): TradeMark[] {
  const rows = fills
    .map((f) => ({ t: Date.parse(`${date}T${f.time.trim().padStart(8, '0')}Z`) - IST, side: f.side.toUpperCase() === 'SELL' ? 'SELL' as const : 'BUY' as const, qty: f.qty, price: f.price }))
    .filter((f) => Number.isFinite(f.t) && f.qty > 0 && f.price > 0)
    .sort((a, b) => a.t - b.t);
  if (!rows.length) return [];
  const entrySide = /short/i.test(direction) ? 'SELL' : /long/i.test(direction) ? 'BUY' : rows[0].side;
  const out: TradeMark[] = [];
  let cur: { t: number; last: number; side: 'BUY' | 'SELL'; qty: number; val: number } | undefined;
  const push = () => {
    if (!cur) return;
    const isEntry = cur.side === entrySide;
    out.push({ t: cur.t, price: cur.val / cur.qty, side: cur.side, qty: cur.qty, role: isEntry ? (out.some((m) => m.role !== 'EXIT') ? 'ADD' : 'ENTRY') : 'EXIT' });
  };
  for (const f of rows) {
    if (cur && cur.side === f.side && f.t - cur.last <= 3000) { cur.qty += f.qty; cur.val += f.qty * f.price; cur.last = f.t; continue; }
    push();
    cur = { t: f.t, last: f.t, side: f.side, qty: f.qty, val: f.qty * f.price };
  }
  push();
  return out;
}

