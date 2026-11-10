import test from 'node:test';
import assert from 'node:assert/strict';
import { exportFileName, mlToMarkdown, type ExportMl } from '../lib/ml/exportMd';

const P = (netR: number, n = 100) => ({ n, hit: 0.55, netR, gross: netR + 0.1, sumR: netR * n, t: 2.1, monthsGreen: 7, monthsTraded: 10 });
const strat = (id: string, netR: number) => ({
  id, name: `name ${id}`, desc: 'd', dev: P(netR), exam: { ...P(0.02, 40), pass: true }, overall: P(netR),
  money: { stopPct: 2.2, perTrade: 12, tradesPerMonth: 28, perMonth: 330, capital: 11000, pct: 2.9, worstMonth: -4000, bestMonth: 3900, maxDrawdownR: 19.5 },
  daily: { tradingDays: 697, daysWithTrades: 500, perTradedDay: 1.9, maxPerDay: 2, at0935: 0.78, greenDays: 0.53, worstDayR: -2.8, bestDayR: 1.9, worstWeekR: -7.9, greenWeeks: 0.58 },
  months: [{ month: '2024-01', n: 30, hit: 0.6, gross: 0.2, netR: 0.1, sumR: 3, ic: 0.08, note: '' }, { month: '2024-02', n: 0, ic: 0.05, note: 'stood aside' }],
  bySide: { long: { n: 0 }, short: P(netR) }, byHour: [{ hour: '09:00', ...P(netR) }],
  recent: [{ day: '2026-11-09', sym: 'KROSS', time: '09:45', side: 'SHORT', pred: 0.18, net: 0.93 }],
});
const ml: ExportMl = {
  iteration: 14, runId: '2026-11-10-22-00-abcd', code: 'f5cd891', createdAt: Date.UTC(2026, 10, 10, 16, 30), changes: ['one | with a pipe'],
  period: { from: '2022-01-01', to: '2026-11-09' }, examFrom: '2026-05-01', stocks: 1039, rows: 2473390,
  setup: { maxPerDay: 4, maxPerSide: 4, riskInr: 300 },
  strategies: [strat('nT10', -0.06), strat('w10_f170_c2', 0.09), strat('w10_aware_c3', 0.04)],
  untouched: [{ id: 'w10_f170_c2', overall: P(0.05, 50) }],
  noiseAll: [{ strategy: 'w10_f170_c2', devMin: 0.04, devMax: 0.08, devMean: 0.06 }],
  wide: {
    outcome: 'better', message: 'holds', checkList: [{ label: 'a', ok: true }, { label: 'b', ok: false }],
    pick: { id: 'w10_f170_c2', name: 'n' }, control: { id: 'nT10', name: 'c' }, narrowDraws: [{ shard: 'main', netR: -0.06 }], wideDraws: [{ shard: 'main', netR: 0.09 }], wideMean: 0.09,
    pools: { 17: 400, 170: 120 },
    grid: [
      { id: 'w10_f170_c2', size: 10, floor: 170, cap: 2, n: 100, netR: 0.09, t: 2.1, rPerMonth: 2.5, tradesPerMonth: 28, exam: true, pool: 120, solid: true, candidate: true },
      { id: 'w10_aware_c3', size: 10, floor: 'aware', cap: 3, n: 100, netR: 0.04, t: 1.2, rPerMonth: 1.1, tradesPerMonth: 28, exam: false, pool: 400, solid: false, candidate: false },
    ],
  },
};

test('the export has every version, in one summary table and a section each', () => {
  const md = mlToMarkdown(ml);
  assert.match(md, /^# Algo Lab iteration 14 — run 2026-11-10-22-00-abcd/);
  for (const s of ml.strategies) {
    assert.match(md, new RegExp(`^\\| ${s.id} \\| name ${s.id} \\|`, 'm'), `summary row ${s.id}`);
    assert.match(md, new RegExp(`^### ${s.id} — `, 'm'), `section ${s.id}`);
  }
  assert.match(md, /\| w10_f170_c2 \| name w10_f170_c2 \| 100 \| 28\.0 \| \+0\.09R \| \+0\.19R \| 2\.1 \| 7\/10 \| Pass \| \+0\.05R t 2\.1 \(50\) \| \+0\.04R to \+0\.08R \(\+0\.06R\) \|/);
  assert.match(md, /## Grid at ₹10 lakh positions/);
  assert.match(md, /\+0\.09R · t 2\.1 · 100 · 2\.5R\/mo · exam Pass C \*/);
  assert.match(md, /✓ a\n- ✗ b/);
  assert.match(md, /\| 2024-02 \| 0 \| – \| – \| – \| – \| 0\.050 \| stood aside \|/);
  assert.match(mlToMarkdown({ ...ml, strategies: [{ id: 'x', name: 'a | b' }] }), /^\| x \| a \/ b \|/m, 'a pipe inside a cell cannot break the table');
  assert.equal(exportFileName(ml), 'algo-lab-iteration-14-2026-11-10-22-00-abcd.md');
});

test('an older iteration without the wide fields still exports', () => {
  const md = mlToMarkdown({ iteration: 9, runId: 'r', createdAt: 0, strategies: [{ id: 'fNear', name: 'F' }] });
  assert.match(md, /\| fNear \| F \|/); assert.doesNotMatch(md, /## Verdict/);
});

test('no list is cut: every trade, fact and pattern row the page has goes in', () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ day: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, sym: `S${i}`, time: '09:35', side: 'SHORT', pred: 0.1, net: 0.5 }));
  const facts = Array.from({ length: 30 }, (_, i) => ({ label: `fact${i}`, share: 0.01 }));
  const liked = Array.from({ length: 25 }, (_, i) => ({ side: 'short', label: `like${i}`, z: 0.1, taken: 1, all: 1 }));
  const md = mlToMarkdown({ iteration: 14, runId: 'r', createdAt: 0, strategies: [{ id: 'x', name: 'x', recent: many, importance: facts, liked }] });
  assert.match(md, /\| S44 \|/); assert.match(md, /fact29/); assert.match(md, /like24/);
});

/* ---- labels at size (lib/ml/sized.ts), the five export fixes ---- */
const sizedMl = (): ExportMl => ({
  iteration: 14, runId: 'r', createdAt: 0, locked: 'w10_f17_c2',
  wide: { outcome: 'not-better', message: 'm' },
  strategies: [
    { id: 'nF', name: 'control', money: { stopPct: 2.32, perTrade: -9, tradesPerMonth: 16.6, perMonth: -151, capital: 15565, pct: -1, worstMonth: -3441, bestMonth: 2856, maxDrawdownR: 34.9 },
      costs: [{ name: 'Market orders, ₹300 risk', dev: { n: 564, netR: -0.03 } }] },
    { id: 'nT10', name: 'control at size', money: { stopPct: 2.32, maxPerDay: 2, perTrade: -18, tradesPerMonth: 14.2, perMonth: -257, capital: 15741, pct: -1.6, worstMonth: -3839, bestMonth: 2682, maxDrawdownR: 35.6 },
      costs: [{ name: 'Market orders, ₹300 risk', dev: { n: 484, netR: -0.06 } }, { name: 'Market orders, ~₹1 lakh position', dev: { n: 484, netR: 0.03 } }] },
    { id: 'w5_f1000_c2', name: 'thin pool', months: [{ month: '2026-09', n: 0, note: '', exam: true }, { month: '2026-10', n: 0, note: 'stood aside' }] },
    { id: 'placebo', name: 'Placebo (shuffled outcomes)' },
  ],
});
test('1. the first size row says the size the version is priced at', () => {
  const md = mlToMarkdown(sizedMl());
  assert.match(md, /\| As priced \(₹10 lakh positions\) \| 484 \| -0\.06R \|/);
  assert.match(md, /\| Market orders, ~₹1 lakh position \| 484 \|/);
  assert.match(md, /\| Market orders, ₹300 risk \| 564 \| -0\.03R \|/, 'nF is at ₹300 risk: unchanged');
});
test('2. money at the version\'s own size, said which', () => {
  const md = mlToMarkdown(sizedMl());
  // ₹10 lakh x 2.32% = ₹23,200 risk, k = 77.33
  assert.match(md, /Money at ₹10 lakh positions \(~₹23,200 risk a trade\): stop ~2\.32% · -₹1,392 a trade · 14\.2 trades a month · -₹19,875 a month on ₹12,25,920 \(-1\.6%\)/);
  assert.match(md, /Money at ₹300 risk: stop ~2\.32% · -₹9 a trade/, 'nF stays at ₹300');
  assert.match(md, /\| nT10 \| control at size \|.*\| -₹19,875 \(₹10 lakh positions\) \|/);
});
test('3. no "locked version" line in a wide iteration', () => {
  assert.doesNotMatch(mlToMarkdown(sizedMl()), /locked version/);
  assert.match(mlToMarkdown({ iteration: 9, runId: 'r', createdAt: 0, locked: 'fNear', strategies: [] }), /locked version: fNear/);
});
test('4. the placebo says how it is priced', () => {
  assert.match(mlToMarkdown(sizedMl()), /### placebo — Placebo, ₹300 risk, all stocks \(shuffled outcomes\)/);
});
test('5. an empty month says why', () => {
  const md = mlToMarkdown(sizedMl());
  assert.match(md, /\| 2026-09 \(exam\) \| 0 \|.*\| no trade passed the bar \|/);
  assert.match(md, /\| 2026-10 \| 0 \|.*\| stood aside \|/);
});
