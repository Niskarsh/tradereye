import test from 'node:test';
import assert from 'node:assert/strict';
import { botFacts, botReady, botRef, buildBotSpec, fallbackLine, parseBotRef, spoken } from '../lib/shorts/bot';
import { toBotText } from '../lib/shorts/write';
import type { MeVsAlgoRow } from '../lib/algoLive/meVsAlgo';

/* ---------------- My bot's trade: spec ---------------- */

const t0 = Date.parse('2026-11-18T09:15:00+05:30') / 1000;
function day(n = 200) {
  const d = { t: [] as number[], o: [] as number[], h: [] as number[], l: [] as number[], c: [] as number[], v: [] as number[] };
  for (let i = 0; i < n; i++) { const p = 340 - i * 0.01; d.t.push(t0 + i * 60); d.o.push(p); d.h.push(p + 0.2); d.l.push(p - 0.2); d.c.push(p - 0.01); d.v.push(100); }
  return d;
}
const ROW = {
  date: '2026-11-18', symbol: 'FSL', time: '10:10', qty: 300, entry: 342.6, stop: 344.1, target: 339.6,
  planOutcome: 'TARGET', planExit: 339.6, planTime: '11:32', planInr: 820, planR: 1.8, myExit: 341.4, myTime: '10:48', myHow: 'MANUAL', myInr: 300, myR: 0.6,
  lastStop: 342.4, peakPct: 70, peakTime: '10:40', throughTicks: 6, fillDoubt: false, ifNoFill: null, steppedIn: true, diffInr: -520,
} as MeVsAlgoRow;

test('bot short: window from 45 min before the entry to the candle after the later exit; indexes on the right minutes', () => {
  const s = buildBotSpec(ROW, day(), '');
  const at = (i: number) => new Date((s.panel.candles[i][0] + 19800) * 1000).toISOString().slice(11, 16);
  assert.equal(at(0), '09:25');                 // 10:10 - 45 min = 09:25 (a 5-minute boundary)
  assert.equal(at(s.panel.entryIdx), '10:10');
  assert.equal(at(s.mine.idx), '10:48');
  assert.equal(at(s.plan!.idx), '11:32');
  assert.equal(at(s.panel.candles.length - 1), '11:39');  // the 11:30 candle and the one after it
  assert.equal(s.stepped, true);
  assert.equal(s.mine.inr, 300); assert.equal(s.plan!.inr, 820);
  assert.equal(s.dateLabel, '18 Nov 2026');
});

test('bot short: the untouched bracket still open -> no plan, not "stepped in"; an open trade is refused', () => {
  const s = buildBotSpec({ ...ROW, planOutcome: 'OPEN', planTime: '15:00', steppedIn: null }, day(), '');
  assert.equal(s.plan, null); assert.equal(s.stepped, false);
  assert.equal(botReady({ ...ROW, myExit: null, myInr: null }), false);
  assert.throws(() => buildBotSpec({ ...ROW, myExit: null, myInr: null }, day(), ''), /not closed/);
});

test('bot short: ref round-trips; the fallback line says the real money; facts carry every number', () => {
  assert.equal(botRef(ROW), '2026-11-18_FSL_1010');
  assert.deepEqual(parseBotRef('2026-11-18_FSL_1010'), { date: '2026-11-18', symbol: 'FSL', time: '10:10' });
  assert.equal(parseBotRef('nope'), undefined);
  const s = buildBotSpec(ROW, day(), '');
  assert.equal(fallbackLine(s), 'He touched my trade. Cost him ₹520.');
  assert.equal(fallbackLine({ ...s, stepped: false }), 'He left me alone. I made ₹300.');
  const f = botFacts(s, ROW.date);
  for (const x of ['342.6', '344.1', '339.6', '+₹300', '+₹820', 'COST']) assert.ok(f.includes(x), x);
});

test('bot voice: the line as text-to-speech reads it; no voice when switched off', () => {
  assert.equal(spoken('He touched my trade. Cost him ₹1,520.'), 'He touched my trade. Cost him 1520 rupees.');
  assert.equal(spoken('Saved ₹310. Annoying.'), 'Saved 310 rupees. Annoying.');
  const s = buildBotSpec(ROW, day(), 'He touched my trade. Cost him ₹520.');
  assert.equal(s.line, 'He touched my trade. Cost him ₹520.');
  assert.equal(s.say, 'He touched my trade. Cost him 520 rupees.');
  assert.equal(buildBotSpec(ROW, day(), 'x', false).say, '');
});

test('bot text: YouTube only, missing line falls back', () => {
  const t = toBotText({ line: '', youtube: { title: 'I touched my bot', description: 'd', tags: ['algo trading'] } }, 'fallback line');
  assert.equal(t.botLine, 'fallback line');
  assert.equal(t.instagram.caption, '');
  assert.ok(t.youtube.description.includes('not a SEBI-registered'));
});

