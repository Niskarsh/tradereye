import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ML_COLS, ML_FEATURES, ML_LABELS, ML_WIDTH, STOP_ATR, TARGET_ATR } from './grid';

/**
 * Writes the Algo Lab dataset to disk during the GitHub job (never to S3: it is only read by the Python step that
 * runs right after it). grid.bin = Float32 rows [sym, date, slot, ...facts, ...labels]; grid.json = the header.
 */
export class GridWriter {
  private buf = new Float32Array(20_000 * ML_WIDTH);
  private n = 0;
  rows = 0;
  private symbols = new Map<string, number>();
  private dates = new Map<string, number>();
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'grid.bin'), new Uint8Array(0)); }

  add(symbol: string, date: string, dayRows: number[][]) {
    if (!dayRows.length) return;
    if (!this.symbols.has(symbol)) this.symbols.set(symbol, this.symbols.size);
    if (!this.dates.has(date)) this.dates.set(date, this.dates.size);
    const s = this.symbols.get(symbol)!, d = this.dates.get(date)!;
    for (const r of dayRows) {
      if (this.n === 20_000) this.flush();
      const o = this.n * ML_WIDTH;
      this.buf[o] = s; this.buf[o + 1] = d;
      for (let i = 0; i < r.length; i++) this.buf[o + 2 + i] = r[i];
      this.n++; this.rows++;
    }
  }
  private flush() {
    if (!this.n) return;
    appendFileSync(join(this.dir, 'grid.bin'), new Uint8Array(this.buf.buffer, 0, this.n * ML_WIDTH * 4));
    this.n = 0;
  }
  close(meta: { runId: string; from: string; to: string; mid: string; riskInr: number }) {
    this.flush();
    writeFileSync(join(this.dir, 'grid.json'), JSON.stringify({
      v: 1, ...meta, cols: ML_COLS, labels: ML_LABELS, features: ML_FEATURES.map(([k, l]) => ({ k, l })), width: ML_WIDTH, rows: this.rows,
      symbols: [...this.symbols.keys()], dates: [...this.dates.keys()], stopAtr: STOP_ATR, targetAtr: TARGET_ATR,
    }));
  }
}
