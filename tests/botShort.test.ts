import test from 'node:test';
import assert from 'node:assert/strict';
import { botFacts, botReady, botRef, buildBotSpec, fallbackLine, parseBotRef } from '../lib/shorts/bot';
import { checkTake, MIN_PITCH_SPREAD, pitchSpread, speechBounds, wordMatch, wordsOf } from '../lib/shorts/voice';
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
  assert.equal(fallbackLine(s), 'I touched my bot\'s trade. Cost me ₹520.');
  assert.equal(fallbackLine({ ...s, stepped: false }), 'My bot made +₹300. I didn\'t touch it.');
  const f = botFacts(s, ROW.date);
  for (const x of ['342.6', '344.1', '339.6', '+₹300', '+₹820', 'COST']) assert.ok(f.includes(x), x);
});

test('bot text: YouTube only, line capped, missing line falls back', () => {
  const t = toBotText({ line: '', context: ['a', 'b', 'c'], delivery: 'Annoyed at yourself.', youtube: { title: 'I touched my bot', description: 'd', tags: ['algo trading'] } }, 'fallback line');
  assert.equal(t.voice?.line, 'fallback line');
  assert.equal(t.voice?.context.length, 2);
  assert.equal(t.instagram.caption, '');
  assert.ok(t.youtube.description.includes('not a SEBI-registered'));
});

/* ---------------- voice checks ---------------- */

const SR = 16000;
/** a voiced sound (harmonics) at a pitch that follows `hz(t)`, between silences */
function voiced(seconds: number, hz: (t: number) => number, amp = 0.4, lead = 0.4) {
  const n = Math.round((seconds + 2 * lead) * SR), x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR - lead;
    if (t < 0 || t > seconds) continue;
    ph += (2 * Math.PI * hz(t)) / SR;
    x[i] = amp * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)) / 1.75;
  }
  return x;
}

test('voice: speech is found between the silences', () => {
  const b = speechBounds(voiced(2, () => 150), SR)!;
  assert.ok(Math.abs(b.start - 0.3) < 0.06, String(b.start));
  assert.ok(Math.abs(b.end - 2.55) < 0.06, String(b.end));
  assert.equal(speechBounds(new Float32Array(SR), SR), null);
});

test('voice: a monotone reads flat, a voice that rises and falls does not', () => {
  const flat = pitchSpread(voiced(2, () => 140), SR, 0.4, 2.4)!;
  const lively = pitchSpread(voiced(2, (t) => 140 + 70 * Math.sin(2 * Math.PI * t / 1.3)), SR, 0.4, 2.4)!;
  assert.ok(flat < 0.5, `flat ${flat}`);
  assert.ok(lively > 2, `lively ${lively}`);
});

test('voice: words match however the amount is written; the full check names what to fix', () => {
  assert.deepEqual(wordsOf("Cost me ₹420."), ['cost', 'me', '420']);
  assert.equal(wordMatch("I touched my bot's trade. Cost me ₹420.", 'i touched my bots trade cost me rupees 420'), 1);
  assert.ok(wordMatch("I touched my bot's trade. Cost me ₹420.", 'hello there') < 0.3);
  const line = "I touched my bot's trade. Cost me ₹420.";
  const good = checkTake(voiced(2.4, (t) => 140 + 70 * Math.sin(2 * Math.PI * t / 1.3)), SR, line, 'I touched my bots trade cost me 420');
  assert.equal(good.ok, true, JSON.stringify(good.checks));
  const flat = checkTake(voiced(2.4, () => 140), SR, line, 'I touched my bots trade cost me 420');
  assert.deepEqual(flat.checks.filter((c) => !c.ok).map((c) => c.key), ['flat']);
  const long = checkTake(voiced(5.5, (t) => 140 + 70 * Math.sin(t * 4)), SR, line, null);
  assert.deepEqual(long.checks.filter((c) => !c.ok).map((c) => c.key).sort(), ['length']);
  assert.ok(long.checks.find((c) => c.key === 'words')?.skipped);
  const quiet = checkTake(voiced(2.4, (t) => 140 + 70 * Math.sin(t * 4), 0.02), SR, line, null);
  assert.ok(quiet.checks.some((c) => c.key === 'loud' && !c.ok));
});

test('voice: octave jumps in the pitch track do not make a flat take look lively', () => {
  // a flat voice whose every 6th 40 ms stretch reads an octave up (the classic tracking error)
  const x = voiced(2.4, (t) => (Math.floor(t / 0.04) % 6 === 0 ? 280 : 140));
  assert.ok(pitchSpread(x, SR, 0.4, 2.8)! < MIN_PITCH_SPREAD);
});
