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
const msg = `live engine vs sklearn on ${p.rows.length} rows: worst difference ${worst} (python's own walk: ${p.worst}; ${m.models.length} models, ${m.features.length} facts)`;
console.log(msg);
// GitHub shows these as annotations on the run (the log itself may not be readable)
if (!(worst < 1e-5)) { console.log(`::error title=Live engine parity::${msg}`); process.exit(1); }
console.log(`::notice title=Live engine parity::${msg}`);
