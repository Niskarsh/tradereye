import { FEATURE_KEYS, type Label, type Moment, type Result } from './mine';
import { firstOfDay, outcomes, type Cond, type Outcomes, type TargetKey } from './analyze';

/**
 * Every possible entry of a run, saved compactly so rules written later (by Claude, or by hand) can be tested on
 * the exact same data without re-running the backtest. One file per side (long / short):
 *   setups/runs/<runId>/moments-long.bin.gz, moments-short.bin.gz
 * Layout: 4-byte header length, a JSON header (columns, symbols, dates), then one Float32 row per moment.
 * Labels: 1 = clean, 2 = messy, 3 = fail, 0 = no trade for that target. Missing facts are NaN.
 */

const PRE = ['sym', 'date', 'slot', 'entry', 'stop', 'vwap', 'open'] as const;
const RES = ['label', 'r', 'net', 'netWide', 'min', 'posInr'] as const;
export const COLS = [...PRE, ...FEATURE_KEYS.map((f) => `x.${f}`), ...RES.map((k) => `v.${k}`), ...RES.map((k) => `o.${k}`)];
const W = COLS.length;
const XI = PRE.length, VI = XI + FEATURE_KEYS.length, OI = VI + RES.length;
const LAB: Record<Label, number> = { C: 1, M: 2, F: 3 };
const LAB_BACK: Label[] = ['C', 'C', 'M', 'F'];

export interface MomentsHeader { v: 1; dir: 1 | -1; cols: string[]; symbols: string[]; dates: string[]; count: number }
export interface MomentsFile { header: MomentsHeader; data: Float32Array }

export function encodeMoments(ms: Moment[], dir: 1 | -1): Uint8Array {
  const side = ms.filter((m) => m.dir === dir);
  const symbols = [...new Set(side.map((m) => m.symbol))].sort();
  const dates = [...new Set(side.map((m) => m.date))].sort();
  const si = new Map(symbols.map((s, i) => [s, i])), di = new Map(dates.map((d, i) => [d, i]));
  const data = new Float32Array(side.length * W);
  side.forEach((m, i) => {
    const o = i * W;
    data.set([si.get(m.symbol)!, di.get(m.date)!, m.slot, m.entry, m.stop, m.vwap, m.open], o);
    for (let f = 0; f < FEATURE_KEYS.length; f++) data[o + XI + f] = m.x[f];
    const put = (at: number, r: Result | null) => {
      if (!r) { data[at] = 0; for (let k = 1; k < RES.length; k++) data[at + k] = NaN; return; }
      data.set([LAB[r.label], r.r, r.net, r.netWide, r.min, r.posInr ?? 0], at);
    };
    put(o + VI, m.v); put(o + OI, m.o);
  });
  const header: MomentsHeader = { v: 1, dir, cols: COLS, symbols, dates, count: side.length };
  const h = new TextEncoder().encode(JSON.stringify(header));
  const pad = (4 - ((4 + h.length) % 4)) % 4; // the rows start on a 4-byte boundary
  const out = new Uint8Array(4 + h.length + pad + data.byteLength);
  new DataView(out.buffer).setUint32(0, h.length + pad, true);
  out.set(h, 4);
  out.fill(32, 4 + h.length, 4 + h.length + pad); // spaces: still valid JSON padding
  out.set(new Uint8Array(data.buffer), 4 + h.length + pad);
  return out;
}

export function decodeMoments(bytes: Uint8Array): MomentsFile {
  const hl = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hl))) as MomentsHeader;
  if (header.cols.length !== W || header.cols.some((c, i) => c !== COLS[i])) throw new Error('The saved entries were made by a different version: re-run the backtest.');
  const start = 4 + hl;
  const body = bytes.slice(start, start + header.count * W * 4); // a copy, so it is 4-byte aligned
  return { header, data: new Float32Array(body.buffer, 0, header.count * W) };
}

/** One saved row back as a Moment (only for the few that a rule takes). */
export function rowToMoment(f: MomentsFile, i: number): Moment {
  const d = f.data, o = i * W;
  const res = (at: number): Result | null => (d[at] === 0 ? null : {
    label: LAB_BACK[d[at]], r: round(d[at + 1]), net: round(d[at + 2]), netWide: round(d[at + 3]), min: d[at + 4], posInr: d[at + 5],
  });
  return {
    symbol: f.header.symbols[d[o]], date: f.header.dates[d[o + 1]], slot: d[o + 2], dir: f.header.dir,
    entry: round(d[o + 3]), stop: round(d[o + 4]), vwap: round(d[o + 5]), open: round(d[o + 6]),
    x: Array.from(d.subarray(o + XI, o + VI)), v: res(o + VI), o: res(o + OI),
  };
}
const round = (x: number) => Math.round(x * 100) / 100;

/**
 * A rule on the saved entries, exactly like the study scores its own rules: on the entries where this target is a
 * trade, the first moment of each stock-day where every condition holds is the trade.
 */
export function evaluate(f: MomentsFile, conds: Cond[], t: TargetKey, mid: string): { y1: Outcomes; y2: Outcomes; all: Outcomes; y2Trades: Moment[] } {
  const d = f.data, n = f.header.count;
  const at = t === 'v' ? VI : OI;
  // facts are saved as 32-bit floats and were rounded to 0.001: compare with a tiny allowance so a value equal to the
  // threshold lands on the same side as in the study (which used full precision)
  const cs = conds.map((c) => ({ i: XI + FEATURE_KEYS.indexOf(c.f as never), ge: c.op === '>=', v: c.v - 1e-6 * Math.max(1, Math.abs(c.v)) }));
  if (cs.some((c) => c.i < XI)) throw new Error('Unknown fact in a rule.');
  const taken = new Set<number>();
  const rows: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * W;
    if (d[o + at] === 0) continue;
    const key = d[o] * 100_000 + d[o + 1];
    if (taken.has(key)) continue;
    let ok = true;
    for (const c of cs) { const x = d[o + c.i]; if (!(x === x) || (c.ge ? !(x >= c.v) : !(x < c.v))) { ok = false; break; } }
    if (!ok) continue;
    taken.add(key); rows.push(i);
  }
  const ms = rows.map((i) => rowToMoment(f, i));
  const y1 = ms.filter((m) => m.date < mid), y2 = ms.filter((m) => m.date >= mid);
  return { y1: outcomes(y1, t), y2: outcomes(y2, t), all: outcomes(ms, t), y2Trades: firstOfDay(y2) };
}

/* ---- gzip for binary files ------------------------------------------------------------------------------- */
export async function gzipBytes(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
export async function gunzipBytes(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
