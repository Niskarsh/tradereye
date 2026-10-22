/**
 * Algo Live: proves the live engine scores the exported model exactly as scikit-learn did (lib/algoLive/model.ts
 * against the parity rows scripts/ml_live.py wrote). Fails the workflow if they differ.
 *   npx tsx scripts/ml-live-check.ts ml-data/live-model.json
 */
import { readFileSync } from 'node:fs';
import { predictVector, type LiveModel } from '../lib/algoLive/model';

const m = JSON.parse(readFileSync(process.argv[2] ?? 'ml-data/live-model.json', 'utf8')) as LiveModel;
const p = m.parity!;
let worst = 0;
p.rows.forEach((row, i) => {
  const x = Float32Array.from(row.map((v) => (v === null ? NaN : v)));
  worst = Math.max(worst, Math.abs(predictVector(m, x) - p.pred[i]));
});
console.log(`live engine vs sklearn on ${p.rows.length} rows: worst difference ${worst}`);
if (!(worst < 1e-5)) { console.error('the live engine does not reproduce the model'); process.exit(1); }
