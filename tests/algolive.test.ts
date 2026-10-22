import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candles } from '../lib/dhan';
import { toSessions, type Bar } from '../lib/live/enrich';
import { gridDay, ML_KEYS } from '../lib/ml/grid';
import { factsAt, padDay, dailyBefore } from '../lib/algoLive/features';
import { rankPct, predictVector, vectorOf, addRanks, type LiveModel } from '../lib/algoLive/model';
import { pick, orderFor, passes, counts, type DayState, type Scored } from '../lib/algoLive/engine';
import { seal, open } from '../lib/algoLive/scaler';
import { onTick, TICK } from '../lib/study/mine';
import { sizeFor } from '../lib/setups/costs';

const IST = 19800;
const sec = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 - IST;
function session(date: string, px: (k: number) => number, rnd = () => 0.5): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k < 375; k++) { const c = px(k), o = k ? px(k - 1) : c; out.push({ t: sec(date, '09:15') + k * 60, o, h: Math.max(o, c) + Math.round(rnd() * 3) * 0.05, l: Math.min(o, c) - Math.round(rnd() * 3) * 0.05, c, v: 500 + Math.floor(rnd() * 1500) }); }
  return out;
}
function walk(seed: number, base = 300) {
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  let p = base; const px: number[] = []; for (let k = 0; k < 375; k++) { p = Math.round((p + (rnd() - 0.5) * 0.9) * 20) / 20; px.push(p); }
  return { px, rnd };
}
const hist = (seed: number) => {
  const b: Bar[] = [];
  for (let i = 0; i < 20; i++) { const w = walk(seed * 100 + i); b.push(...session(`2025-03-${String(i + 1).padStart(2, '0')}`, (k) => w.px[k], w.rnd)); }
  return toSessions({ t: b.map((x) => x.t), o: b.map((x) => x.o), h: b.map((x) => x.h), l: b.map((x) => x.l), c: b.map((x) => x.c), v: b.map((x) => x.v) });
};
const daily = (): Candles => { const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] }; for (let i = 0; i < 700; i++) { c.t.push(sec('2023-01-02', '09:15') + i * 86400); c.o.push(300 + Math.sin(i / 9) * 4); c.h.push(305 + Math.sin(i / 9) * 4); c.l.push(296 + Math.sin(i / 9) * 4); c.c.push(301 + Math.sin(i / 7) * 4); c.v.push(6e5 + (i % 7) * 1e4); } return c; };

test('algo live: the facts at a close from the minutes so far equal the backtest\'s facts from the whole day', () => {
  for (const seed of [3, 17, 29]) {
    const date = '2025-04-07', { px, rnd } = walk(seed), H = hist(seed), d = daily();
    const day = session(date, (k) => px[k], rnd), nifty = session(date, (k) => 22000 + Math.sin(k / 13) * 30);
    const full = gridDay({ date, history: H, day, nifty, daily: d });
    assert.ok(full.length > 20);
    for (const row of full) {
      const k = row[0];
      // live: only the minutes before the close (plus a half-formed minute that must be ignored)
      const sofar = day.filter((b) => (b.t - sec(date, '09:15')) / 60 < k + 1).map((b, i, a) => (i === a.length - 1 ? { ...b, c: b.c + 7, h: b.h + 9 } : b));
      const f = factsAt({ date, history: H, today: sofar, nifty: nifty.slice(0, k + 1), daily: d }, k);
      assert.ok(f, `facts at ${k}`);
      ML_KEYS.forEach((key, i) => {
        const a = row[1 + i], b = f![key];
        assert.ok((Number.isNaN(a) && Number.isNaN(b)) || a === b, `${key} at ${k}: backtest ${a} vs live ${b}`);
      });
    }
  }
});

test('algo live: padDay keeps only the minutes before the close and fills the rest flat', () => {
  const date = '2025-04-07', { px, rnd } = walk(5);
  const p = padDay(session(date, (k) => px[k], rnd), 20);
  assert.equal(p.length, 21);
  assert.equal(p[19].c, px[19]);
  assert.equal(p[20].v, 0); assert.equal(p[20].c, px[19]);
  assert.equal((p[20].t - sec(date, '09:15')) / 60, 374);
});

test('algo live: ranks match pandas rank(pct=True) (ties averaged, missing left out)', () => {
  assert.deepEqual(rankPct([3, 1, 2]), [1, 1 / 3, 2 / 3]);
  assert.deepEqual(rankPct([5, 5, 1, NaN]), [2.5 / 3, 2.5 / 3, 1 / 3, NaN]);
  const rows = [{ a: 1 }, { a: 3 }, { a: NaN }] as Record<string, number>[];
  addRanks(rows, ['a']);
  assert.deepEqual(rows.map((r) => r.a_rk), [0.5, 1, NaN]);
});

const tiny: LiveModel = {
  v: 1, strategy: 'fCap2', month: '2025-04', createdAt: 0, train: ['2023-01', '2025-01'], val: ['2025-01', '2025-03'], features: ['x', 'y'], ranked: [],
  threshold: 0.1, standAside: false, valTrades: 100, valR: 0.1, valDays: 60,
  rules: { firstSlot: 20, lastSlot: 100, cap: 2, stopAdr: 0.5, targetAdr: 0.5, exitSlot: 360, riskInr: 300 },
  models: [
    { baseline: 0.01, trees: [{ value: [0, 0.2, -0.1], feature: [0, 0, 0], threshold: [1.5, 0, 0], missingLeft: [1, 0, 0], left: [1, 0, 0], right: [2, 0, 0], leaf: [0, 1, 1] }] },
    { baseline: 0.03, trees: [{ value: [0, 0.4, 0], feature: [1, 0, 0], threshold: [0, 0, 0], missingLeft: [0, 0, 0], left: [1, 0, 0], right: [2, 0, 0], leaf: [0, 1, 1] }] },
  ],
};

test('algo live: the trees are walked like scikit-learn (missing values follow their side)', () => {
  assert.ok(Math.abs(predictVector(tiny, vectorOf(tiny, { x: 1, y: -1 })) - ((0.01 + 0.2) + (0.03 + 0.4)) / 2) < 1e-12);
  assert.ok(Math.abs(predictVector(tiny, vectorOf(tiny, { x: 2, y: 1 })) - ((0.01 - 0.1) + 0.03) / 2) < 1e-12);
  assert.ok(Math.abs(predictVector(tiny, vectorOf(tiny, { y: NaN })) - ((0.01 + 0.2) + 0.03) / 2) < 1e-12, 'x missing -> left, y missing -> right');
});

const state = (o: Partial<DayState> = {}): DayState => ({ v: 1, date: '2025-04-07', list: [], prepared: [], vetoes: [], armed: true, ticks: {}, orders: [], log: [], ...o });
const sc = (symbol: string, pred: number, above = pred > 0.1): Scored => ({ symbol, pred, price: 300, adr: 12, above });

test('algo live: picks are the strongest that clear the bar, never a vetoed or already-tried stock, at most 2 a day', () => {
  const scored = [sc('A', 0.3), sc('B', 0.2), sc('C', 0.15), sc('D', 0.05)];
  assert.deepEqual(pick(tiny, state(), scored, 20).map((x) => x.symbol), ['A', 'B']);
  assert.deepEqual(pick(tiny, state({ vetoes: ['A'] }), scored, 20).map((x) => x.symbol), ['B', 'C']);
  assert.deepEqual(pick(tiny, state(), scored, 10), [], 'not at the 09:25 shortlist');
  assert.deepEqual(pick(tiny, state(), scored, 110), [], 'not after 10:55');
  const one = { ...orderFor(tiny, sc('A', 0.3), '2025-04-07', 20, '1'), sentAt: 0, status: 'TRADED' };
  assert.deepEqual(pick(tiny, state({ orders: [one] }), scored, 30).map((x) => x.symbol), ['B'], 'one place left');
  const rej = { ...one, status: 'REJECTED' };
  assert.equal(counts(rej), false);
  assert.deepEqual(pick(tiny, state({ orders: [rej] }), scored, 30).map((x) => x.symbol), ['B', 'C'], 'a rejected order frees its place but is not tried again');
  assert.deepEqual(pick({ ...tiny, standAside: true }, state(), scored, 20), []);
});

test('algo live: the order is the backtest\'s short: stop and target ½ the usual range from the close, ₹300 risk', () => {
  const o = orderFor(tiny, { symbol: 'M&M', pred: 0.2, price: 301.35, adr: 11.7, above: true }, '2025-04-07', 20, '2031');
  assert.equal(o.stop, onTick(301.35 + 5.85, 1));
  assert.equal(o.target, onTick(301.35 - 5.85, -1));
  assert.equal(o.qty, sizeFor(300, o.stop - (301.35 - TICK)));
  assert.ok(o.stop > 301.35 && o.target < 301.35 && o.qty > 0);
  assert.equal(o.correlationId, 'te-20250407-MM');
  assert.ok(o.correlationId.length <= 30);
  const big = orderFor(tiny, { symbol: 'M&M', pred: 0.2, price: 301.35, adr: 11.7, above: true }, '2025-04-07', 20, '2031', 900);
  assert.equal(big.qty, sizeFor(900, big.stop - (301.35 - TICK)), 'the risk set on the page sizes the order');
  assert.equal(big.stop, o.stop);
});

test('algo live: the day list uses the backtest screener (previous close ₹250-340, 10-day volume > 5 lakh)', () => {
  const d = daily();
  const date = new Date((d.t[650] + IST) * 1000).toISOString().slice(0, 10);
  const p = passes(d, date);
  assert.ok(p && p.prevClose === dailyBefore(d, date).c.at(-1));
  const thin = { ...d, v: d.v.map(() => 4e5) };
  assert.equal(passes(thin, date), undefined);
});

test('algo live: a sealed message opens only with the same secret and unchanged', () => {
  const s = seal('s3cret', { action: 'place', token: 'abc' });
  const o = open<{ action: string; token: string }>('s3cret', s);
  assert.equal(o.action, 'place'); assert.equal(o.token, 'abc'); assert.ok(o.ts > 0 && o.nonce.length === 24);
  assert.throws(() => open('other', s));
  const tampered = { ...s, data: Buffer.from(Buffer.from(s.data, 'base64').map((b, i) => (i === 3 ? b ^ 1 : b))).toString('base64') };
  assert.throws(() => open('s3cret', tampered));
});
