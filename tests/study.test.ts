import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candles } from '../lib/dhan';
import { toSessions, type Bar } from '../lib/live/enrich';
import { FEATURE_KEYS, mineDay, type Moment } from '../lib/study/mine';
import { analyze, firstOfDay, outcomes } from '../lib/study/analyze';

const IST = 19800;
const sec = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 - IST;
function session(date: string, px: (k: number) => number, vol: (k: number) => number = () => 1000): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k < 375; k++) { const c = px(k), o = k ? px(k - 1) : c; out.push({ t: sec(date, '09:15') + k * 60, o, h: Math.max(o, c) + 0.05, l: Math.min(o, c) - 0.05, c, v: vol(k) }); }
  return out;
}
const toCandles = (bars: Bar[]): Candles => ({ t: bars.map((b) => b.t), o: bars.map((b) => b.o), h: bars.map((b) => b.h), l: bars.map((b) => b.l), c: bars.map((b) => b.c), v: bars.map((b) => b.v) });
const hist = (ym = '2026-09') => { const b: Bar[] = []; for (let i = 0; i < 20; i++) b.push(...session(`${ym}-${String(i + 1).padStart(2, '0')}`, (k) => 300 + Math.sin(k / 6) * 0.6)); return toSessions(toCandles(b)); };
const daily = (): Candles => { const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] }; for (let i = 0; i < 700; i++) { c.t.push(i); c.o.push(300); c.h.push(303); c.l.push(297); c.c.push(300); c.v.push(4e6); } return c; };
const DATE = '2026-10-01';
const nifty = session(DATE, () => 20000);
const lab = (ms: Moment[]) => ms.filter((m) => m.dir === 1).map((m) => m.v.label);

test('a clean reversal: down 4 rupees by 10:45, straight back above VWAP', () => {
  const day = session(DATE, (k) => (k < 90 ? 300 - k * (4 / 90) : 296 + (k - 90) * 0.03));
  const ms = mineDay({ symbol: 'T', date: DATE, history: hist(), day, nifty, daily: daily() });
  const longs = ms.filter((m) => m.dir === 1);
  assert.ok(longs.length > 0, 'candidates near the low');
  assert.ok(longs.every((m) => m.slot % 10 === 0 && m.entry < m.vwap));
  assert.ok(lab(ms).includes('C'), `a clean win expected: ${lab(ms).join('')}`);
  const runAdr = longs[0].x[FEATURE_KEYS.indexOf('runAdr')];
  assert.ok(runAdr > 0.2, `drop ${runAdr}`);
});

test('a messy reversal: bounces, makes a lower low (the stop goes), then reaches VWAP', () => {
  const px = (k: number) => (k < 60 ? 300 - k * 0.05 : k < 80 ? 297 + (k - 60) * 0.02 : k < 110 ? 297.4 - (k - 80) * 0.05 : 295.9 + (k - 110) * 0.04);
  const ms = mineDay({ symbol: 'T', date: DATE, history: hist(), day: session(DATE, px), nifty, daily: daily() });
  assert.ok(lab(ms).includes('M'), `a messy win expected: ${lab(ms).join('')}`);
});

test('a failed reversal: keeps falling into the close', () => {
  const ms = mineDay({ symbol: 'T', date: DATE, history: hist(), day: session(DATE, (k) => 300 - k * 0.02), nifty, daily: daily() });
  const l = lab(ms);
  assert.ok(l.length > 0 && l.every((x) => x === 'F'), l.join(''));
  assert.ok(ms.filter((m) => m.dir === 1).every((m) => m.v.net < 0));
});

test('the study: failures stay in, rules are searched on year 1 and judged on year 2', () => {
  // random walks: there is no edge, so the rules may look good on year 1 but year 2 must show it
  let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const g = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) * 1.4; };
  const moments: Moment[] = [];
  const H = hist('2024-12');
  const dates: string[] = [];
  for (let t = Date.parse('2025-01-01T00:00:00Z'); dates.length < 120; t += 86400_000) { const d = new Date(t); if (d.getUTCDay() % 6) dates.push(d.toISOString().slice(0, 10)); }
  for (const sym of ['A', 'B', 'C', 'D']) for (const d of dates) {
    let p = 300;
    const px: number[] = []; for (let k = 0; k < 375; k++) { p += g() * 0.25 + (300 - p) * 0.002; px.push(p); }
    moments.push(...mineDay({ symbol: sym, date: d, history: H, day: session(d, (k) => px[k], () => 800 + rnd() * 600), nifty: session(d, (k) => 20000 + Math.sin(k / 30 + rnd()) * 20), daily: daily() }));
  }
  assert.ok(moments.length > 500, `moments ${moments.length}`);
  const all = outcomes(firstOfDay(moments.filter((m) => m.dir === 1)), 'v');
  assert.ok(all.clean + all.messy + all.fail > 0.99, 'every moment is clean, messy or a failure');
  const t0 = Date.now();
  const st = analyze(moments, { runId: 't', createdAt: 0, period: { from: dates[0], to: dates.at(-1)!, mid: dates[60] } }, { minTrades: 40, maxRules: 4 });
  if (process.env.SHOW) for (const c of st.combos) { console.log(c.dir, c.target, 'moments', c.base.y1.n, 'base y1', c.base.y1First.netR, 'y2', c.base.y2First.netR, 'drop p50', c.moves.dropBeforeClean.p50); for (const r of c.rules) console.log('  ', r.y1.n, r.y1.netR, '->', r.y2.n, r.y2.netR, r.text.slice(0, 90)); }
  assert.equal(st.combos.length, 4);
  const c = st.combos[0];
  assert.ok(c.features.length > 20);
  assert.ok(c.drop.length > 3);
  assert.ok(c.features[0].bins.every((b) => b.y1.n >= 0 && b.y2.n >= 0));
  for (const r of c.rules) { assert.ok(r.conds.length >= 1 && r.conds.length <= 4); assert.ok(r.y1.n >= 40); }
  assert.ok(Date.now() - t0 < 60_000, 'fast enough');
});

/* ---- "Explain this": the message sent to Claude --------------------------------------------------------- */
import { buildExplainMessage, EXPLAIN_PARTS } from '../lib/study/explain';

test('explain: every part builds a plain-text message from a saved study, small enough to send', () => {
  let seed = 5; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const H = hist('2024-12');
  const ms: Moment[] = [];
  const dates: string[] = [];
  for (let t = Date.parse('2025-01-01T00:00:00Z'); dates.length < 60; t += 86400_000) { const d = new Date(t); if (d.getUTCDay() % 6) dates.push(d.toISOString().slice(0, 10)); }
  for (const sym of ['A', 'B', 'C']) for (const d of dates) {
    let p = 300; const px: number[] = []; for (let k = 0; k < 375; k++) { p += (rnd() - 0.5) * 0.8; px.push(p); }
    ms.push(...mineDay({ symbol: sym, date: d, history: H, day: session(d, (k) => px[k]), nifty: session(d, () => 20000), daily: daily() }));
  }
  // saved and read back: Infinity / NaN become null, exactly like the real page gets it
  const st = JSON.parse(JSON.stringify(analyze(ms, { runId: 'r', createdAt: 0, period: { from: dates[0], to: dates[59], mid: dates[30] } }, { minTrades: 20, maxRules: 3 })));
  for (const part of EXPLAIN_PARTS) {
    const item = part === 'rule' ? 0 : part === 'fact' ? st.combos[0].features[0].f : undefined;
    if (part === 'rule' && !st.combos[0].rules.length) continue;
    const m = buildExplainMessage(st, part, 0, item);
    assert.ok(m.includes('Key to the terms'), part);
    assert.ok(m.includes('Year 2') || m.includes('year 2'), part);
    assert.ok(!/NaN|undefined|Infinity|null/.test(m), `${part}: no broken numbers`);
    assert.ok(m.length < 40_000, `${part}: ${m.length} chars`);
  }
  assert.ok(buildExplainMessage(st, 'tab', 1, undefined, 'why is fail so high?').includes('His question: why is fail so high?'));
  assert.throws(() => buildExplainMessage(st, 'fact', 0, 'nope'));
});
