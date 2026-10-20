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
const lab = (ms: Moment[]) => ms.filter((m) => m.dir === 1 && m.v).map((m) => m.v!.label);

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
  assert.ok(ms.filter((m) => m.dir === 1 && m.v).every((m) => m.v!.net < 0));
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
    assert.ok(m.length < (part === 'insights' ? 250_000 : 40_000), `${part}: ${m.length} chars`);
    if (part === 'insights') { assert.ok(st.combos.every((c: { features: { label: string }[] }) => c.features.every((f) => m.includes(f.label))), 'insights carries every fact of every tab'); if (process.env.SHOW) console.log('insights chars', m.length); }
  }
  assert.ok(buildExplainMessage(st, 'tab', 1, undefined, 'why is fail so high?').includes('His question: why is fail so high?'));
  assert.throws(() => buildExplainMessage(st, 'fact', 0, 'nope'));
});

/* ---- audit: an independent replay of every trade, no look-ahead, every row adds up -------------------- */
import { roundTripCharges, sizeFor } from '../lib/setups/costs';
import { TICK } from '../lib/study/mine';

function randomDays(n: number, seed0: number) {
  let seed = seed0; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const out: { date: string; day: Bar[] }[] = [];
  for (let i = 0; i < n; i++) {
    const date = `2025-0${1 + (i % 9)}-${String(1 + (i % 27)).padStart(2, '0')}`;
    let p = 300; const day: Bar[] = [];
    for (let k = 0; k < 375; k++) {
      const o = p; p = Math.round((p + (rnd() - 0.5) * 0.7) * 20) / 20;
      day.push({ t: sec(date, '09:15') + k * 60, o, h: Math.max(o, p) + Math.round(rnd() * 3) * 0.05, l: Math.min(o, p) - Math.round(rnd() * 3) * 0.05, c: p, v: 500 + Math.floor(rnd() * 1500) });
    }
    out.push({ date, day });
  }
  return out;
}

test('audit: an independent replay from the raw candles gives the same label and R for every trade', () => {
  const H = hist('2024-12');
  let n = 0;
  for (const { date, day } of randomDays(60, 21)) {
    for (const m of mineDay({ symbol: 'X', date, history: H, day, nifty: session(date, () => 20000), daily: daily() })) {
      const k = m.slot, d = m.dir, close = day[k - 1].c;
      assert.ok(Math.abs(close - m.entry) < 0.006, 'entry = the 10-min close');
      assert.equal(k % 10, 0);
      if (m.o) assert.ok((m.open - m.entry) * d > 0, 'the open target is ahead of the entry');
      for (const [key, tgt] of [['v', m.vwap], ['o', m.open]] as const) {
        const o = m[key];
        if (!o) continue;
        n++;
        const entry = close + d * TICK;
        let stopAt = -1, tAt = -1;
        for (let s = k; s < 345; s++) {
          if (stopAt < 0 && (d === 1 ? day[s].l <= m.stop : day[s].h >= m.stop)) stopAt = s;
          if (tAt < 0 && (d === 1 ? day[s].h >= tgt + TICK : day[s].l <= tgt - TICK)) tAt = s;
        }
        const lab = tAt >= 0 && (stopAt < 0 || tAt < stopAt) ? 'C' : tAt >= 0 ? 'M' : 'F';
        const exit = lab === 'C' ? tgt : stopAt >= 0 ? m.stop - d * TICK : day[344].c - d * TICK;
        const dist = (entry - m.stop) * d, qty = sizeFor(300, dist);
        const r = ((exit - entry) * d) / dist, net = r - roundTripCharges(qty, entry, exit, d) / (qty * dist);
        assert.equal(o.label, lab, `${date} ${k} ${key}`);
        // stop / VWAP are stored rounded to the paisa: allow that much
        const tol = 0.011; // stored R is rounded to 0.01
        assert.ok(Math.abs(o.r - r) <= tol, `${key} r ${o.r} vs ${r}`);
        assert.ok(Math.abs(o.net - net) <= tol, `${key} net ${o.net} vs ${net}`);
        if (lab === 'C') assert.ok(o.r > 0, 'a clean win is a profit before charges');
        if (lab === 'M' || (lab === 'F' && stopAt >= 0)) assert.ok(o.r < -0.99, 'a stopped trade loses at least 1R');
      }
    }
  }
  assert.ok(n > 500, `${n} trades checked`);
});

test('audit: no look-ahead: changing everything after the entry never changes what was recorded at the entry', () => {
  const H = hist('2024-12');
  const [{ date, day }] = randomDays(1, 33);
  const base = mineDay({ symbol: 'X', date, history: H, day, nifty: session(date, () => 20000), daily: daily() });
  assert.ok(base.length > 3);
  for (const m of base.slice(0, 6)) {
    const changed = day.map((b, i) => (i >= m.slot ? { ...b, h: b.h + 5, l: b.l - 5, c: b.c + 3, o: b.o + 3, v: b.v * 7 } : b));
    const again = mineDay({ symbol: 'X', date, history: H, day: changed, nifty: session(date, () => 20000), daily: daily() })
      .find((x) => x.slot === m.slot && x.dir === m.dir);
    assert.ok(again, 'the same moment is still a candidate');
    assert.deepEqual(again!.x, m.x, `facts at ${m.slot} must not see the future`);
    assert.equal(again!.entry, m.entry); assert.equal(again!.stop, m.stop); assert.equal(again!.vwap, m.vwap);
  }
});

test('audit: every row adds up, and year 2 is counted on its own (not what year 1 left)', () => {
  let seed = 8; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const H = hist('2024-12');
  const ms: Moment[] = [];
  const dates: string[] = [];
  for (let t = Date.parse('2025-01-01T00:00:00Z'); dates.length < 80; t += 86400_000) { const d = new Date(t); if (d.getUTCDay() % 6) dates.push(d.toISOString().slice(0, 10)); }
  for (const sym of ['A', 'B', 'C']) for (const d of dates) {
    let p = 300; const px: number[] = []; for (let k = 0; k < 375; k++) { p += (rnd() - 0.5) * 0.8; px.push(p); }
    ms.push(...mineDay({ symbol: sym, date: d, history: H, day: session(d, (k) => px[k]), nifty: session(d, () => 20000), daily: daily() }));
  }
  const mid = dates[40];
  const st = analyze(ms, { runId: 'r', createdAt: 0, period: { from: dates[0], to: dates[79], mid } }, { minTrades: 20, maxRules: 4 });
  const sums = (o: { n: number; clean: number; messy: number; fail: number }) => { if (o.n) assert.ok(Math.abs(o.clean + o.messy + o.fail - 1) < 0.003, JSON.stringify(o)); };
  for (const c of st.combos) {
    for (const o of [c.base.y1First, c.base.y2First, c.base.allFirst, c.together.y1, c.together.y2, c.together.all]) sums(o);
    for (const r of c.rules) {
      sums(r.y1); sums(r.y2); sums(r.all);
      // year 2 = the rule on ALL of year 2, recomputed here from scratch
      const side = ms.filter((m) => m.dir === (c.dir === 'LONG' ? 1 : -1) && m[c.target === 'VWAP' ? 'v' : 'o']);
      const match = (m: Moment) => r.conds.every((x) => { const v = m.x[FEATURE_KEYS.indexOf(x.f as never)]; return Number.isFinite(v) && (x.op === '>=' ? v >= x.v : v < x.v); });
      const y2 = firstOfDay(side.filter((m) => m.date >= mid && match(m)));
      assert.equal(r.y2.n, y2.length, 'year 2 trades are every matching stock-day of year 2');
      const all = firstOfDay(side.filter(match));
      assert.equal(r.all.n, all.length);
      assert.ok(r.all.n === r.y1.n + r.y2.n, 'both years = year 1 + year 2');
    }
    for (const f of c.features) for (const b of f.bins) { sums(b.y1); sums(b.y2); }
  }
});

/* ---- saved entries: testing a rule later gives exactly the study's numbers ------------------------------- */
import { decodeMoments, encodeMoments, evaluate, gunzipBytes, gzipBytes } from '../lib/study/moments';

test('saved entries: encode / decode, and a rule tested on them matches the study to the trade', async () => {
  let seed = 4; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const H = hist('2024-12');
  const ms: Moment[] = [];
  const dates: string[] = [];
  for (let t = Date.parse('2025-01-01T00:00:00Z'); dates.length < 80; t += 86400_000) { const d = new Date(t); if (d.getUTCDay() % 6) dates.push(d.toISOString().slice(0, 10)); }
  for (const sym of ['A', 'B', 'C']) for (const d of dates) {
    let p = 300; const px: number[] = []; for (let k = 0; k < 375; k++) { p += (rnd() - 0.5) * 0.8; px.push(p); }
    ms.push(...mineDay({ symbol: sym, date: d, history: H, day: session(d, (k) => px[k]), nifty: session(d, () => 20000), daily: daily() }));
  }
  const mid = dates[40];
  const st = analyze(ms, { runId: 'r', createdAt: 0, period: { from: dates[0], to: dates[79], mid } }, { minTrades: 20, maxRules: 4 });
  for (const dir of [1, -1] as const) {
    const f = decodeMoments(await gunzipBytes(await gzipBytes(encodeMoments(ms, dir))));
    assert.equal(f.header.count, ms.filter((m) => m.dir === dir).length);
    for (const c of st.combos.filter((x) => (x.dir === 'LONG' ? 1 : -1) === dir)) {
      const t = c.target === 'VWAP' ? 'v' : 'o';
      // no conditions = the baseline
      const base = evaluate(f, [], t, mid);
      assert.equal(base.y1.n, c.base.y1First.n); assert.equal(base.y2.n, c.base.y2First.n);
      assert.ok(Math.abs(base.y2.netR - c.base.y2First.netR) <= 0.011, `${base.y2.netR} vs ${c.base.y2First.netR}`);
      for (const r of c.rules) {
        const e = evaluate(f, r.conds, t, mid);
        assert.equal(e.y1.n, r.y1.n, `${c.dir} ${c.target} ${r.text}`);
        assert.equal(e.y2.n, r.y2.n);
        assert.equal(e.all.n, r.all.n);
        for (const k of ['clean', 'messy', 'fail'] as const) assert.ok(Math.abs(e.y2[k] - r.y2[k]) < 0.002);
        assert.ok(Math.abs(e.y2.netR - r.y2.netR) <= 0.011, `${e.y2.netR} vs ${r.y2.netR}`);
      }
    }
  }
});

/* ---- Claude's rules: only year 1 goes to Claude; its rules are tested like the study's ---------------------- */
import { buildRulesMessage, cleanRules, testRules } from '../lib/study/claudeRules';

test('Claude rule maker: never sees year 2; bad rules are dropped; good ones are tested on both years', async () => {
  let seed = 6; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const H = hist('2024-12');
  const ms: Moment[] = [];
  const dates: string[] = [];
  for (let t = Date.parse('2025-01-01T00:00:00Z'); dates.length < 60; t += 86400_000) { const d = new Date(t); if (d.getUTCDay() % 6) dates.push(d.toISOString().slice(0, 10)); }
  for (const sym of ['A', 'B']) for (const d of dates) {
    let p = 300; const px: number[] = []; for (let k = 0; k < 375; k++) { p += (rnd() - 0.5) * 0.8; px.push(p); }
    ms.push(...mineDay({ symbol: sym, date: d, history: H, day: session(d, (k) => px[k]), nifty: session(d, () => 20000), daily: daily() }));
  }
  const mid = dates[30];
  const st = JSON.parse(JSON.stringify(analyze(ms, { runId: 'r', createdAt: 0, period: { from: dates[0], to: dates[59], mid } }, { minTrades: 20, maxRules: 3 })));
  // plant markers in everything that holds year 2 (or both years): none may reach Claude
  const MARK = 987654;
  const plant = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (['y2', 'y2First', 'all', 'allFirst', 'together'].includes(k) && v && typeof v === 'object') (o as Record<string, unknown>)[k] = { n: MARK, clean: MARK, messy: MARK, fail: MARK, netR: MARK, grossR: MARK, t: MARK };
      else plant(v);
    }
  };
  plant(st);
  st.combos.forEach((c: { moves: unknown; examples?: unknown }) => { c.moves = { stockDays: MARK, withClean: MARK, dropBeforeClean: {}, dropPctBeforeClean: {} }; });
  const msg = buildRulesMessage(st, { focus: 'late morning longs' });
  assert.ok(!msg.includes(String(MARK)) && !msg.includes('987,654') && !msg.includes('98765400'), 'no year-2 number in the message');
  assert.ok(msg.includes('YEAR 1') || msg.includes('year 1'));
  assert.ok(msg.includes('focus on: late morning longs'));
  for (const c of st.combos) assert.ok(msg.includes(`=== ${c.dir}_${c.target}`));

  const { rules, dropped } = cleanRules({ rules: [
    { tab: 'LONG_VWAP', name: 'ok', why: 'x', conds: [{ f: 'tWick', op: '>=', v: 0.3 }, { f: 'minute', op: '<', v: 120 }] },
    { tab: 'LONG_VWAP', name: 'dup', why: 'x', conds: [{ f: 'minute', op: '<', v: 120 }, { f: 'tWick', op: '>=', v: 0.3 }] },
    { tab: 'NOPE', name: 'badtab', why: '', conds: [{ f: 'tWick', op: '>=', v: 1 }] },
    { tab: 'SHORT_OPEN', name: 'badfact', why: '', conds: [{ f: 'madeUp', op: '>=', v: 1 }] },
  ] });
  assert.deepEqual(rules.map((r) => r.name), ['ok']);
  assert.equal(dropped.length, 3);

  const files = { 1: decodeMoments(encodeMoments(ms, 1)), [-1]: decodeMoments(encodeMoments(ms, -1)) } as Record<1 | -1, ReturnType<typeof decodeMoments>>;
  const [t] = testRules(rules, files, mid);
  const side = ms.filter((m) => m.dir === 1 && m.v);
  const want = firstOfDay(side.filter((m) => m.x[FEATURE_KEYS.indexOf('tWick')] >= 0.3 && m.x[FEATURE_KEYS.indexOf('minute')] < 120));
  assert.equal(t.all.n, want.length, 'the rule takes the first matching entry of every stock-day');
  assert.equal(t.y1.n + t.y2.n, t.all.n);
  assert.ok(t.text.includes('wick'));
});
